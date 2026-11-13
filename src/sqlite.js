// The local index: one SQLite file (node:sqlite, no dependency) holding the stitch and every followed
// record, with a vector and a full-text entry each. It is the stitcher's store and its lens at once, so
// the stitch and the rows it stands for are written in ONE transaction: the file is never half a step ahead.
//
//   meta(k, v)          'stitch' → { stitch, root, patterns }, 'embedder' → the embedder's id
//   records             (publisher, repo, id) → cid, type, payload (JSON), text, vec (float32 blob)
//   fts                 full-text over records.text, kept in step by triggers

import { DatabaseSync } from "node:sqlite";
import { textOf } from "./embed.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS records (
    publisher TEXT NOT NULL, repo TEXT NOT NULL, id TEXT NOT NULL,
    cid TEXT NOT NULL, type TEXT, payload TEXT NOT NULL, text TEXT NOT NULL, vec BLOB NOT NULL,
    PRIMARY KEY (publisher, repo, id));
CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(text, content='records', content_rowid='rowid');
CREATE TRIGGER IF NOT EXISTS records_ai AFTER INSERT ON records BEGIN
    INSERT INTO fts(rowid, text) VALUES (new.rowid, new.text); END;
CREATE TRIGGER IF NOT EXISTS records_ad AFTER DELETE ON records BEGIN
    INSERT INTO fts(fts, rowid, text) VALUES ('delete', old.rowid, old.text); END;
