// Five verbs over a corpus of rows. Nothing here knows what the rows ARE.
//
// That is the whole demonstration. sond3r's WebMCP surface has nineteen tools
// and most of them are television — capture a frame, program a channel, cut a
// montage. These five are what is left when you take the app out: describe the
// corpus, search it, pull one record, count a field, find neighbours. Point them
// at archival film and they answer questions about archival film; point them at
// an OSM export or a decade of notes and they answer about that, because a row
// is `{ id, ...fields, text, vector, norm }` and nothing below reads a field by
// name that the caller did not name.
//
// Pure functions, so `node tools.js` checks them with no browser and no network.

import { bestPassage, cosine, lexScore, norm, zFloor } from "./rank.js";
import { briefOf, collections, linkOf, subtitleOf, titleOf, typeOf, values } from "./roles.js";

/** Fields that are plumbing rather than content — never worth faceting or
 *  showing as "what this corpus holds". */
const PLUMBING = new Set(["text", "vector", "norm", "id", "owner", "embed"]);

/** A cheap, stable preview of a row for a tool result. The full record is one
 *  `get-row` away, and an agent that gets 50 full rows back has spent its whole
 *  context on one call.
 *
 *  It takes `roles` — the publisher's own declaration of which field is the
 *  title — rather than a list of field names. Hardcoding `name`/`path`/`desc`
 *  worked on the archive bundle and returned `{id, undefined, undefined}` on the
 *  first other dataset it saw. `fields` adds to that, it does not replace it. */
export const brief = (r, roles, fields = []) => {
    const out = briefOf(r, roles, fields);
    const link = linkOf(r, roles);
    return link ? { ...out, url: link } : out;
};

/**
 * What is in here at all — the call an agent makes first, before it knows the
 * shape of anything.
 *
 * Field coverage rather than a schema: these rows come off a publisher's own
 * bundle and nobody promised they are uniform. "`series` on 61% of rows" is the
 * fact an agent needs to decide whether faceting on it means anything, and a
 * declared schema would have said 100% and been wrong.
 */
export function describe(rows) {
    const counts = new Map();
    let vectors = 0, dim = 0;
    for (const r of rows) {
        if (r.vector) { vectors++; dim ||= r.vector.length; }
        for (const k of Object.keys(r)) {
            if (PLUMBING.has(k)) continue;
            if (r[k] == null || r[k] === "") continue;
            counts.set(k, (counts.get(k) ?? 0) + 1);
        }
    }
    return {
        rows: rows.length,
        // Search is only semantic for rows that carry one; the rest fall back to
        // lexical. An agent that gets nonsense from a query deserves to know which
        // half of the corpus it was searching.
        withVectors: vectors, vectorDim: dim,
        owners: [...new Set(rows.map((r) => r.owner).filter(Boolean))],
        fields: [...counts].sort((a, b) => b[1] - a[1])
            .map(([name, n]) => ({ name, on: n, pct: Math.round((100 * n) / (rows.length || 1)) })),
    };
}

/**
 * Rank rows against a query. Semantic where the row has a vector, lexical where
 * it doesn't, and the mode is reported per hit rather than hidden — degrading
 * silently is how "search stopped working" turns into an afternoon.
 *
 * `qv` is passed in, not computed: embedding is async and model-shaped, and
 * keeping it out here is what lets this file be a pure-function self-check.
 */
/** How much an exact word match adds to a cosine. Meaning alone ranks "wisconsin rapids"
 *  by what the towns have in common (every row is in Wisconsin), so an Eau Claire item
 *  about a bike ride "across Wisconsin" beat every Wisconsin Rapids one. The words decide
 *  among rows that mean about the same thing; they never outvote meaning outright.
 *  Measured on Quorum's eval (quorum/eval/search.mjs, 11k rows), top-5 precision / known @1:
 *  0 → towns 92%, topics 88%, @1 91%;  0.1 → 100/94/97;  0.15 → 100/98/98.5;  0.3 → 100/98/97. */
