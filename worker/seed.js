#!/usr/bin/env node
// SQL that seeds the Worker's D1 from a local index (src/sqlite.js): the stitch and the records, WITHOUT vectors
// (the Worker embeds them with Workers AI, so its rows all come from one runtime). This spares the Worker the
// first catch-up over the whole update log, which is more requests than one run may make.
//
//   node worker/seed.js index.db > worker/seed.sql
//   wrangler d1 execute <your-d1> --remote --file worker/seed.sql      (from worker/)

import { DatabaseSync } from "node:sqlite";
import { SCHEMA } from "../src/d1.js";

const db = new DatabaseSync(process.argv[2] ?? "index.db", { readOnly: true });
const q = (v) => v == null ? "NULL" : `'${String(v).replaceAll("'", "''")}'`;
const out = [SCHEMA.trim()];
const stitch = db.prepare("SELECT v FROM meta WHERE k = 'stitch'").get();
if (!stitch) throw new Error("no stitch in that index: run it first");
out.push(`INSERT INTO meta (k, v) VALUES ('stitch', ${q(stitch.v)}) ON CONFLICT (k) DO UPDATE SET v = excluded.v;`);
for (const r of db.prepare("SELECT publisher, repo, id, cid, type, payload, text FROM records").all())
    out.push(`INSERT OR REPLACE INTO records (publisher, repo, id, cid, type, payload, text, vec) VALUES (${[r.publisher, r.repo, r.id, r.cid, r.type, r.payload, r.text].map(q).join(", ")}, NULL);`);
console.log(out.join("\n"));
