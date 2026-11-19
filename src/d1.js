// The index on Cloudflare D1 (async SQLite): the stitcher's store and lens, the view, and search by meaning.
// Same shape as sqlite.js, with one difference: the lens writes records WITHOUT vectors, and `embedMissing`
// fills them in afterwards, a bounded number per run. So a run never exceeds the encoder's budget, a failed
// embed costs nothing but a retry, and rows seeded from elsewhere get vectors from this runtime only.

import { textOf } from "./embed.js";
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
    PRIMARY KEY (publisher, repo, id));`;

const json = (v) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));
const cosine = (q, v) => { let d = 0, a = 0, b = 0; for (let i = 0; i < q.length; i++) { d += q[i] * v[i]; a += q[i] * q[i]; b += v[i] * v[i]; } return a && b ? d / Math.sqrt(a * b) : 0; };
const row = (r) => ({ publisher: r.publisher, repo: r.repo, id: r.id, cid: r.cid, type: r.type, payload: JSON.parse(r.payload) });

/**
 * What changed in a repo from head `from` to `to`, against `known` (id → record CID, what the index holds now),
 * reading only the commits in between: their diff events, and the records they put.
 * `repoDiff` looks every changed id up in the OLD tree, and an old tree node resolves by walking the repo's
 * history one CAR at a time: 226 fetches for a 3-record commit on a 300-record repo, where a free-plan run may make 50.
 */
// ponytail: a put whose record CID an older commit introduced (a revert) still walks back to it; rare
export async function diffSince(engine, from, to, known) {
    const zero = (h) => !h || /^0x0*$/.test(h);
    const tip = zero(to) ? null : engine.hexToRootCid(to);
    const events = !zero(from) && tip && await engine.eventsSince(engine.hexToRootCid(from), tip);
    if (!events) return engine.repoDiff(from, to); // a new or emptied repo, a reset, or commits without diff events
    const puts = [], deletes = [];
    for (const [id, after] of events) {
        if (!after) { if (known.has(id)) deletes.push(id); }
        else if (known.get(id) !== after.toString()) puts.push(await engine.decodeRecord(id, after, tip));
    }
    return { puts, deletes };
}

/**
 * `db`: a D1 binding. `fangorn` reads the diffs. `gate`: the app's checkers' ids, one per type (src/validate.js gatesOf),
 * or null. With a gate, a record is served (rows, search, embedding, allows) only once it has a verdict, for its current
 * CID and its type's checker, that let it in: a new record, a changed one, or every one of a type whose checks changed
 * waits for checkMissing.
 */
export function d1Index({ db, fangorn, gate = null }) {
    const getMeta = async (k) => { const r = await db.prepare("SELECT v FROM meta WHERE k = ?").bind(k).first(); return r && JSON.parse(r.v); };
    const setMeta = (k, v) => db.prepare("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v").bind(k, json(v));
    let pending = [];
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
            ops.push(setMeta("stitch", it));
            await db.batch(ops);
            pending = [];
        },
    };

    const lens = {
        async apply(changes) {
            const staged = [];
            for (const { publisher, repo, from, to } of changes) {
                const p = publisher.toLowerCase();
                const { results } = await db.prepare("SELECT id, cid FROM records WHERE publisher = ? AND repo = ?").bind(p, repo).all();
                const { puts, deletes } = await diffSince(fangorn.engine, from, to, new Map(results.map((r) => [r.id, r.cid])));
                for (const id of deletes) staged.push({ publisher: p, repo, id });
                for (const r of puts) staged.push({ publisher: p, repo, id: r.id, cid: r.cid, type: r.type ?? null, payload: json(r.payload), text: textOf(r.payload) });
            }
            pending.push(...staged);
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
                .bind(JSON.stringify(Array.from(vecs[i])), r.publisher, r.repo, r.id)));
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

        /** The `k` records nearest the query vector `q`, best first. Rows not yet embedded are left out. */
        // ponytail: every vector, every query, in the Worker: fine for thousands of rows; Vectorize past that
        async search(q, { k = 10 } = {}) {
            const { results } = await db.prepare(`SELECT publisher, repo, id, cid, type, payload, vec FROM records WHERE vec IS NOT NULL AND ${allowed}`).bind(...args).all();
            return results.map((r) => ({ ...row(r), score: cosine(q, JSON.parse(r.vec)) })).sort((a, b) => b.score - a.score).slice(0, k);
        },
    };
}
