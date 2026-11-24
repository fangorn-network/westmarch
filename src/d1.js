// The index on Cloudflare D1 (async SQLite): the stitcher's store and lens, the view, and search by meaning.
// Same shape as sqlite.js, with one difference: the lens writes records WITHOUT vectors, and `embedMissing`
// fills them in afterwards, a bounded number per run. So a run never exceeds the encoder's budget, a failed
// embed costs nothing but a retry, and rows seeded from elsewhere get vectors from this runtime only.

import { textOf } from "./embed.js";
import { lexicalTerms, fuseRanks } from "./ranking.js";
import { gateFor } from "./validate.js";

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS records (
    publisher TEXT NOT NULL, repo TEXT NOT NULL, id TEXT NOT NULL,
    cid TEXT NOT NULL, type TEXT, payload TEXT NOT NULL, text TEXT NOT NULL, vec TEXT,
    PRIMARY KEY (publisher, repo, id));
CREATE TABLE IF NOT EXISTS verdicts (
    publisher TEXT NOT NULL, repo TEXT NOT NULL, id TEXT NOT NULL,
    cid TEXT NOT NULL, checker TEXT NOT NULL, reason TEXT,
    PRIMARY KEY (publisher, repo, id));
CREATE VIRTUAL TABLE IF NOT EXISTS record_fts USING fts5(text);
CREATE TRIGGER IF NOT EXISTS record_fts_ai AFTER INSERT ON records BEGIN
    INSERT INTO record_fts(rowid, text) VALUES (new.rowid, coalesce(new.payload ->> '$.text', new.text)); END;
CREATE TRIGGER IF NOT EXISTS record_fts_ad AFTER DELETE ON records BEGIN
    DELETE FROM record_fts WHERE rowid = old.rowid; END;
CREATE TRIGGER IF NOT EXISTS record_fts_au AFTER UPDATE OF text, payload ON records BEGIN
    DELETE FROM record_fts WHERE rowid = old.rowid;
    INSERT INTO record_fts(rowid, text) VALUES (new.rowid, coalesce(new.payload ->> '$.text', new.text)); END;
INSERT INTO record_fts(rowid, text)
    SELECT rowid, coalesce(payload ->> '$.text', text) FROM records
    WHERE NOT EXISTS (SELECT 1 FROM meta WHERE k = 'record_fts_v1')
      AND NOT EXISTS (SELECT 1 FROM record_fts WHERE record_fts.rowid = records.rowid);