CREATE TRIGGER IF NOT EXISTS records_au AFTER UPDATE ON records BEGIN
    INSERT INTO fts(fts, rowid, text) VALUES ('delete', old.rowid, old.text);
    INSERT INTO fts(rowid, text) VALUES (new.rowid, new.text); END;`;

const pack = (v) => new Uint8Array(new Float32Array(v).buffer);
const unpack = (b) => new Float32Array(b.slice().buffer); // copy: a blob's offset needn't be 4-aligned
const json = (v) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const RRF = 60; // reciprocal rank fusion's usual constant

function cosine(q, v) {
    let dot = 0, qq = 0, vv = 0;
    for (let i = 0; i < q.length; i++) { dot += q[i] * v[i]; qq += q[i] * q[i]; vv += v[i] * v[i]; }
    return qq && vv ? dot / Math.sqrt(qq * vv) : 0;
}

/** `path`: a file, or ":memory:". `fangorn` reads the diffs, `embedder` embeds records and queries. */
export function sqliteIndex({ path = ":memory:", fangorn, embedder }) {
    const db = new DatabaseSync(path);
    db.exec("PRAGMA journal_mode = WAL"); // readers (the MCP server) alongside the writer
    db.exec(SCHEMA);

    const getMeta = (k) => { const r = db.prepare("SELECT v FROM meta WHERE k = ?").get(k); return r && JSON.parse(r.v); };
    const setMeta = db.prepare("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v");
    const was = getMeta("embedder");
    if (was && !same(was, embedder.id)) {
        db.close();
        throw new Error(`${path} was embedded by ${json(was)}, not ${json(embedder.id)}: use a new file`);
    }

    const upsert = db.prepare(`INSERT INTO records (publisher, repo, id, cid, type, payload, text, vec) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (publisher, repo, id) DO UPDATE SET
        cid = excluded.cid, type = excluded.type, payload = excluded.payload, text = excluded.text, vec = excluded.vec`);
    const del = db.prepare("DELETE FROM records WHERE publisher = ? AND repo = ? AND id = ?");
    const byRowid = db.prepare("SELECT publisher, repo, id, cid, type, payload FROM records WHERE rowid = ?");

    // What `apply` embedded, waiting for `save` to write it with the stitch.
    // ponytail: held in memory until the save; a huge first sync wants a save per chunk of repos.
    let pending = [];

    function transaction(f) {
        db.exec("BEGIN");
        try { f(); db.exec("COMMIT"); } catch (e) { db.exec("ROLLBACK"); throw e; }
    }

    const store = {
        async load() { return getMeta("stitch"); },
        async save(it) {
            transaction(() => {
                // Other patterns: the stitcher started over, so `pending` holds every followed repo whole.
                if (!same(getMeta("stitch")?.patterns, it.patterns)) db.exec("DELETE FROM records");
                for (const op of pending) {
                    if (op.vec) upsert.run(op.publisher, op.repo, op.id, op.cid, op.type, op.payload, op.text, op.vec);
                    else del.run(op.publisher, op.repo, op.id);
                }
                setMeta.run("stitch", json(it));
                setMeta.run("embedder", json(embedder.id));
            });
            pending = [];
        },
    };

    const lens = {
        /** Diff and embed every change; nothing is staged unless all of them succeed. */
        async apply(changes) {
            const staged = [];
            for (const { publisher, repo, from, to } of changes) {
                const p = publisher.toLowerCase();
                const { puts, deletes } = await fangorn.engine.repoDiff(from, to);
                const texts = puts.map((r) => textOf(r.payload));
                const vecs = puts.length ? await embedder.embed(texts) : [];
                for (const id of deletes) staged.push({ publisher: p, repo, id });
                puts.forEach((r, i) => staged.push({ publisher: p, repo, id: r.id, cid: r.cid, type: r.type ?? null,
                    payload: json(r.payload), text: texts[i], vec: pack(vecs[i]) }));
            }
            pending.push(...staged);
        },
    };

    /**
     * Records for `query`, best first: `{ publisher, repo, id, cid, type, payload, score }`.
     * `mode`: "semantic" (cosine to the query's vector), "lexical" (full-text, BM25), or "hybrid" (both,
     * merged by reciprocal rank). `publisher`, `repo` and `type` filter exactly.
     */
    async function search(query, { k = 10, publisher, repo, type, mode = "hybrid" } = {}) {
        const where = [], args = [];
        if (publisher) { where.push("r.publisher = ?"); args.push(publisher.toLowerCase()); }
        if (repo) { where.push("r.repo = ?"); args.push(repo); }
        if (type) { where.push("r.type = ?"); args.push(type); }
        const and = where.map((w) => ` AND ${w}`).join("");
        const pool = Math.max(k, 50); // candidates per ranking, before fusion
        const lists = [];

        if (mode !== "lexical") {
            // ponytail: brute force over every (filtered) vector, fine to ~100k rows; sqlite-vec (db.loadExtension) past that
            const q = await embedder.query(query);
            const rows = db.prepare(`SELECT rowid, vec FROM records r WHERE 1 = 1${and}`).all(...args);
            lists.push(rows.map((r) => ({ rowid: r.rowid, s: cosine(q, unpack(r.vec)) }))
                .sort((a, b) => b.s - a.s).slice(0, pool).map((r) => r.rowid));
        }
        if (mode !== "semantic") {
            // every word as a quoted phrase, OR'd: user text never reaches FTS syntax
            const terms = (query.match(/[^\s"]+/g) ?? []).map((t) => `"${t}"`).join(" OR ");
            lists.push(!terms ? [] : db.prepare(`SELECT r.rowid FROM fts JOIN records r ON r.rowid = fts.rowid
                WHERE fts MATCH ?${and} ORDER BY bm25(fts) LIMIT ?`).all(terms, ...args, pool).map((r) => r.rowid));
        }

        const score = new Map();
        for (const list of lists) list.forEach((rowid, i) => score.set(rowid, (score.get(rowid) ?? 0) + 1 / (RRF + i + 1)));
        return [...score].sort((a, b) => b[1] - a[1]).slice(0, k).map(([rowid, s]) => {
            const r = byRowid.get(rowid);
            return { publisher: r.publisher, repo: r.repo, id: r.id, cid: r.cid, type: r.type, payload: JSON.parse(r.payload), score: s };
        });
    }

    const allQ = db.prepare("SELECT publisher, repo, id, cid, type, payload FROM records ORDER BY publisher, repo, id");
    /** Every record, as search returns them (no score): what a view file holds. */
    const rows = () => allQ.all().map((r) => ({ ...r, payload: JSON.parse(r.payload) }));

    return { db, store, lens, search, rows, close: () => db.close() };
}
