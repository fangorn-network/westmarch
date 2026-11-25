// A shared cache of embeddings: a vector made once for a text is reused by every app (and every run) that embeds the
// same text with the same model and prompt. It lives in one Durable Object's SQLite (`Embeds`), not KV: a write there
// is a row ($1/M on Workers Paid), where a KV write is $5/M and the free plan allows 1,000 a day. Reads are close to
// free either way. Entries never change once written.
//
//   key    sha256 of model, prompt and text (hex)
//   value  the packed vector src/d1.js stores (int8, 256 bytes)
//
// ponytail: one object for every app; shard by key prefix (idFromName("embeds-" + k[0])) if it ever becomes a hot spot

import { DurableObject } from "cloudflare:workers";

const CHUNK = 100; // bound parameters per statement in a Durable Object's SQLite

/** The cache's storage: one Durable Object, called over RPC. */
export class Embeds extends DurableObject {
    constructor(ctx, env) {
        super(ctx, env);
        ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS embeds (k TEXT PRIMARY KEY, v BLOB NOT NULL) WITHOUT ROWID");
    }
    /** keys → { key: packed vector } for the ones held. */
    async get(keys) {
        const out = {};
        for (let i = 0; i < keys.length; i += CHUNK) {
            const part = keys.slice(i, i + CHUNK);
            for (const r of this.ctx.storage.sql.exec(`SELECT k, v FROM embeds WHERE k IN (${part.map(() => "?").join(",")})`, ...part).toArray()) out[r.k] = r.v;
        }
        return out;
    }
    /** [[key, packed vector]]; one already held is left as it is. */
    async put(entries) {
        this.ctx.storage.transactionSync(() => {
            for (const [k, v] of entries) this.ctx.storage.sql.exec("INSERT OR IGNORE INTO embeds (k, v) VALUES (?, ?)", k, v);
        });
    }
    async stats() { return this.ctx.storage.sql.exec("SELECT count(*) AS n FROM embeds").toArray()[0]; }
}

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

/**
 * The cache as src/d1.js's embedMissing takes it: `get(texts) → [packed | null]`, `put([[text, packed]])`. `store` is the
 * Embeds stub. A failed write is logged, not thrown: the vectors are already in the app's index. `hits`, `misses` and
 * `written` count this object's traffic, for the app's status.
 */
export function embedCache(store, { model, prompt = "" }) {
    const keyOf = async (text) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${model}\n${prompt}\n${text}`)));
    const cache = {
        hits: 0, misses: 0, written: 0,
        async get(texts) {
            const keys = await Promise.all(texts.map(keyOf)), found = await store.get([...new Set(keys)]);
            const out = keys.map((k) => found[k] ?? null);
            for (const v of out) v ? cache.hits++ : cache.misses++;
            return out;
        },
        async put(entries) {
            try {
                await store.put(await Promise.all(entries.map(async ([text, vec]) => [await keyOf(text), vec])));
                cache.written += entries.length;
            } catch (e) { console.warn(`embed cache: ${e?.message ?? e}`); }
        },
    };
    return cache;
}
