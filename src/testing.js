// Test helpers.

/**
 * Not a model: a vector of word counts over a fixed vocabulary, with "furniture" counted as "table" and
 * "chair", so meaning can match what words don't. Counts what it embeds.
 */
export function fakeEmbedder() {
    const vocab = ["table", "chair", "lamp", "light", "rug"];
    const vec = (t) => {
        const words = t.toLowerCase().split(/\W+/);
        return vocab.map((v) => words.filter((w) => w === v || (w === "furniture" && (v === "table" || v === "chair"))).length);
    };
    const seen = [];
    return { seen, id: { model: "fake", dim: vocab.length }, embed: async (ts) => (seen.push(...ts), ts.map(vec)), query: async (t) => vec(t) };
}

/** A D1 binding over node:sqlite, in memory: prepare/bind/first/all/run, batch as one transaction, exec. */
export async function d1Shim() {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(":memory:");
    const stmt = (sql, args = []) => ({
        bind: (...a) => stmt(sql, a),
        first: async () => db.prepare(sql).get(...args) ?? null,
        all: async () => ({ results: db.prepare(sql).all(...args) }),
        run: async () => db.prepare(sql).run(...args),
        now: () => db.prepare(sql).run(...args),
    });
    return {
        prepare: (sql) => stmt(sql),
        exec: async (sql) => db.exec(sql),
        async batch(ops) {
            db.exec("BEGIN");
            try { ops.forEach((o) => o.now()); db.exec("COMMIT"); } catch (e) { db.exec("ROLLBACK"); throw e; }
        },
    };
}
