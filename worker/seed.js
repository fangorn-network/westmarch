#!/usr/bin/env node
// SQL that seeds the Worker's D1: the stitch and the records, WITHOUT vectors (the Worker embeds them with Workers
// AI, so its rows all come from one runtime). This spares the Worker the first catch-up over the whole update log,
// which is more requests than one run may make.
//
//   node worker/seed.js app.json > seed.sql     catches up here first, into a scratch index (nothing embedded)
//   node worker/seed.js index.db > seed.sql     or from a local index you already run (src/sqlite.js)
//   wrangler d1 execute <your-d1> --remote --file seed.sql
//
// worker/deploy.sh does this for a new app.

import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEMA } from "../src/d1.js";
import { readConfig, run } from "../src/run.js";
import { client } from "../src/client.js";

let file = process.argv[2] ?? "index.db";
if (file.endsWith(".json")) {
    // No view: the Worker publishes its own (here, under a throwaway key with no gas, it could only fail).
    const { view, publishView, ...config } = readConfig(file);
    file = join(mkdtempSync(join(tmpdir(), "seed-")), "index.db");
    const none = { id: "none", embed: async (texts) => texts.map(() => [0]) }; // a placeholder: the seed drops vectors
    // once: a failed catch-up throws its own error (a 429, a log-root mismatch), not "no stitch" below
    await (await run({ config, fangorn: client(config), embedder: none, path: file, log: console.error, once: true })).stop();
}
const db = new DatabaseSync(file, { readOnly: true });
const q = (v) => v == null ? "NULL" : `'${String(v).replaceAll("'", "''")}'`;
const out = [SCHEMA.trim()];
const stitch = db.prepare("SELECT v FROM meta WHERE k = 'stitch'").get();
if (!stitch) throw new Error("no stitch in that index: run it first");
out.push(`INSERT INTO meta (k, v) VALUES ('stitch', ${q(stitch.v)}) ON CONFLICT (k) DO UPDATE SET v = excluded.v;`);
for (const r of db.prepare("SELECT publisher, repo, id, cid, type, payload, text FROM records").all())
    out.push(`INSERT INTO records (publisher, repo, id, cid, type, payload, text, vec) VALUES (${[r.publisher, r.repo, r.id, r.cid, r.type, r.payload, r.text].map(q).join(", ")}, NULL) ON CONFLICT (publisher, repo, id) DO UPDATE SET cid = excluded.cid, type = excluded.type, payload = excluded.payload, text = excluded.text, vec = NULL;`);
console.log(out.join("\n"));