export const LEX_BOOST = 0.15;

// The words a row can be found by: its title, subtitle and tags, not only its prose.
// A town, a body or a kind lives in the tags, and "Plover" should find Plover's items.
const lexCache = new WeakMap();
const lexText = (r, roles) => {
    let t = lexCache.get(r);
    if (t === undefined) {
        t = [titleOf(r, roles), subtitleOf(r, roles) ?? "", ...(roles.tags ?? []).flatMap((f) => values(r[f] ?? "")), r.text ?? ""].join(" ");
        lexCache.set(r, t);
    }
    return t;
};

export function search(rows, query, roles, { qv = null, limit = 10, fields, where, lexBoost = LEX_BOOST } = {}) {
    const ql = query.trim().toLowerCase();
    if (!ql) return [];
    const qn = qv ? norm(qv) : 1;
    // Filtered BEFORE scoring, so the z-floor is measured over the rows that
    // could actually be returned. "sad songs before 1970" floored against the
    // whole corpus admits whatever the corpus is mostly about; floored against
    // pre-1970 rows it separates the sad ones from the rest of that shelf.
    // This is the difference between a search that composes and one that only
    // ever answers the question the way it was asked.
    if (where) rows = rows.filter((r) => matches(r, where));
    const scored = rows.map((r) => (qv && r.vector
        ? { r, score: cosine(r, qv, qn) + (lexBoost ? lexBoost * lexScore({ text: lexText(r, roles) }, ql) : 0), mode: "semantic" }
        : { r, score: lexScore({ text: lexText(r, roles) }, ql), mode: "lexical" }));
    // The floor is per QUERY over the whole corpus, so it is measured before
    // anything is dropped. Raw cosine is offset per query, not per corpus: on this
    // catalog every row scores 0.38–0.65 against anything, and `score > 0` admits
    // all 42,215 of them in confident-looking order.
    const sem = scored.filter((x) => x.mode === "semantic").map((x) => x.score);
    // The best semantic row always survives its own floor. On a big corpus the
    // floor never touches it; on a small one it does — three rows where one is an
    // exact match put the mean so high that the floor lands ABOVE the match, and
    // the corpus answers a question it can answer with nothing at all.
    const floor = Math.min(zFloor(sem), sem.length ? Math.max(...sem) : Infinity);
    return scored
        .filter((x) => (x.mode === "semantic" ? x.score >= floor : x.score > 0))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map(({ r, score, mode }) => ({ ...brief(r, roles, fields), score: Number(score.toFixed(4)), mode }));
}

/**
 * Does a row match every `{field: value}` in `where`?
 *
 * Case-insensitive on purpose. An agent that reads `top: ["comedy"]` off a facet
 * and passes "Comedy" back gets an empty result and no idea why — and one bundle
 * here mixes cases across fields (`genre` lowercase, `subject` title case).
 * Matching is still exact on the WHOLE value, so "comedy" never matches "dark
 * comedy": near-misses are the trap, not near-matches.
 *
 * Shared by facet and browse deliberately. Two copies of a filter that drifted
 * would make "count the Events" and "list the Events" disagree, which is the
 * kind of bug nobody reports because both answers look plausible.
 */
export const matches = (row, where) => !where || Object.entries(where).every(([k, v]) =>
    values(row[k] ?? "").some((x) => x.toLowerCase() === String(v).toLowerCase()));

/**
 * Count a field's values. The verb that makes a corpus legible without reading
 * it — "how many events per season", "which decades", "who published what".
 *
 * Multi-valued fields are split by `values()` in roles.js, which is also what
 * shapes a preview's tags: one definition, so "count the Summer events" and
 * "list the Summer events" cannot disagree about what a Summer event is.
 */
