// The repos index on D1: one row per repo (its head and agent card), not the records in it. CONFIG.index = "repos".
// With follow ["*"] it's Fangorn's registry: every repo of every publisher, found by its name and its card.
//
// Same shape as d1.js (store, lens, getMeta/setMeta, embedMissing, rows, search), and the same split of work:
// the lens only writes heads, straight from the stitch (no reads), so absorbing any number of moved repos fits in
// one run. A moved head marks its row `stale`; `cardsMissing` then re-reads up to `max` cards a run, like
// `embedMissing` fills vectors. A repo is listed, by name, from the run its head first shows up.

import { CARD_RECORD, FANGORN_REPO_EXTENSION } from "@fangorn-network/sdk";

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS repos (
    publisher TEXT NOT NULL, repo TEXT NOT NULL, head TEXT NOT NULL, updated TEXT NOT NULL,
    card_url TEXT, card TEXT, text TEXT NOT NULL, vec TEXT, stale INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (publisher, repo));`;

const MAX_CARD = 64 * 1024;
const json = (v) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));
const cosine = (q, v) => { let d = 0, a = 0, b = 0; for (let i = 0; i < q.length; i++) { d += q[i] * v[i]; a += q[i] * q[i]; b += v[i] * v[i]; } return a && b ? d / Math.sqrt(a * b) : 0; };

/**
 * The card a repo's `@card` record points at, if it speaks for this repo on this network: { url, card } or null.
 * The card is the publisher's to write, so it's kept as data: whatever fields it has, up to 64 KB.
 */
export async function cardOf(fangorn, publisher, repo) {
    const url = (await fangorn.engine.readRecord(publisher, repo, CARD_RECORD).catch(() => null))?.payload?.url;
    if (typeof url !== "string" || !/^https?:\/\//.test(url)) return null;
    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
        const body = await res.text();
        if (!res.ok || body.length > MAX_CARD) return null;
        const card = JSON.parse(body), p = card?.capabilities?.extensions?.find((e) => e?.uri === FANGORN_REPO_EXTENSION)?.params ?? {};
        const { caip2, dataRegistryContractAddress } = fangorn.getConfig();
        const ours = String(p.publisher).toLowerCase() === publisher.toLowerCase() && p.repo === repo
            && p.chainId === caip2 && String(p.dataRegistry).toLowerCase() === dataRegistryContractAddress.toLowerCase();
        return ours ? { url, card } : null;
    } catch { return null; } // ponytail: an unreachable or broken card lists the repo without one; it's re-read when the head moves
}

/** What search matches for a repo: its name in words, and its card's name, description and skills. */
export function textOf(repo, card) {
    const skills = Array.isArray(card?.skills) ? card.skills : [];
    return [repo.replace(/[-_.]+/g, " "), card?.name, card?.description, ...skills.flatMap((s) => [s?.name, s?.description, ...(Array.isArray(s?.tags) ? s.tags : [])])]
        .filter((x) => typeof x === "string" && x).join("\n").slice(0, 4000);
}

const rowOf = (r, full) => {
    const card = r.card ? JSON.parse(r.card) : null;
    return { publisher: r.publisher, repo: r.repo, head: r.head, updated: r.updated, card_url: r.card_url ?? null,
        ...(full ? { card } : { name: card?.name ?? null, description: card?.description ?? null }) };
};

/** `db`: a D1 binding. `fangorn` reads cards. `now()`: the time a moved head is stamped with. */
export function d1Repos({ db, fangorn, now = () => new Date().toISOString() }) {
    const all = async (sql, ...args) => (await db.prepare(sql).bind(...args).all()).results;
    const getMeta = async (k) => { const r = await db.prepare("SELECT v FROM meta WHERE k = ?").bind(k).first(); return r && JSON.parse(r.v); };
    const setMeta = (k, v) => db.prepare("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v").bind(k, json(v));
    let pending = [];

    const store = {
        load: () => getMeta("stitch"),
        /** The staged heads and the stitch, in one batch (one transaction). */
        async save(it) {
            const same = json((await getMeta("stitch"))?.patterns) === json(it.patterns);
            const ops = same ? [] : [db.prepare("DELETE FROM repos")]; // other patterns: the stitcher started over
            for (const { publisher, repo, head } of pending) ops.push(db.prepare(
                `INSERT INTO repos (publisher, repo, head, updated, text) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT (publisher, repo) DO UPDATE SET head = excluded.head, updated = excluded.updated, stale = 1`)
                .bind(publisher, repo, head, now(), textOf(repo, null)));
            ops.push(setMeta("stitch", it));
            await db.batch(ops);
            pending = [];
        },
    };

    const lens = {
        async apply(changes) {
            pending.push(...changes.map(({ publisher, repo, to }) => ({ publisher: publisher.toLowerCase(), repo, head: to })));
        },
    };

    return {
        store, lens, getMeta, setMeta: (k, v) => setMeta(k, v).run(),

        /**
         * Re-read the card of up to `max` repos whose head moved (~5 subrequests each, so a burst of new repos can't
         * blow a run's limit; the rest wait for the next runs). The vector is kept when the text didn't change.
         * A head that moved again meanwhile stays stale. → how many.
         */
        async cardsMissing(max = 50) {
            const rows = await all("SELECT publisher, repo, head, text FROM repos WHERE stale = 1 LIMIT ?", max);
            if (!rows.length) return 0;
            const cards = await Promise.all(rows.map((r) => cardOf(fangorn, r.publisher, r.repo)));
            await db.batch(rows.map((r, i) => {
                const c = cards[i], text = textOf(r.repo, c?.card);
                return db.prepare(`UPDATE repos SET card_url = ?, card = ?, text = ?, stale = 0,
                    vec = CASE WHEN text = ? THEN vec ELSE NULL END WHERE publisher = ? AND repo = ? AND head = ?`)
                    .bind(c?.url ?? null, c ? JSON.stringify(c.card) : null, text, text, r.publisher, r.repo, r.head);
            }));
            return rows.length;
        },

        /** Vectors for up to `max` repos that have none, by `embed(texts) → vectors`. → how many. */
        async embedMissing(embed, max = 100) {
            const rows = await all("SELECT publisher, repo, text FROM repos WHERE vec IS NULL LIMIT ?", max);
            if (!rows.length) return 0;
            const vecs = await embed(rows.map((r) => r.text));
            await db.batch(rows.map((r, i) => db.prepare("UPDATE repos SET vec = ? WHERE publisher = ? AND repo = ?")
                .bind(JSON.stringify(Array.from(vecs[i])), r.publisher, r.repo)));
            return rows.length;
        },

        /** Every repo (the view), with its whole card. */
        async rows() { return (await all("SELECT * FROM repos ORDER BY publisher, repo")).map((r) => rowOf(r, true)); },

        /** Repos, newest change first; with `q` (a query vector), nearest first, each with `score`. */
        // ponytail: every vector, every query; fine for thousands of repos, Vectorize past that
        async find({ q, publisher, k = 20 } = {}) {
            const where = publisher ? "WHERE publisher = ?" : "", args = publisher ? [publisher.toLowerCase()] : [];
            if (!q) return (await all(`SELECT * FROM repos ${where} ORDER BY updated DESC, publisher, repo LIMIT ?`, ...args, k)).map((r) => rowOf(r));
            const rows = await all(`SELECT * FROM repos ${where ? where + " AND" : "WHERE"} vec IS NOT NULL`, ...args);
            return rows.map((r) => ({ ...rowOf(r), score: cosine(q, JSON.parse(r.vec)) })).sort((a, b) => b.score - a.score).slice(0, k);
        },

        /** As d1Index's search: the `k` repos nearest `q`. */
        search(q, { k = 10 } = {}) { return this.find({ q, k }); },

        /** One repo, with its whole card, or null. */
        async get(publisher, repo) {
            const r = await db.prepare("SELECT * FROM repos WHERE publisher = ? AND repo = ?").bind(String(publisher).toLowerCase(), repo).first();
            return r ? rowOf(r, true) : null;
        },
    };
}
