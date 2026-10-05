// A view through the real library, no browser.  `node probe.mjs [viewUrl]`
import { configure, domainManifests, loadShard } from "@fangorn/westmarch/shard";
import { rolesFrom, textOf, titleOf } from "@fangorn/westmarch/roles";
import { browse, describe, facet, getRow, neighbors, search } from "@fangorn/westmarch/tools";

const VIEW = process.argv[2] ?? "http://localhost:8090";
configure({ resolveView: () => VIEW,
            // Roles are ready before the first row is parsed — see configure()'s
    // onManifests note. Deriving them after the load resolves parses every row
    // with empty text and search silently matches nothing.
    onManifests: (ms) => { roles = rolesFrom(ms); },
    rowText: (f) => textOf(f, roles) });

let roles = rolesFrom([], []);
const t0 = Date.now();
let shards = 0;
const rows = await loadShard(undefined, () => shards++);
roles = rolesFrom(domainManifests(), rows);
console.log(`shape: ${roles.declared ? "declared" : "sniffed"} — title=${roles.title} text=${roles.text} tags=${roles.tags}`);
console.log(`loaded ${rows.length} rows in ${Date.now() - t0}ms, ${shards} paints`);

const d = describe(rows);
console.log("vectors:", d.withVectors, "dim:", d.vectorDim, "owners:", d.owners);
console.log("fields:", d.fields.slice(0, 8).map((f) => `${f.name} ${f.pct}%`).join("  "));

for (const f of [...roles.tags, ...roles.subtitle, ...roles.spatial].slice(0, 4)) {
  const r = facet(rows, f, { limit: 4 });
  console.log(`facet ${f}: ${r.distinct} distinct, top =`, r.top.map((t) => `${t.value}(${t.count})`).join(" "));
}

const b = browse(rows, roles, { limit: 3 });
console.log("collections:", b.collections.map((c) => `${c.plural}(${c.count})`).join(" ") || "none");
if (b.collections.length) {
  const first = b.collections[0];
  const one = browse(rows, roles, { type: first.type, limit: 3 });
  console.log(`browse ${first.plural}: ${one.total} total, e.g.`, one.rows.map((r) => r.title));
}

const t1 = Date.now();
const hits = search(rows, process.argv[3] ?? "nuclear test footage", roles, { limit: 5 });
console.log(`lexical search ${Date.now() - t1}ms:`, hits.map((h) => `${h.title} [${h.score}]`));

const seed = rows.find((r) => r.vector);
const t2 = Date.now();
const n = neighbors(rows, seed.id, roles, { limit: 5 });
console.log(`neighbors of "${n.seed.title}" in ${Date.now() - t2}ms:`, n.near.map((x) => `${x.title} [${x.score}]`));

const g = getRow(rows, seed.id, roles);
console.log("get-row keys:", Object.keys(g).join(","), "| vector leaked:", "vector" in g);

// ── the stage: not a list about the answer, the answer ───────────────────────
//
// Everything above describes rows. This runs the surface a person is actually
// handed: a queue ordered by a taste, each item rendered in the shape its own
// publisher's declaration implies. Nothing here names a corpus, so the same
// three assertions hold for films, for games and for a bundle nobody has baked.
const { shapeOf, stage } = await import("@fangorn/westmarch/ui");
const { recommend, taste } = await import("@fangorn/westmarch/taste");

const shapes = new Map();
for (const r of rows) shapes.set(shapeOf(r, roles), (shapes.get(shapeOf(r, roles)) ?? 0) + 1);
console.log("shapes:", [...shapes].map(([k, n]) => `${k}(${n})`).join(" "));

const t = taste([{ id: seed.id, title: n.seed.title, vector: seed.vector }]);
const pool = rows.filter((r) => r.vector && r.id !== seed.id);
const picks = recommend(pool, t, { limit: 8 })
  .map((h) => ({ row: h.row, roles, corpus: roles.name ?? "corpus", why: `${h.score.toFixed(3)} · your taste` }));
const html = stage({ heading: `after "${n.seed.title}"`, note: `${pool.length} candidates`, picks });

const top = picks[0].row;
const src = (roles.media ?? []).map((f) => top[f]).find(Boolean) ?? top.url;
if (src && /^https?:/.test(src) && !html.includes(src)) throw new Error(`the stage must carry the publisher's own media url: ${src}`);
if (html.includes('"vector"') || html.includes("hasVector")) throw new Error("a vector must never reach the view");
if (!picks.every((p) => shapeOf(p.row, p.roles))) throw new Error("every queued row must have a shape");
console.log(`stage: ${picks.map((p) => shapeOf(p.row, p.roles)).join(",")} · ${(html.length / 1024).toFixed(1)} KB · plays ${String(src).slice(0, 72)}`);
