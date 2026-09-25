// The map view (#/map/<query>/<region>, both optional): the app's records on its regions (a state's counties), for
// an app that ships a map.json:
//
//   { "width": 600, "height": 640, "paths": { "<region>": "<svg path d>" },
//     "field": "county",                        // the record field that names a region
//     "places": { "<facet value>": "<region>" } // for records without it: a town's county
//   }
//
// Without a query it is coverage: regions shaded by how many records they hold, of every kind
// or of one (the chips). With one, by how many search hits fall in each, so
// "data center" lights up where it is being talked about. A region's panel breaks its
// records down by type and tag, lists them, and names the regions whose records read most
// alike (the mean of their embeddings, centered on the app's own mean so boilerplate every
// region shares does not make them all look the same).
import { typeOf, values } from "../consume/roles.js";
import { search } from "../consume/tools.js";

const SVG = "http://www.w3.org/2000/svg";
const svg = (tag, attrs = {}) => { const e = document.createElementNS(SVG, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };
const fmt = (n) => n.toLocaleString();
const SKIP_TAGS = new Set(["state"]);

export function createMap(geo, { el, show, row, placeOf, ctx }) {
    const R = ctx.roles, names = Object.keys(geo.paths);
    let cache = null, sel = null, typeOnly = null, last = { q: "", hits: null };

    // Per-row regions, the main type, and each region's centroid: recomputed when rows change.
    function index() {
        if (cache?.n === ctx.rows.length) return cache;
        const regionsOf = ctx.rows.map((r) => {
            const v = values(r[geo.field] ?? "").filter((x) => geo.paths[x]);
            return v.length ? v : [geo.places?.[placeOf(r)]].filter(Boolean);
        });
        const types = new Map();
        for (const r of ctx.rows) { const t = typeOf(r); types.set(t, (types.get(t) ?? 0) + 1); }
        const main = [...types].sort((a, b) => b[1] - a[1])[0]?.[0];
        const by = new Map(names.map((n) => [n, []]));
        ctx.rows.forEach((r, i) => { for (const g of regionsOf[i]) by.get(g)?.push(i); });
        // Centroids of the main type's unit vectors, less the overall mean.
        let dim = 0, all = null, n = 0;
        const sums = new Map();
        ctx.rows.forEach((r, i) => {
            if (!r.vector || typeOf(r) !== main || !regionsOf[i].length) return;
            dim ||= r.vector.length; all ??= new Float64Array(dim);
            const k = 1 / (r.norm || Math.hypot(...r.vector) || 1);
            for (const g of regionsOf[i]) {
                const s = sums.get(g) ?? { v: new Float64Array(dim), n: 0 };
                for (let j = 0; j < dim; j++) s.v[j] += r.vector[j] * k;
                s.n++; sums.set(g, s);
            }
            for (let j = 0; j < dim; j++) all[j] += r.vector[j] * k;
            n++;
        });
        const centroid = new Map();
        for (const [g, s] of sums) {
            if (s.n < 20) continue;   // ponytail: too few records to say what a region is like
            const c = s.v.map((x, j) => x / s.n - all[j] / n), len = Math.hypot(...c) || 1;
            centroid.set(g, c.map((x) => x / len));
        }
        cache = { n: ctx.rows.length, regionsOf, by, main, types, centroid };
        return cache;
    }

    function alike(g) {
        const { centroid } = index(), c = centroid.get(g);
        if (!c) return [];
        return [...centroid].filter(([h]) => h !== g)
            .map(([h, d]) => ({ region: h, score: d.reduce((s, x, j) => s + x * c[j], 0) }))
            .sort((a, b) => b.score - a.score).slice(0, 5);
    }

    const label = (t, n = 2) => { const p = R.types?.[t]; return (n === 1 ? p?.singular : p?.plural) ?? t ?? "Records"; };
    const icon = (t) => R.types?.[t]?.icon ?? "";

    // Counts per region: every record, or the query's hits (of one type, if chosen).
    function counts(hitIdx) {
        const { regionsOf } = index(), out = new Map();
        const each = hitIdx ?? ctx.rows.map((_, i) => i);
        for (const i of each) {
            if (typeOnly && typeOf(ctx.rows[i]) !== typeOnly) continue;
            for (const g of regionsOf[i]) out.set(g, (out.get(g) ?? 0) + 1);
        }
        return out;
    }

    // As the search page does: words at once, meaning when the model has loaded (the first
    // query downloads it), then drawn again.
    async function hitsFor(q) {
        if (!q) return null;
        if (last.q === q && last.hits) return last.hits;
        const vec = ctx.queryVector(q);
        const qv = await Promise.race([vec, new Promise((ok) => setTimeout(() => ok(undefined), 400))]);
        if (qv === undefined) vec.then((v) => { if (v && last.q === q && !last.meaning) { last = { q, hits: find(q, v), meaning: true }; render(q, sel); } });
        last = { q, hits: find(q, qv ?? null), meaning: qv !== undefined };
        return last.hits;
    }
    function find(q, qv) {
        const at = new Map(ctx.rows.map((r, i) => [r.id, i]));
        return search(ctx.rows, q, R, { qv, limit: 600 }).map((h) => at.get(h.id)).filter((i) => i != null);
    }

    // The view is its URL: a query and a selected region, shareable.
    const go = (q, g = sel) => { location.hash = `#/map/${encodeURIComponent(q)}${g ? `/${encodeURIComponent(g)}` : ""}`; };

    async function render(q = "", g = null) {
        sel = g && geo.paths[g] ? g : null;
        const hits = await hitsFor(q);
        const n = counts(hits), max = Math.max(1, ...n.values());
        // Five steps; coverage on a log scale (counts run from tens to thousands).
        const step = (x) => (!x ? 0 : Math.min(5, 1 + Math.floor((hits ? x / max : Math.log10(x) / Math.log10(max)) * 4.999)));
        const near = sel ? new Set(alike(sel).map((a) => a.region)) : new Set();

        const map = svg("svg", { viewBox: `0 0 ${geo.width} ${geo.height}`, role: "img", "aria-label": hits ? `Map: where “${q}” comes up` : "Map: where records are", class: "map" });
        for (const g of names) {
            const p = svg("path", { d: geo.paths[g], class: `h${step(n.get(g) ?? 0)}${g === sel ? " on" : ""}${near.has(g) ? " near" : ""}`, tabindex: 0,
                "aria-label": `${g}: ${fmt(n.get(g) ?? 0)}` });
            p.append(svg("title")); p.firstChild.textContent = `${g} · ${fmt(n.get(g) ?? 0)} ${hits ? "matching" : (typeOnly ? label(typeOnly) : "records").toLowerCase()}`;
            const pick = () => go(q, sel === g ? null : g);
            p.addEventListener("click", pick);
            p.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); } });
            map.append(p);
        }

        const box = el("input", { type: "search", value: q, placeholder: "Search the map: data center, PFAS, solar rezoning…", "aria-label": "Search the map" });
        box.addEventListener("keydown", (e) => { if (e.key === "Enter") go(box.value.trim()); });

        // Type chips: the records (or what the query found) by kind; one kind at a time on the map.
        const found = hits ? new Map() : index().types;
        for (const i of hits ?? []) { const t = typeOf(ctx.rows[i]); found.set(t, (found.get(t) ?? 0) + 1); }
        const typeChips = found.size > 1 || hits ? el("div", { className: "chips" }, [[null, hits?.length ?? ctx.rows.length], ...found].map(([t, c]) =>
            el("button", { type: "button", className: t === typeOnly ? "chip on" : "chip", onclick: () => { typeOnly = t; render(q, sel); } },
                `${t ? `${icon(t)} ${label(t, c)}` : "All"} (${fmt(c)})`))) : null;

        const covered = names.filter((g) => n.get(g)).length;
        const summary = hits
            ? `“${q}”: ${fmt([...n.values()].reduce((a, b) => a + b, 0))} matches in ${covered} of ${names.length} regions. Darker is more.${last.meaning ? "" : " (Matching words; search by meaning is loading.)"}`
            : `${typeOnly ? label(typeOnly) : "Records"} in ${covered} of ${names.length} regions. Select a region, or search.`;

        show(el("div", { className: "mapbar" }, box), typeChips, el("p", { className: "hint" }, summary),
            el("div", { className: "mapwrap" }, map, el("aside", { className: "panel" }, panel(sel, q, hits))),
            el("p", { className: "hint" }, "Legend: ", [0, 1, 2, 3, 4, 5].map((s) => el("span", { className: `sw h${s}` })), hits ? " none → most matches" : " none → most records"));
    }

    function panel(g, q, hits) {
        if (!g) return [el("h3", {}, "Select a region"), el("p", { className: "hint" }, "Its records by kind and tag, the ones that match, and the regions most like it.")];
        const { by } = index();
        const inRegion = new Set(by.get(g));
        const idx = (hits ? hits.filter((i) => inRegion.has(i)) : [...inRegion]).filter((i) => !typeOnly || typeOf(ctx.rows[i]) === typeOnly);
        const rows = idx.map((i) => ctx.rows[i]);
        // By kind.
        const kinds = new Map();
        for (const r of rows) { const t = typeOf(r); kinds.set(t, (kinds.get(t) ?? 0) + 1); }
        // Tags: each tag field's commonest values here, as chips that search the map for them.
        const tags = (R.tags ?? []).filter((f) => f !== geo.field && !SKIP_TAGS.has(f)).map((f) => {
            const c = new Map();
            for (const r of rows) for (const v of values(r[f] ?? "")) c.set(v, (c.get(v) ?? 0) + 1);
            return [f, [...c].sort((a, b) => b[1] - a[1]).slice(0, 6)];
        }).filter(([, top]) => top.length > 1);
        // The list: matches in score order, or the newest records.
        const date = (r) => String(r[R.temporal?.[0]] ?? "");
        const list = (hits ? rows : rows.slice().sort((a, b) => date(b).localeCompare(date(a)))).slice(0, 25);
        const like = alike(g);
        return [
            el("h3", {}, g, " ", el("button", { type: "button", className: "linkish", "aria-label": "Close", onclick: () => go(q, null) }, "✕")),
            el("p", { className: "hint" }, [...kinds].map(([t, c]) => `${icon(t)} ${fmt(c)} ${label(t, c).toLowerCase()}`).join(" · ") || "Nothing here" + (hits ? " matches." : " yet.")),
            like.length ? el("div", { className: "chips" }, el("small", { title: "Regions whose records are closest in meaning; outlined on the map" }, "Reads most like: "),
                like.map(({ region }) => el("button", { type: "button", className: "chip", onclick: () => go(q, region) }, region))) : null,
            tags.map(([f, top]) => el("div", { className: "chips" }, el("small", {}, `${f.replace(/_/g, " ")}: `),
                top.map(([v, c]) => el("button", { type: "button", className: "chip", title: `Search the map for “${v}”`, onclick: () => go(v) }, `${v} (${c})`)))),
            list.length ? el("ul", { className: "list" }, list.map((r) => row(r))) : null,
            rows.length > list.length ? el("p", { className: "hint" }, `${fmt(rows.length - list.length)} more. `,
                el("a", { href: `#/search/${encodeURIComponent(q || g)}` }, "Open in search")) : null,
        ];
    }

    return { render };
}
