// A D1-shaped database over a Durable Object's SQLite (ctx.storage.sql), so src/d1.js runs unchanged inside one.
// Only what d1.js uses: prepare(sql).bind(...).first() / .all() / .run(), batch(statements) and exec(sql).
// Differences from D1, all hidden here: the DO's calls are synchronous, a batch is storage.transactionSync, and a
// BLOB reads back as an ArrayBuffer (d1.js's unpack takes either).

/** `storage`: a Durable Object's ctx.storage (its `sql`, and `transactionSync` for batches). */
export function d1OfSql(storage) {
    const { sql } = storage;
    const stmt = (query, args = []) => ({
        bind: (...a) => stmt(query, a),
        first: async () => sql.exec(query, ...args).toArray()[0] ?? null,
        all: async () => ({ results: sql.exec(query, ...args).toArray() }),
        run: async () => { sql.exec(query, ...args).toArray(); return { success: true }; },
        now: () => sql.exec(query, ...args).toArray(),
    });
    return {
        prepare: (query) => stmt(query),
        exec: async (query) => { sql.exec(query); },
        /** One transaction, as D1 runs a batch: all of it lands, or none. */
        batch: async (ops) => storage.transactionSync(() => ops.map((o) => o.now())),
    };
}
