// The thing one corpus cannot do.
//
// Four independent publishers, no shared ids and no shared schema, open in one
// session. One question goes to all of them; one taste built from films ranks
// games and places it has never seen. This is the same code path the WebMCP
// verbs take with corpus:"*" — `session()` from consume/corpora.js holding the
// parsed corpora, `merge()` collapsing their hit lists onto one scale.
//
// Serve the fixtures first:  npx vite --port 5180
import { configure, domainManifests, loadShard } from "@fangorn/westmarch/shard";
import { merge, session } from "@fangorn/westmarch/corpora";
import { rolesFrom, textOf, titleOf } from "@fangorn/westmarch/roles";
import { recommend, taste } from "@fangorn/westmarch/taste";
import { EMBED_MODEL, embedQuery } from "@fangorn/westmarch/embed";
import { findCorpora } from "@fangorn/westmarch/directory";
import { rankedList, uiResource } from "@fangorn/westmarch/ui";
import { brief, search } from "@fangorn/westmarch/tools";

const BASE = process.env.BASE ?? "http://localhost:5180";
const NAMES = ["archive-films", "archive-transcripts", "games", "places"];
const SOURCES = NAMES.map((d) => `${BASE}/${d}`);

const S = session({ blankRoles: () => rolesFrom([], []) });
configure({
    onManifests: (ms, view) => { const c = S.slot(view); c.roles = rolesFrom(ms); c.name = ms[0]?.name ?? c.name; },
    rowText: (f, view) => textOf(f, S.slot(view).roles),
});

// ── open all four, additively ───────────────────────────────────────────────
console.log("── open-corpus × 4 (nothing is closed in between) ───────────────");
for (const view of SOURCES) {
    const c = S.slot(view);
    c.rows = await loadShard(view);
    c.roles = rolesFrom(domainManifests(view), c.rows);
    c.name = domainManifests(view)[0]?.name ?? view;
    S.focus = view;
    console.log(`  ${c.name.padEnd(21)} ${String(c.rows.length).padStart(6)} rows  · text role: ${c.roles.text.join("+") || "—"}`);
}
console.assert(S.loaded().length === 4, "all four must stay open");
console.assert(new Set(S.loaded().map((c) => c.roles.text.join("+"))).size > 1,
    "the corpora must NOT share a text role — if they did, per-view rowText would be untested");

// ── one question, every publisher ───────────────────────────────────────────
const Q = process.argv[2] ?? "surviving a frozen wasteland";
console.log(`\n── search-corpus  corpus:"*"  "${Q}" ───────────────`);
const qv = await embedQuery(Q);
const hits = merge(S.span("*").map((c) => ({
    name: c.name,
    hits: search(c.rows, Q, c.roles, { qv, limit: 6 }),
})), { limit: 10 });
for (const h of hits) console.log(`  ${h.score.toFixed(4)}  ${String(h.corpus).padEnd(21)} ${h.title}`);
console.assert(new Set(hits.map((h) => h.corpus)).size > 1,
    "a spanning search that returns one publisher's rows has not proven anything");

// …and the directory would have sent you to just one of them.
const dir = await findCorpora(Q, { sources: SOURCES, embed: embedQuery, model: EMBED_MODEL });
console.log(`  (find-corpora alone would have opened only "${dir.corpora[0].domain}")`);

// ── a taste built in one corpus, ranking the others ─────────────────────────
console.log(`\n── note-taste in films → recommend corpus:"*" ───────────────`);
const films = S.at("archive-films");
const seeds = search(films.rows, "bleak post-apocalyptic survival after a disaster", films.roles, {
    qv: await embedQuery("bleak post-apocalyptic survival after a disaster"), limit: 4,
});
const liked = seeds.map((h) => {
    const r = films.rows.find((x) => x.id === h.id);
    return { id: r.id, title: titleOf(r, films.roles), vector: r.vector };
});
console.log(`  liked: ${liked.map((l) => l.title).join(" · ")}`);
const t = taste(liked, []);
const ids = new Set(liked.map((l) => l.id));
const recs = merge(S.span("*").filter((c) => c.name !== "archive-films").map((c) => ({
    name: c.name,
    hits: recommend(c.rows, t, { limit: 5, exclude: ids }).map((h) => ({ ...brief(h.row, c.roles), score: h.score })),
})), { limit: 8 });
for (const r of recs) console.log(`  ${r.score.toFixed(4)}  ${String(r.corpus).padEnd(21)} ${r.title}`);
console.assert(recs.length && new Set(recs.map((r) => r.corpus)).size > 1,
    "the taste must reach more than one foreign corpus");

// ── the view a host would render, generated from the publishers' role_maps ──
const res = uiResource(rankedList({
    heading: `search “${Q}”`,
    note: `${hits.length} hits across ${S.loaded().length} publishers`,
    hits, roles: S.at("games").roles,
}), "search-corpus");
console.assert(res.resource.uri.startsWith("ui://"), "must be a ui:// resource");
for (const h of hits) console.assert(res.resource.text.includes(h.title.replace(/&/g, "&amp;")), `view dropped a hit: ${h.title}`);
if (process.env.WRITE_UI) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(process.env.WRITE_UI, res.resource.text);
    console.log(`\n  wrote the rendered view to ${process.env.WRITE_UI} (${res.resource.text.length}B, uri ${res.resource.uri})`);
}

console.log("\ncross.mjs ok — four publishers open at once, one query ranked across all of them, "
    + "one taste carried into corpora that share nothing with its source but a model, rendered as a ui:// view");