export function facet(rows, field, { limit = 20, where } = {}) {
    const counts = new Map();
    let missing = 0;
    for (const r of rows) {
        if (!matches(r, where)) continue;
        const raw = r[field];
        if (raw == null || raw === "") { missing++; continue; }
        for (const v of values(raw)) counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    const sorted = [...counts].sort((a, b) => b[1] - a[1]);
    return {
        field, distinct: counts.size, missing,
        top: sorted.slice(0, limit).map(([value, count]) => ({ value, count })),
    };
}

/**
 * List a collection, with no query at all.
 *
 * The most basic thing anyone does with a storefront — "show me what's here" —
 * and the only one the other four verbs cannot do: `search` needs a query,
 * `similar-rows` needs a seed id you can only get from a search, and `facet`
 * returns counts rather than rows. Without this an agent's first move on an
 * unfamiliar corpus has to be a guess.
 *
 * `sort` names a field; rows that have it come first, ordered numerically where
 * both values parse as numbers and lexically otherwise, because a bundle's
 * `rating` is the string "4.7" and sorting that as text puts "10" below "9".
 */
export function browse(rows, roles, { type, where, sort, desc = true, limit = 20, offset = 0, fields } = {}) {
    let hits = rows.filter((r) => (!type || typeOf(r)?.toLowerCase() === String(type).toLowerCase()) && matches(r, where));
    const total = hits.length;
    if (sort) {
        const num = (v) => (v == null || v === "" ? null : Number(v));
        hits = [...hits].sort((a, b) => {
            const [x, y] = [a[sort], b[sort]];
            if ((x == null || x === "") !== (y == null || y === "")) return x == null || x === "" ? 1 : -1;
            const [nx, ny] = [num(x), num(y)];
            const c = Number.isFinite(nx) && Number.isFinite(ny) ? nx - ny : String(x ?? "").localeCompare(String(y ?? ""));
            return desc ? -c : c;
        });
    }
    return {
        total, offset, returned: Math.min(limit, Math.max(0, total - offset)),
        collections: type ? undefined : collections(roles, rows).map((c) => ({ type: c.type, plural: c.plural, count: c.count })),
        rows: hits.slice(offset, offset + limit).map((r) => brief(r, roles, fields)),
    };
}

/** Rows nearest a given row, by vector. "More like this", with no query to
 *  write — which is how an agent explores a corpus whose vocabulary it doesn't
 *  know yet. Returns nothing (not an error) for a row with no vector. */
export function neighbors(rows, id, roles, { limit = 10, fields } = {}) {
    const seed = rows.find((r) => r.id === id);
    if (!seed?.vector) return { seed: seed ? brief(seed, roles, fields) : null, near: [] };
    const qn = seed.norm;
    return {
        seed: brief(seed, roles, fields),
        near: rows
            .filter((r) => r.id !== id && r.vector)
            .map((r) => ({ r, score: cosine(r, seed.vector, qn) }))
            .sort((a, b) => b.score - a.score)
            .slice(0, limit)
            .map(({ r, score }) => ({ ...brief(r, roles, fields), score: Number(score.toFixed(4)) })),
    };
}

/** One row, whole. Deliberately the only verb that returns everything — the
 *  others preview, so an agent chooses when to spend its context. */
export function getRow(rows, id, roles) {
    // id first, then whatever the publisher calls a title — an agent that read a
    // title off a search result and passed it back must land on the same row.
    if (!id) return null;   // else `x.path === undefined` matches the first row lacking one
    // A view built from commits keys rows by vertex CID, so the publisher's own id
    // (the declared identity field) has to find them too.
    const r = rows.find((x) => x.id === id)
        ?? (roles?.identity ? rows.find((x) => String(x[roles.identity]) === String(id)) : null)
        ?? rows.find((x) => x.path === id || x.name === id || titleOf(x, roles) === id);
    if (!r) return null;
    const { vector, norm: _n, ...rest } = r;
    return { ...rest, hasVector: !!vector, vectorDim: vector?.length ?? 0 };
}

// ── self-check: `node tools.js` — no browser, no network ────────────────────
if (typeof process !== "undefined" && import.meta.url === `file://${process.argv[1]}` && process.argv[1].endsWith("/tools.js")) {
    const { rolesFrom } = await import("./roles.js");
    const row = (id, fields, vector) => ({
        id, owner: "0xa", ...fields,
        text: [fields.name, fields.desc].filter(Boolean).join(" "),
        vector: vector ?? null, norm: vector ? norm(vector) : 1,
    });
    const rows = [
        row("1", { name: "Duet S01E02", series: "Duet", year: "1987", subject: "['Sitcom', 'Comedy']", desc: "a forgotten fox sitcom" }, [1, 0, 0]),
        row("2", { name: "Duet S01E03", series: "Duet", year: "1987", subject: "['Sitcom']", desc: "more of the same sitcom" }, [0.99, 0.1, 0]),
        row("3", { name: "Atomic Cafe", series: "", year: "1982", subject: "['Documentary', 'Cold War']", desc: "nuclear test footage" }, [0, 1, 0]),
        row("4", { name: "untitled reel", year: "1954" }), // no vector, no desc — the ragged half of a real bundle
    ];

    // The sniffed roles for this fixture: no manifest, so title falls to `name`
    // and prose to `desc` — the same path the archive bundle takes.
    const roles = rolesFrom([], rows);
    if (roles.title[0] !== "name") throw new Error(`fixture roles wrong: ${roles.title}`);

    // describe: coverage, not a schema. `series` is empty on two rows and absent
    // on one, and saying 100% would be a lie an agent would act on.
    const d = describe(rows);
    if (d.rows !== 4 || d.withVectors !== 3 || d.vectorDim !== 3) throw new Error("describe lost the corpus shape");
    const series = d.fields.find((f) => f.name === "series");
    if (series.on !== 2 || series.pct !== 50) throw new Error(`empty strings must not count as coverage: ${JSON.stringify(series)}`);
    if (d.fields.some((f) => PLUMBING.has(f.name))) throw new Error("plumbing fields must not be offered as content");
    if (d.owners.join() !== "0xa") throw new Error("owners lost");

    // search: semantic where there is a vector, and the z-floor keeps the corpus
    // from answering every query with all of itself.
    let hits = search(rows, "sitcom", roles, { qv: [1, 0, 0], limit: 10 });
    if (hits[0].id !== "1" || hits[0].title !== "Duet S01E02") throw new Error(`semantic: wrong top hit ${hits[0]?.id}`);
    if (hits[0].mode !== "semantic") throw new Error("mode must be reported, not inferred");
    if (hits.some((h) => h.id === "3")) throw new Error(`the z-floor must drop the unrelated row: ${JSON.stringify(hits)}`);
    // A small corpus where one row matches exactly: the mean sits so high that a
    // raw z-floor lands above the match and search answers nothing. The best row
    // survives its own floor.
    const tiny = [rows[0], rows[1], rows[2]];
    if (!search(tiny, "sitcom", roles, { qv: [1, 0, 0] }).length) throw new Error("an exact match must never be filtered out by its own floor");
    // …and lexical when no query vector could be made (the embedder failed).
    hits = search(rows, "nuclear", roles, { limit: 10 });
    if (hits[0]?.id !== "3" || hits[0].mode !== "lexical") throw new Error("must degrade to lexical, and say so");
    if (search(rows, "  ", roles).length) throw new Error("an empty query must return nothing, not everything");
    // A row with no vector is still findable — it is half a real bundle.
    if (search(rows, "untitled reel", roles)[0]?.id !== "4") throw new Error("a vectorless row must still be searchable lexically");

    // facet: the verb that makes a corpus legible. Stringified lists are what
    // archive.org's `subject` actually looks like; faceting the whole string
    // answers a question nobody asked.
    const f = facet(rows, "subject");
    if (f.top[0].value !== "Sitcom" || f.top[0].count !== 2) throw new Error(`list-ish values must split: ${JSON.stringify(f.top)}`);
    if (f.missing !== 1) throw new Error("a field absent from a row must be counted missing, not skipped silently");
    if (facet(rows, "year").distinct !== 3) throw new Error("plain values must not be split");
    // The other form the same bundle uses: a bare comma-joined list.
    if (values("Sitcom,Comedy,Fox").length !== 3) throw new Error("a machine-joined list must split");
    // …and prose that merely contains a comma must not. A creator credit split
    // into "Wilson" and "Michael G." is a wrong answer, not a formatting quirk.
    if (values("Wilson, Michael G.").length !== 1) throw new Error("a comma followed by a space is prose, not a list");
    if (values("1987").length !== 1) throw new Error("a plain value must stay whole");
    // where: the drill-down. "Which years, among sitcoms."
    const w = facet(rows, "year", { where: { subject: "Sitcom" } });
    if (w.distinct !== 1 || w.top[0].value !== "1987") throw new Error(`where must narrow the facet: ${JSON.stringify(w.top)}`);
    // Case is the trap: this corpus has `genre` lowercase and `subject` title
    // case, and an agent that echoes a value back with the wrong case gets an
    // empty result and no clue why.
    if (facet(rows, "year", { where: { subject: "sitcom" } }).distinct !== 1) throw new Error("where must match case-insensitively");
    // …but still on the WHOLE value. A substring match would make "comedy" count
    // every "dark comedy" row and quietly inflate every answer.
    if (facet(rows, "year", { where: { subject: "Sit" } }).distinct !== 0) throw new Error("where must match whole values, not substrings");

    // browse: "show me what's here", the one thing no other verb does.
    const bAll = browse(rows, roles, { limit: 2 });
    if (bAll.total !== 4 || bAll.rows.length !== 2) throw new Error(`browse must page: ${JSON.stringify(bAll)}`);
    // A corpus whose rows declare no type has no collections — an empty list,
    // which a caller can render as "no groupings", not undefined.
    if (bAll.collections.length !== 0) throw new Error("a typeless corpus must report zero collections, not invent one");
    if (browse(rows, roles, { offset: 3 }).rows.length !== 1) throw new Error("offset must page to the tail");
    if (browse(rows, roles, { offset: 99 }).rows.length !== 0) throw new Error("an offset past the end must be empty, not wrapped");
    // Typed browse, case-insensitively — same trap as `where`.
    const typed = rows.map((r) => ({ ...r, entityType: r.id === "3" ? "Film" : "Episode" }));
    const grouped = browse(typed, roles, { limit: 1 }).collections;
    if (grouped.map((c) => `${c.type}:${c.count}`).join() !== "Episode:3,Film:1") throw new Error(`collections must count and sort: ${JSON.stringify(grouped)}`);
    if (browse(typed, roles, { type: "film" }).total !== 1) throw new Error("type must match case-insensitively");
    if (browse(typed, roles, { type: "film" }).collections !== undefined) throw new Error("a typed browse is already inside a collection");
    // where and type compose, through the same matcher facet uses.
    if (browse(typed, roles, { type: "Episode", where: { year: "1987" } }).total !== 2) throw new Error("browse must honour where");
    // Numeric sort on a string field: "10" must not land below "9".
    const nums = [{ id: "a", rating: "9" }, { id: "b", rating: "10" }, { id: "c" }];
    const sorted = browse(nums, roles, { sort: "rating" }).rows.map((r) => r.id);
    if (sorted.join() !== "b,a,c") throw new Error(`numeric sort + missing-last wrong: ${sorted}`);
    if (browse(nums, roles, { sort: "rating", desc: false }).rows[0].id !== "a") throw new Error("ascending sort ignored");

    // neighbors: explore without knowing the vocabulary.
    const n = neighbors(rows, "1", roles);
    if (n.near[0].id !== "2") throw new Error("nearest neighbour missed the near-identical row");
    if (n.near.some((x) => x.id === "1")) throw new Error("a row must not be its own neighbour");
    if (n.near.some((x) => x.id === "4")) throw new Error("a vectorless row cannot be a neighbour");
    if (neighbors(rows, "4", roles).near.length) throw new Error("a vectorless seed must return nothing, not throw");
    if (neighbors(rows, "nope", roles).seed !== null) throw new Error("an unknown seed must be null, not undefined");

    // getRow: the only verb that returns everything, and never the raw vector —
    // 256 floats of JSON in an agent's context buys it nothing.
    const g = getRow(rows, "3", roles);
    if (g.name !== "Atomic Cafe" || !g.hasVector || g.vectorDim !== 3) throw new Error("getRow lost the record");
    if ("vector" in g || "norm" in g) throw new Error("the raw vector must never reach a tool result");
    if (getRow(rows, "nope", roles) !== null) throw new Error("an unknown id must be null");

    // brief truncates, so fifty hits cannot spend a whole context window.
    const long = brief(row("x", { name: "n", categories: "d".repeat(500) }), rolesFrom([{ role_map: { title: "name", tags: ["categories"] } }]));
    if (long.categories.length > 200) throw new Error("brief must truncate a long field");
    if (long.title !== "n") throw new Error("brief must title from the declared field");

    // Semantic search that composes with a filter. Without this, "like X but only
    // Y" is two calls and a join the caller has to do by hand.
    {
        const pool = [
            { id: "a", name: "cold war thriller", year: 1965, vector: [1, 0], norm: 1 },
            { id: "b", name: "cold war comedy", year: 1999, vector: [1, 0], norm: 1 },
            { id: "c", name: "beach party", year: 1964, vector: [0, 1], norm: 1 },
            { id: "d", name: "surf movie", year: 1966, vector: [0, 1], norm: 1 },
        ];
        const rl = { title: ["name"], subtitle: [], tags: [], text: ["name"], measures: [], fields: ["year"] };
        const all = search(pool, "cold war", rl, { qv: [1, 0], limit: 10 });
        if (!all.some((h) => h.title === "cold war comedy")) throw new Error("unfiltered search must see every era");
        const old60s = search(pool, "cold war", rl, { qv: [1, 0], limit: 10, where: { year: 1965 } });
        if (old60s.length !== 1 || old60s[0].title !== "cold war thriller") throw new Error(`where must narrow a semantic search: ${JSON.stringify(old60s)}`);
        // …and the floor is computed inside the filter, not outside it.
        const surf = search(pool, "cold war", rl, { qv: [0, 1], limit: 10, where: { year: 1964 } });
        if (surf[0]?.title !== "beach party") throw new Error("the floor must be measured over the filtered rows");
    }

    // The shape callers must code against. kingsfoil's agent surface read
    // `search(...).hits` and returned [] for every query — silently, because
    // undefined ?? [] is a valid empty result. Pin it.
    {
        const pool = [{ id: "a", name: "cold war thriller", vector: [1, 0], norm: 1 }];
        const rl = { title: ["name"], subtitle: [], tags: [], text: ["name"], measures: [], fields: [] };
        const out = search(pool, "cold war", rl, { qv: [1, 0], limit: 5 });
        if (!Array.isArray(out)) throw new Error("search must return a flat array, not {hits}");
        if (out[0].score === undefined || out[0].mode === undefined) throw new Error("search rows carry score+mode");
        // A missing id must not match the first row lacking `path`/`name`.
        for (const bad of [undefined, null, ""]) {
            if (getRow(pool, bad, rl) !== null) throw new Error(`getRow(${JSON.stringify(bad)}) must be null`);
        }
    }

    console.log("tools.js self-check ok — coverage not schema, semantic/lexical modes + z-floor, list-ish facets + where, neighbours, whole-row fetch, previews truncate");
}
