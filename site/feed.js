// The front page without a query: what is coming up and what just happened, one card per
// occasion (a meeting, an issue, an episode), from the roles the app declared. Nothing here
// knows what a row is: an occasion is the rows sharing a subtitle and a facet value, and
// its date is their temporal field.
import { pick, subtitleOf, titleOf, values } from "../src/core/roles.js";

/** The field a reader narrows by first: the app's declared facet, else the first tag with
 *  a handful of values (a town, not every body in every town). */
export function facetField(rows, roles) {
    const count = (f) => new Set(rows.slice(0, 5000).flatMap((r) => values(r[f] ?? ""))).size;
    return roles.facets?.[0] ?? roles.tags.find((f) => { const n = count(f); return n >= 2 && n <= 12; }) ?? null;
}

/** Occasions: `{ key, date, place, label, items }`, split into upcoming (soonest first) and
 *  past (latest first). Items repeat across an occasion's documents (its agenda, its
 *  minutes): one per title, the one that says what happened. */
export function occasions(rows, roles, { facet = null, only = null, today = new Date().toISOString().slice(0, 10) } = {}) {
    const groups = new Map();
    for (const r of rows) {
        const date = String(pick(r, roles.temporal) ?? "").slice(0, 10);
        if (!date) continue;
        const place = facet ? String(r[facet] ?? "") : "";
        if (only && place !== only) continue;
        const label = subtitleOf(r, roles) ?? "";
        const key = `${place}|${label}|${date}`;
        let g = groups.get(key);
        if (!g) groups.set(key, (g = { key, date, place, label, byTitle: new Map() }));
        const t = titleOf(r, roles), k = t.toLowerCase();
        const had = g.byTitle.get(k);
        if (!had || detail(had, roles).length < detail(r, roles).length) g.byTitle.set(k, r);
    }
    const all = [...groups.values()].map(({ byTitle, ...g }) => ({ ...g, items: [...byTitle.values()] }));
    return {
        upcoming: all.filter((g) => g.date > today).sort((a, b) => a.date.localeCompare(b.date) || a.place.localeCompare(b.place)),
        past: all.filter((g) => g.date <= today).sort((a, b) => b.date.localeCompare(a.date) || a.place.localeCompare(b.place)),
    };
}

/** What a row says beyond its title: its text, less the title it opens with. */
export function detail(r, roles) {
    const t = titleOf(r, roles), x = String(r.text ?? "");
    const rest = x.startsWith(t.replace(/\.$/, "")) ? x.slice(t.replace(/\.$/, "").length).replace(/^[.\s]+/, "") : x;
    return rest === t ? "" : rest.trim();
}

// ── self-check: `node site/feed.js` ──
if (typeof process !== "undefined" && process.argv[1]?.endsWith("/feed.js")) {
    const { rolesFrom } = await import("../src/core/roles.js");
    const roles = rolesFrom([{ role_map: { title: "heading", subtitle: "meeting", temporal: "date", tags: ["city", "body"], text: ["text"] },
                               presentation: { facets: ["city"] } }]);
    const row = (city, date, heading, text = heading) => ({ city, date, heading, meeting: `Board · ${date}`, body: "Board", text });
    const rows = [row("A", "2026-01-01", "Budget"), row("A", "2026-01-01", "Budget", "Budget. Approved 5-0."), row("A", "2026-01-01", "Roads"),
                  row("B", "2026-02-01", "Parks"), row("A", "2026-03-01", "Zoning"), { heading: "undated" }];
    const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)}`); };
    eq(facetField(rows, roles), "city", "the declared facet wins");
    const { upcoming, past } = occasions(rows, roles, { facet: "city", today: "2026-02-15" });
    eq(upcoming.map((g) => g.key), ["A|Board · 2026-03-01|2026-03-01"], "a future date is coming up");
    eq(past.map((g) => `${g.place}${g.date}`), ["B2026-02-01", "A2026-01-01"], "past, latest first");
    eq(past[1].items.map((r) => detail(r, roles)), ["Approved 5-0.", ""], "one item per title, the one that says what happened");
    eq(occasions(rows, roles, { facet: "city", only: "B", today: "2026-02-15" }).past.length, 1, "narrowed to one place");
    console.log("feed.js self-check ok — declared facet, upcoming vs past, one item per title keeping the decision, narrowed by place");
}
