import { configure, domainManifests, loadShard, resetShard, setView } from "@fangorn/westmarch/shard";
import { rolesFrom, textOf, titleOf } from "@fangorn/westmarch/roles";
import { embedQuery } from "@fangorn/westmarch/embed";
import { browse, facet, search } from "./tools.js";

const V = "http://localhost:5180/games";
let roles = rolesFrom([], []);
configure({ onManifests: (m) => { roles = rolesFrom(m); }, rowText: (f) => textOf(f, roles) });
resetShard(); setView(V);
const rows = await loadShard(V);
roles = rolesFrom(domainManifests(V), rows);

// facet-field: how big is the genre actually
console.log("── facet-field genre (survival / building slice) ──");
const g = facet(rows, "genre", { limit: 30 });
console.log("  " + g.top.filter(t => /surv|sandbox|open-world|simul|strat/.test(t.value)).map(t => `${t.value}(${t.count})`).join("  "));

// browse with where: the intersection, no query needed
console.log("\n── browse-collection where genre=survival, sorted ──");
const surv = browse(rows, roles, { where: { genre: "survival" }, limit: 500 });
console.log(`  ${surv.total} survival games in the corpus`);

// the intersection: survival AND (sandbox|open-world|simulation|strategy)
const both = rows.filter(r => {
  const gs = (Array.isArray(r.genre) ? r.genre : []).map(x => x.toLowerCase());
  return gs.includes("survival") && gs.some(x => ["sandbox","open-world","simulation","strategy"].includes(x));
});
console.log(`  ${both.length} of them are ALSO sandbox / open-world / simulation / strategy`);

const q = "open world survival crafting where you build and manage a growing settlement or city";
const qv = await embedQuery(q);
const norm = v => Math.sqrt(v.reduce((s,x)=>s+x*x,0));
const qn = norm(qv);
const ranked = both.map(r => {
  let d = 0; for (let i = 0; i < qv.length; i++) d += r.vector[i] * qv[i];
  return { r, s: d / (r.norm * qn) };
}).sort((a,b)=>b.s-a.s).slice(0, 10);

console.log("\n── ranked by your description ──");
for (const { r, s } of ranked) {
  console.log(`\n  ${s.toFixed(4)}  ${titleOf(r, roles)} (${r.year || "?"})`);
  console.log(`          ${[...(r.genre||[]), ...(r.setting||[])].join(", ")}`);
  console.log(`          ${String(r.desc||"").slice(0,170).replace(/\s+/g," ")}…`);
}
