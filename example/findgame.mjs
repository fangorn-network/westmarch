// The same verbs the WebMCP tools wrap: find-corpora -> open-corpus ->
// search-corpus / facet-field / similar-rows.
import { configure, domainManifests, loadShard, resetShard, setView } from "@fangorn/westmarch/shard";
import { rolesFrom, textOf, titleOf } from "@fangorn/westmarch/roles";
import { findCorpora } from "@fangorn/westmarch/directory";
import { EMBED_MODEL, embedQuery } from "@fangorn/westmarch/embed";
import { browse, facet, getRow, neighbors, search } from "./tools.js";

const BASE = "http://localhost:5180";
const SOURCES = ["archive-films", "archive-transcripts", "games", "places"].map((d) => `${BASE}/${d}`);
let roles = rolesFrom([], []);
configure({ onManifests: (m) => { roles = rolesFrom(m); }, rowText: (f) => textOf(f, roles) });

const Q = "open world survival crafting mixed with city building and base management";

console.log("── find-corpora ─────────────────────────────────────────");
const dir = await findCorpora(Q, { sources: SOURCES, embed: embedQuery, model: EMBED_MODEL });
for (const c of dir.corpora) console.log(`  ${String(c.domain).padEnd(21)} ${c.affinity?.toFixed(4)}  ${c.rows} rows`);

const best = dir.corpora[0];
console.log(`\n── open-corpus ${best.view} ─────────────`);
resetShard(); setView(best.view); roles = rolesFrom([], []);
let rows = await loadShard(best.view);
roles = rolesFrom(domainManifests(best.view), rows);
console.log(`  ${rows.length} rows, shape ${roles.declared ? "declared" : "sniffed"}`);

console.log(`\n── search-corpus ────────────────────────────────────────`);
const qv = await embedQuery(Q);
const hits = search(rows, Q, roles, { qv, limit: 8, fields: ["year", "genre", "setting", "mode", "url"] });
for (const h of hits) {
  console.log(`\n  ${h.score}  ${h.title} (${h.subtitle ?? "?"})`);
  console.log(`         ${[...(h.genre ?? []), ...(h.setting ?? [])].join(", ") || "—"}`);
  console.log(`         ${h.url ?? ""}`);
}

console.log(`\n── facet-field: what survival/simulation looks like here ──`);
for (const f of ["genre", "setting"]) {
  const r = facet(rows, f, { limit: 8 });
  console.log(`  ${f}: ${r.top.map((t) => `${t.value}(${t.count})`).join("  ")}`);
}

console.log(`\n── similar-rows from the top hit ────────────────────────`);
const n = neighbors(rows, hits[0].id, roles, { limit: 5 });
for (const x of n.near) console.log(`  ${x.score}  ${x.title}`);
