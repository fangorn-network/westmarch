// The index on Cloudflare D1 (async SQLite): the stitcher's store and lens, the view, and search by meaning.
// Same shape as sqlite.js, with one difference: the lens writes records WITHOUT vectors, and `embedMissing`
// fills them in afterwards, a bounded number per run. So a run never exceeds the encoder's budget, a failed
// embed costs nothing but a retry, and rows seeded from elsewhere get vectors from this runtime only.

import { textOf } from "./embed.js";

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS records (
    publisher TEXT NOT NULL, repo TEXT NOT NULL, id TEXT NOT NULL,
    cid TEXT NOT NULL, type TEXT, payload TEXT NOT NULL, text TEXT NOT NULL, vec TEXT,
    PRIMARY KEY (publisher, repo, id));`;

const json = (v) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));
const cosine = (q, v) => { let d = 0, a = 0, b = 0; for (let i = 0; i < q.length; i++) { d += q[i] * v[i]; a += q[i] * q[i]; b += v[i] * v[i]; } return a && b ? d / Math.sqrt(a * b) : 0; };
const row = (r) => ({ publisher: r.publisher, repo: r.repo, id: r.id, cid: r.cid, type: r.type, payload: JSON.parse(r.payload) });

/** `db`: a D1 binding. `fangorn` reads the diffs. */
export function d1Index({ db, fangorn }) {
    const getMeta = async (k) => { const r = await db.prepare("SELECT v FROM meta WHERE k = ?").bind(k).first(); return r && JSON.parse(r.v); };
    const setMeta = (k, v) => db.prepare("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v").bind(k, json(v));
    let pending = [];

    const store = {
        load: () => getMeta("stitch"),
        /** The staged rows and the stitch, in one batch: D1 runs a batch as one transaction. */
        async save(it) {
            const same = json((await getMeta("stitch"))?.patterns) === json(it.patterns);
            const ops = same ? [] : [db.prepare("DELETE FROM records")]; // other patterns: the stitcher started over
            for (const op of pending) ops.push(op.text == null
                ? db.prepare("DELETE FROM records WHERE publisher = ? AND repo = ? AND id = ?").bind(op.publisher, op.repo, op.id)
                : db.prepare(`INSERT INTO records (publisher, repo, id, cid, type, payload, text, vec) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
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
                const { puts, deletes } = await fangorn.engine.repoDiff(from, to);
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
            const { results } = await db.prepare("SELECT publisher, repo, id, text FROM records WHERE vec IS NULL LIMIT ?").bind(max).all();
            if (!results.length) return 0;
            const vecs = await embed(results.map((r) => r.text));
            await db.batch(results.map((r, i) => db.prepare("UPDATE records SET vec = ? WHERE publisher = ? AND repo = ? AND id = ?")
                .bind(JSON.stringify(Array.from(vecs[i])), r.publisher, r.repo, r.id)));
            return results.length;
        },

        /** Every record, as search returns them (no score). */
        async rows() {
            const { results } = await db.prepare("SELECT publisher, repo, id, cid, type, payload FROM records ORDER BY publisher, repo, id").all();
            return results.map(row);
        },

        /** The `k` records nearest the query vector `q`, best first. Rows not yet embedded are left out. */
        // ponytail: every vector, every query, in the Worker: fine for thousands of rows; Vectorize past that
        async search(q, { k = 10 } = {}) {
            const { results } = await db.prepare("SELECT publisher, repo, id, cid, type, payload, vec FROM records WHERE vec IS NOT NULL").all();
            return results.map((r) => ({ ...row(r), score: cosine(q, JSON.parse(r.vec)) })).sort((a, b) => b.score - a.score).slice(0, k);
        },
    };
}