INSERT OR IGNORE INTO meta(k, v) VALUES ('record_fts_v1', 'true');`;

const json = (v) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));
const cosine = (q, v) => { let d = 0, a = 0, b = 0; for (let i = 0; i < q.length; i++) { d += q[i] * v[i]; a += q[i] * q[i]; b += v[i] * v[i]; } return a && b ? d / Math.sqrt(a * b) : 0; };
// A vector is stored as 256 int8s (a BLOB: 256 bytes, ~20x smaller than JSON, nothing to parse). The column is declared
// TEXT, which SQLite lets hold a BLOB as is; rows written before this hold JSON text until packVectors rewrites them.
// ponytail: int8 at scale 127 on L2-normalized vectors; ranking barely moves. Go float32 (1 KB/row) if recall ever suffers
const pack = (v) => Int8Array.from(v, (x) => Math.max(-127, Math.min(127, Math.round(x * 127)))).buffer; // D1 binds an ArrayBuffer as a BLOB
const unpack = (b) => typeof b === "string" ? JSON.parse(b)
    : b instanceof ArrayBuffer ? new Int8Array(b) : ArrayBuffer.isView(b) ? new Int8Array(b.buffer, b.byteOffset, b.byteLength) : Int8Array.from(b);
const row = (r) => ({ publisher: r.publisher, repo: r.repo, id: r.id, cid: r.cid, type: r.type, payload: JSON.parse(r.payload) });

// The most records one run adds, updates or deletes, across all repos. A bigger update is split over several runs,
// each saving where it stopped (`cursor` in meta). On a 50k-record repo, 2,000 a run takes ~5 s and under 48 MB.
export const CHANGES_PER_RUN = 2000;
const PAGE = 1000; // index rows read per query
const IDS_PER_QUERY = 90; // D1 binds at most 100 parameters a query

const zero = (h) => !h || /^0x0*$/.test(h);

/** The commits after `from` up to `to`, newest first, or null if any of them has no diff event. */
async function eventCommits(engine, from, to) {
    if (zero(from) || zero(to)) return null;
    const old = engine.hexToRootCid(from), path = [];
    for await (const { cid, commit } of engine.walkParents(engine.hexToRootCid(to))) {
        if (cid.equals(old)) return path;
        if (!commit.diff || !commit.parent) return null;
        path.push(cid);
    }
    return null;
}

/** Merges id-sorted streams into one. If an id is in more than one, the first stream's entry is kept. */
async function* firstWins(streams) {
    const heads = await Promise.all(streams.map(async (s) => ({ s, at: await s.next() })));
    try {
        for (;;) {
            const live = heads.filter((h) => !h.at.done);
            if (!live.length) return;
            const id = live.reduce((min, h) => (h.at.value[0] < min ? h.at.value[0] : min), live[0].at.value[0]);
            let won;
            for (const h of live) if (h.at.value[0] === id) { won ??= h.at.value; h.at = await h.s.next(); }
            yield won;
        }
    } finally { await Promise.all(streams.map((s) => s.return?.())); }
}

/**
 * What changed in a repo between heads `from` and `to` that the index doesn't have yet, sorted by id, starting after
 * `after`. Yields `[id, cid]` to add or update and `[id, null]` to delete. `held` looks things up in the index:
 * `held.ids(ids)` gives a Map of id → cid for the ones it has, and `held.after(id, n)` gives the next n rows after `id`.
 * It holds one page at a time, never the whole repo, so a big update can be split across runs.
 *  - If every commit in between has a diff event, it reads just those diffs (the newest commit wins).
 *  - Otherwise (a new repo, a reset, or older commits), it compares the whole new tree with the index.
 */
export async function* changesSince(engine, { from, to, after = null }, held) {
    const commits = await eventCommits(engine, from, to);
    if (commits) {
        const diffs = firstWins(commits.map((c) => engine.diffEntriesAt(c, { after })));
        let batch = [];
        async function* settle() {
            const have = await held.ids(batch.map(([id]) => id));
            for (const [id, cid] of batch) if (cid ? have.get(id) !== cid.toString() : have.has(id)) yield [id, cid];
            batch = [];
        }
        for await (const e of diffs) if (batch.push(e) === IDS_PER_QUERY) yield* settle();
        yield* settle();
        return;
    }
    const tree = zero(to) ? null : engine.entriesAt(engine.hexToRootCid(to), { after });
    let page = [], i = 0, last = after ?? "", more = true;
    const row = async () => {
        if (i === page.length && more) { page = await held.after(last, PAGE); i = 0; more = page.length === PAGE; if (page.length) last = page.at(-1).id; }
        return page[i] ?? null;
    };
    try {
        let t = tree ? await tree.next() : { done: true };
        for (;;) {
            const r = await row(), id = t.done ? null : t.value[0];
            if (id === null && r === null) return;
            if (id === null || (r && r.id < id)) { i++; yield [r.id, null]; continue; } // in the index, not in the repo: delete
            if (r && r.id === id) { i++; if (r.cid !== t.value[1].toString()) yield t.value; }
            else yield t.value;
            t = await tree.next();
        }
    } finally { await tree?.return(); }
}

/**
 * `db`: a D1 binding. `fangorn` reads the diffs. `gate`: the app's checkers' ids, one per type (src/validate.js gatesOf),
 * or null. With a gate, a record is served (rows, search, embedding, allows) only once it has a verdict, for its current
 * CID and its type's checker, that let it in: a new record, a changed one, or every one of a type whose checks changed
 * waits for checkMissing.
 */
export function d1Index({ db, fangorn, gate = null, perRun = CHANGES_PER_RUN }) {
    const getMeta = async (k) => { const r = await db.prepare("SELECT v FROM meta WHERE k = ?").bind(k).first(); return r && JSON.parse(r.v); };
    const setMeta = (k, v) => db.prepare("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v").bind(k, json(v));
    let pending = [];
    // The cursor `save` writes with the rows: an object to save, null to delete it, undefined to leave it alone.
    let pendingCursor;
    // The gate as SQL over `records`, and its parameters: a verdict for the row's CID, by its type's checker.
    const typed = Object.entries(gate?.types ?? {});
    const checker = typed.length ? `CASE records.type ${typed.map(() => "WHEN ? THEN ?").join(" ")} ELSE ? END` : "?";
    const checkerArgs = gate ? [...typed.flat(), gate.other] : [];
    const verdict = `SELECT 1 FROM verdicts v WHERE v.publisher = records.publisher AND v.repo = records.repo AND v.id = records.id AND v.cid = records.cid AND v.checker = ${checker}`;
    const [allowed, args] = gate ? [`EXISTS (${verdict} AND v.reason IS NULL)`, checkerArgs] : ["1", []];

    const store = {
        load: () => getMeta("stitch"),
        /** The staged rows and the stitch, in one batch: D1 runs a batch as one transaction. */
        async save(it) {
            const same = json((await getMeta("stitch"))?.patterns) === json(it.patterns);
            const ops = same ? [] : [db.prepare("DELETE FROM records"), db.prepare("DELETE FROM verdicts")]; // other patterns: the stitcher started over
            for (const op of pending) if (op.text == null) ops.push(
                db.prepare("DELETE FROM records WHERE publisher = ? AND repo = ? AND id = ?").bind(op.publisher, op.repo, op.id),
                db.prepare("DELETE FROM verdicts WHERE publisher = ? AND repo = ? AND id = ?").bind(op.publisher, op.repo, op.id));
            else ops.push(db.prepare(`INSERT INTO records (publisher, repo, id, cid, type, payload, text, vec) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
                    ON CONFLICT (publisher, repo, id) DO UPDATE SET cid = excluded.cid, type = excluded.type,
                    payload = excluded.payload, text = excluded.text, vec = NULL`)
                    .bind(op.publisher, op.repo, op.id, op.cid, op.type, op.payload, op.text));
            if (pendingCursor) ops.push(setMeta("cursor", pendingCursor));
            else if (pendingCursor === null) ops.push(db.prepare("DELETE FROM meta WHERE k = 'cursor'"));
            ops.push(setMeta("stitch", it));
            await db.batch(ops);
            pending = [];
            pendingCursor = undefined;
        },
    };

    const heldIn = (p, repo) => ({
        async ids(ids) {
            if (!ids.length) return new Map();
            const { results } = await db.prepare(`SELECT id, cid FROM records WHERE publisher = ? AND repo = ? AND id IN (${ids.map(() => "?").join(", ")})`)
                .bind(p, repo, ...ids).all();
            return new Map(results.map((r) => [r.id, r.cid]));
        },
        after: async (id, n) => (await db.prepare("SELECT id, cid FROM records WHERE publisher = ? AND repo = ? AND id > ? ORDER BY id LIMIT ?")
            .bind(p, repo, id, n).all()).results,
    });

    const lens = {
        /**
         * Applies at most `perRun` changes. If there are more, it returns `{ partial: true }`, and `save` stores a
         * cursor with the rows: the repos already done (`done`, as publisher/repo@head) and where it stopped in the next
         * one (`at`). The next call with the same changes picks up there. If a repo has moved again since, the cursor
         * doesn't match and is ignored: rows already written stay, and anything still out of date is redone.
         */
        async apply(changes) {
            const saved = (await getMeta("cursor")) ?? { done: [] }, engine = fangorn.engine;
            const staged = [], done = [];
            let room = perRun, at = null;
            for (const { publisher, repo, from, to } of changes) {
                const p = publisher.toLowerCase(), key = `${p}/${repo}@${to}`;
                if (saved.done.includes(key)) { done.push(key); continue; }
                const resume = saved.at?.key === key ? saved.at.after : null;
                if (room === 0) { at = { key, after: resume }; break; }
                const puts = [];
                let last = resume;
                for await (const [id, cid] of changesSince(engine, { from, to, after: resume }, heldIn(p, repo))) {
                    if (room === 0) { at = { key, after: last }; break; }
                    room--;
                    last = id;
                    if (cid) puts.push([id, cid]);
                    else staged.push({ publisher: p, repo, id });
                }
                if (puts.length) for (const r of await engine.getRecords(puts, engine.hexToRootCid(to)))
                    staged.push({ publisher: p, repo, id: r.id, cid: r.cid, type: r.type ?? null, payload: json(r.payload), text: textOf(r.payload) });
                if (at) break;
                done.push(key);
            }
            pending.push(...staged);
            pendingCursor = at && { done, at };
            return at ? { partial: true } : undefined;
        },
    };

    return {
        store, lens, getMeta, setMeta: (k, v) => setMeta(k, v).run(),

        /** Vectors for up to `max` rows that have none, by `embed(texts) → vectors`. Returns how many. */
        async embedMissing(embed, max = 100) {
            const { results } = await db.prepare(`SELECT publisher, repo, id, text FROM records WHERE vec IS NULL AND ${allowed} LIMIT ?`).bind(...args, max).all();
            if (!results.length) return 0;
            const vecs = await embed(results.map((r) => r.text));
            await db.batch(results.map((r, i) => db.prepare("UPDATE records SET vec = ? WHERE publisher = ? AND repo = ? AND id = ?")
                .bind(pack(vecs[i]), r.publisher, r.repo, r.id)));
            return results.length;
        },

        /**
         * Checks up to `max` records that have no verdict for their current CID under this gate, by
         * `check(record, { publisher, repo }) → null | reason`, and saves the verdicts. → { checked, refused }.
         * A check that throws (the validator unreachable, the file unreadable) leaves its record unchecked, for a later run.
         */
        // ponytail: random order, so a record whose check always throws can't starve the rest; it's retried forever
        async checkMissing(check, max = 25) {
            if (!gate) return { checked: 0, refused: 0 };
            const { results } = await db.prepare(`SELECT publisher, repo, id, cid, type, payload FROM records WHERE NOT EXISTS (${verdict}) ORDER BY random() LIMIT ?`).bind(...checkerArgs, max).all();
            const ops = [];
            let refused = 0;
            for (const r of results.map(row)) {
                let reason;
                try { reason = await check({ id: r.id, type: r.type, cid: r.cid, payload: r.payload }, { publisher: r.publisher, repo: r.repo }); }
                catch (e) { console.warn(`check ${r.publisher}/${r.repo}/${r.id}: ${e?.message ?? e}`); continue; }
                if (reason) refused++;
                ops.push(db.prepare(`INSERT INTO verdicts (publisher, repo, id, cid, checker, reason) VALUES (?, ?, ?, ?, ?, ?)
                    ON CONFLICT (publisher, repo, id) DO UPDATE SET cid = excluded.cid, checker = excluded.checker, reason = excluded.reason`)
                    .bind(r.publisher, r.repo, r.id, r.cid, gateFor(gate, r.type), reason ?? null));
            }
            if (ops.length) await db.batch(ops);
            return { checked: ops.length, refused };
        },

        /** Whether the record at this CID is served: always without a gate, else only with a verdict that let it in. */
        async allows(publisher, repo, id, cid) {
            if (!gate) return true;
            return Boolean(await db.prepare(`SELECT 1 FROM records WHERE publisher = ? AND repo = ? AND id = ? AND cid = ? AND ${allowed}`)
                .bind(publisher.toLowerCase(), repo, id, String(cid), ...args).first());
        },

        /** Every record, as search returns them (no score). */
        async rows() {
            const { results } = await db.prepare(`SELECT publisher, repo, id, cid, type, payload FROM records WHERE ${allowed} ORDER BY publisher, repo, id`).bind(...args).all();
            return results.map(row);
        },

        /** The records the gate refused, and why: { publisher, repo, id, cid, reason }. In the view, so it's plain what was left out. */
        async refused() {
            if (!gate) return [];
            const { results } = await db.prepare(`SELECT records.publisher, records.repo, records.id, records.cid, v.reason FROM records JOIN verdicts v
                ON v.publisher = records.publisher AND v.repo = records.repo AND v.id = records.id AND v.cid = records.cid AND v.checker = ${checker}
                WHERE v.reason IS NOT NULL ORDER BY records.publisher, records.repo, records.id`).bind(...checkerArgs).all();
            return results;
        },

        /** Rewrites up to `max` vectors still stored as JSON text into int8 BLOBs. → how many. */
        async packVectors(max = 2000) {
            const { results } = await db.prepare("SELECT rowid, vec FROM records WHERE typeof(vec) = 'text' LIMIT ?").bind(max).all();
            if (results.length) await db.batch(results.map((r) => db.prepare("UPDATE records SET vec = ? WHERE rowid = ?").bind(pack(JSON.parse(r.vec)), r.rowid)));
            return results.length;
        },

        /** Semantic, lexical or hybrid ranking over the current indexed records. */
        async search(q, { k = 10, page = 2000, type, mode = "semantic", keywords = "" } = {}) {
            const where = type ? `${allowed} AND records.type = ?` : allowed;
            const params = type ? [...args, type] : args;
            const pool = mode === "hybrid" ? Math.max(k, 50) : k;
            let semantic = [], lexical = [];
            if (mode !== "lexical") {
                let after = 0;
                for (;;) {
                    const { results } = await db.prepare(`SELECT rowid, vec FROM records WHERE vec IS NOT NULL AND rowid > ? AND ${where} ORDER BY rowid LIMIT ?`)
                        .bind(after, ...params, page).all();
                    for (const r of results) {
                        const score = cosine(q, unpack(r.vec));
                        if (semantic.length < pool || score > semantic[pool - 1].score) {
                            semantic = [...semantic, { rowid: r.rowid, score }].sort((a, b) => b.score - a.score).slice(0, pool);
                        }
                    }
                    if (results.length < page) break;
                    after = results.at(-1).rowid;
                }
            }
            const terms = mode === "semantic" ? "" : lexicalTerms(keywords);
            if (terms) {
                const { results } = await db.prepare(`SELECT records.rowid, -bm25(record_fts) AS score
                    FROM record_fts JOIN records ON records.rowid = record_fts.rowid
                    WHERE record_fts MATCH ? AND ${where} ORDER BY score DESC, records.rowid LIMIT ?`)
                    .bind(terms, ...params, pool).all();
                lexical = results;
            }
            const top = (mode === "hybrid" ? fuseRanks([semantic, lexical]) : mode === "lexical" ? lexical : semantic).slice(0, k);
            if (!top.length) return [];
            const { results } = await db.prepare(`SELECT rowid, publisher, repo, id, cid, type, payload FROM records
                WHERE rowid IN (${top.map(() => "?").join(", ")}) AND ${where}`)
                .bind(...top.map((t) => t.rowid), ...params).all();
            const byRow = new Map(results.map((r) => [r.rowid, r]));
            return top.filter((t) => byRow.has(t.rowid)).map((t) => ({ ...row(byRow.get(t.rowid)), score: t.score }));
        },
    };
}
