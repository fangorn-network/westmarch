// The demo: learn a taste in one publisher's corpus, spend it in another's.
//
// The two corpora share no ids, no schema, no publisher and no agreement of any
// kind. They share a model. That turns out to be enough.
//
//   node taste-demo.mjs
import { configure, domainManifests, loadShard, resetShard, setView } from "@fangorn/westmarch/shard";
import { rolesFrom, textOf, titleOf } from "@fangorn/westmarch/roles";
import { exportTaste, importTaste, recommend, taste } from "@fangorn/westmarch/taste";
import { findCorpora } from "@fangorn/westmarch/directory";
import { EMBED_MODEL, embedQuery } from "@fangorn/westmarch/embed";

const BASE = process.argv[2] ?? "http://localhost:5180";
const SOURCES = ["archive-films", "archive-transcripts", "games", "places"].map((d) => `${BASE}/${d}`);
let roles = rolesFrom([], []);
configure({ onManifests: (m) => { roles = rolesFrom(m); }, rowText: (f) => textOf(f, roles) });

async function open(view) {
    resetShard(); setView(view); roles = rolesFrom([], []);
    const rows = await loadShard(view);
    roles = rolesFrom(domainManifests(view), rows);
    return rows;
}
const show = (r, n = 3) => r.slice(0, n).map((x) => `${titleOf(x.row ?? x, roles)}${x.score !== undefined ? ` [${x.score}]` : ""}`);

console.log("=== 1. the directory: which corpus, without downloading any ===");
const dir = await findCorpora("post-apocalyptic survival with a bleak atmosphere",
    { sources: SOURCES, embed: embedQuery, model: EMBED_MODEL });
for (const c of dir.corpora) console.log(`   ${String(c.domain).padEnd(22)} ${c.affinity?.toFixed(4) ?? "  null"}  ${c.rows} rows`);

console.log("\n=== 2. open the films, pick four ===");
let rows = await open(`${BASE}/archive-films`);
console.log(`   ${rows.length} films, shape ${roles.declared ? "declared" : "sniffed"}`);
const picks = [];
for (const q of ["post-apocalyptic wasteland after a nuclear war",
                 "a lone survivor in a ruined city",
                 "cold war paranoia and civil defense",
                 "bleak dystopian science fiction"]) {
    const qv = await embedQuery(q);
    const best = rows.filter((r) => r.vector)
        .map((r) => ({ r, s: (() => { let d = 0, n = 0; for (let i = 0; i < qv.length; i++) { d += r.vector[i] * qv[i]; n += qv[i] * qv[i]; } return d / (r.norm * Math.sqrt(n)); })() }))
        .sort((a, b) => b.s - a.s)[0];
    picks.push({ id: best.r.id, title: titleOf(best.r, roles), vector: best.r.vector });
    console.log(`   liked: ${titleOf(best.r, roles)}`);
}

const t = taste(picks);
const wire = exportTaste(t);
console.log(`\n=== 3. the taste, as a portable object: ${JSON.stringify(wire).length} bytes ===`);
console.log(`   built from: ${t.from.join(" | ")}`);
console.log(`   heading   : ${t.v ? "moving — leans ahead of what was picked" : "settled"}`);

console.log("\n=== 4. carry it to a DIFFERENT publisher's corpus ===");
const carried = importTaste(JSON.parse(JSON.stringify(wire)));   // through the wire, as a person would
rows = await open(`${BASE}/games`);
console.log(`   opened games: ${rows.length} rows from ${roles.declared ? "a declared" : "a sniffed"} manifest`);
const recs = recommend(rows, carried, { limit: 5 });
for (const h of recs) {
    const g = h.row;
    console.log(`   ${h.score}  ${titleOf(g, roles)} (${g.year ?? "?"})  ${[...(g.genre ?? []), ...(g.setting ?? [])].slice(0, 4).join(", ")}`);
}

console.log("\n=== 5. control: a taste built from comedies should rank differently ===");
rows = await open(`${BASE}/archive-films`);
const comedyPicks = [];
for (const q of ["slapstick comedy sketch show", "a lighthearted family sitcom",
                 "silly cartoon antics", "a romantic comedy"]) {
    const qv = await embedQuery(q);
    const best = rows.filter((r) => r.vector)
        .map((r) => ({ r, s: (() => { let d = 0, n = 0; for (let i = 0; i < qv.length; i++) { d += r.vector[i] * qv[i]; n += qv[i] * qv[i]; } return d / (r.norm * Math.sqrt(n)); })() }))
        .sort((a, b) => b.s - a.s)[0];
    comedyPicks.push({ id: best.r.id, title: titleOf(best.r, roles), vector: best.r.vector });
}
console.log(`   built from: ${comedyPicks.map((p) => p.title).join(" | ")}`);
rows = await open(`${BASE}/games`);
for (const h of recommend(rows, taste(comedyPicks), { limit: 5 })) {
    const g = h.row;
    console.log(`   ${h.score}  ${titleOf(g, roles)} (${g.year ?? "?"})  ${[...(g.genre ?? []), ...(g.setting ?? [])].slice(0, 4).join(", ")}`);
}
