// Several corpora, open at once.
//
// Everything else in consume/ answers a question about ONE bundle. This holds
// the set, and it exists because the interesting questions are the ones a single
// publisher cannot answer: rank these games by a taste built from those films,
// find this place near that event. Two publishers who have never heard of each
// other, joined by nothing but the embedding model they both used.
//
// shard.js already caches rows and manifests per view, so nothing here fetches.
// What was missing was somewhere for a consumer to keep the PARSED result of
// more than one view — rows plus the roles they were parsed with, which differ
// per publisher and must not be shared.
//
// ponytail: a Map and three lookups, no eviction. Corpora are tens of megabytes
// each and a person opens a handful; when a session holds enough of them to
// matter, drop the least recently focused — the map is already keyed for it.

import { trimView } from "./shard.js";

/**
 * A set of open corpora, and the vocabulary for naming one.
 *
 * `blankRoles` is injected rather than imported so this file does not depend on
 * roles.js — a consumer that parses rows some other way still gets the session.
 */
export function session({ blankRoles = () => ({}) } = {}) {
    const map = new Map();   // view → { view, name, rows, roles, stats }
    let focus = null;

    /** The record for a view, created empty on first mention. Called from the
     *  manifest hook, which fires before any row exists. */
    const slot = (viewIn) => {
        const view = trimView(viewIn);
        let c = map.get(view);
        if (!c) map.set(view, c = { view, name: null, rows: [], roles: blankRoles(), stats: { shards: 0, ms: 0, started: 0 } });
        return c;
    };

    /** Corpora that can actually answer something. A slot exists from the moment
     *  its manifests land, which is well before its rows have arrived. */
    const loaded = () => [...map.values()].filter((c) => c.rows.length);

    /**
     * The corpus a caller named — by domain name, view URL, or a fragment of
     * either. Unnamed (or "*") means whichever is focused.
     *
     * A miss LISTS what is open instead of saying "not found". An agent that
     * asked for `films` when the corpus is called `archive-films` needs the real
     * names back; told only that it failed, it tries the same thing again.
     */
    function at(ref) {
        const cs = loaded();
        const names = cs.map((c) => c.name ?? c.view).join(", ") || "none";
        if (!ref || ref === "*") {
            const c = focus && map.get(focus);
            if (!c?.rows.length) throw new Error(`no corpus open (loaded: ${names})`);
            return c;
        }
        const want = String(ref).toLowerCase();
        const eq = (x) => x?.toLowerCase() === want;
        const has = (x) => x?.toLowerCase().includes(want);
        const hit = cs.find((c) => eq(c.name))
            ?? cs.find((c) => eq(c.view) || eq(trimView(c.view)))
            ?? cs.find((c) => has(c.name) || has(c.view));
        if (!hit) throw new Error(`no open corpus matches "${ref}" — open: ${names}`);
        return hit;
    }

    /** The corpora one call spans: all of them for "*", else the one named.
     *  "*" with nothing open still throws through `at`, rather than returning an
     *  empty list that would read as "searched everywhere, found nothing". */
    const span = (ref) => (ref === "*" ? (loaded().length ? loaded() : [at()]) : [at(ref)]);

    return {
        map, slot, loaded, at, span,
        get focus() { return focus; },
        set focus(v) { focus = v == null ? null : trimView(v); },
    };
}

/**
 * Merge per-corpus hit lists into one ranking, tagging each hit with its source.
 *
 * A sort, not a normalisation, and that is a property of the data rather than a
 * shortcut: every corpus scored the SAME query vector with raw cosine, so the
 * numbers are already on one scale. Each corpus applies its own z-floor first,
 * which is what keeps a corpus that knows nothing about the question from
 * contributing its least-bad rows to a list it has no business being in.
 *
 * The tag is omitted when only one corpus was searched — a `corpus` key on every
 * hit of a single-corpus search is noise an agent has to learn to ignore.
 */
export function merge(perCorpus, { limit = 10, key = "score" } = {}) {
    const multi = perCorpus.length > 1;
    const all = perCorpus
        .flatMap(({ name, hits }) => hits.map((h) => (multi ? { corpus: name, ...h } : h)))
        .sort((a, b) => b[key] - a[key]);
    // One row per title per corpus, best score kept. A corpus of dialogue has a
    // row per spoken line and titles them all by the film, so an unfiltered
    // ranking returns "Beast_of_Yucca_Flats.mp4" four times at 0.671, 0.670,
    // 0.670, 0.669 — four slots spent saying the same thing. Keyed by corpus,
    // not title alone: the SAME title in two publishers is the interesting case,
    // not a duplicate.
    const seen = new Set();
    const out = [];
    for (const h of all) {
        const k = `${h.corpus ?? ""}\n${h.title ?? h.id ?? out.length}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(h);
        if (out.length >= limit) break;
    }
    return out;
}

/**
 * Follow a corpus's declared reference into the corpus it points at.
 *
 * The archive bundle bakes two domains out of one graph: 20,986 films, and
 * 21,131 subtitle passages each carrying the `path` of the film it was
 * transcribed from. Every one of them resolves. The whole reason the graph holds
 * them together is that you search what was SAID and arrive at what was FILMED —
 * and a consumer that ranks them as two unrelated shelves throws that away,
 * handing a person a matched line of dialogue with nothing to play.
 *
 * So a pick from a referring corpus is REPLACED by its target, keeping what
 * matched as `via`: the row that actually scored, the corpus it came from, and
 * the timestamp if its publisher gave one away. A film reached by three
 * different lines appears once, by the best of them, with the rest counted —
 * otherwise one talkative film fills the queue.
 *
 * A reference that cannot be followed — the target corpus is not open, or the
 * key is missing from the row — leaves the pick exactly as it was. Dropping a
 * hit because its film has not finished downloading would be worse than showing
 * the hit.
 */
export function follow(picks = [], corpora = [], { at = null } = {}) {
    const byName = new Map(corpora.map((c) => [c.name, c]));
    const index = new Map();   // "corpus field" → (key value → row)
    const keyed = (name, field) => {
        const k = `${name} ${field}`;
        let m = index.get(k);
        if (!m) {
            m = new Map();
            for (const r of byName.get(name)?.rows ?? []) {
                const v = r?.[field];
                if (v != null && v !== "" && !m.has(v)) m.set(v, r);
            }
            index.set(k, m);
        }
        return m;
    };

    const out = [];
    const seen = new Map();    // target row id → the entry already emitted for it
    for (const p of picks) {
        const ref = p.roles?.refers;
        const target = ref && byName.get(ref.corpus);
        const row = target && keyed(ref.corpus, ref.to).get(p.row?.[ref.field]);
        if (!row) { out.push(p); continue; }

        const prev = seen.get(row.id);
        if (prev) { prev.via.also = (prev.via.also ?? 0) + 1; continue; }
        const entry = {
            ...p,
            row,
            roles: target.roles,
            corpus: target.name,
            via: {
                row: p.row,
                corpus: p.corpus,
                // The roles that row was published under, because after the swap
                // `roles` belongs to the TARGET and reading the matched line with
                // the film publisher's declaration would be reading it with the
                // wrong text role — which, on a corpus that sells its text, is the
                // difference between an empty string and someone else's field.
                roles: p.roles,
                // Only when the publisher actually gives it away. The archive
                // bundle sells `start` today, so most passages resolve to a film
                // and not to a moment in one — a fact about that bundle's
                // paywall, and not something to paper over with a zero.
                at: at ? at(p.row) : null,
            },
        };
        seen.set(row.id, entry);
        out.push(entry);
    }
    return out;
}

// ── self-check: `node consume/corpora.js` ───────────────────────────────────
if (typeof process !== "undefined" && import.meta.url === `file://${process.argv[1]}` && process.argv[1].endsWith("/corpora.js")) {
    const s = session();
    const add = (view, name, n) => {
        const c = s.slot(view);
        c.name = name;
        c.rows = Array.from({ length: n }, (_, i) => ({ id: `${name}-${i}` }));
        return c;
    };

    // A slot exists before its rows do, and must not answer while empty.
    s.slot("https://a.test/q/v1/cdn");
    if (s.loaded().length) throw new Error("an empty slot must not count as loaded");
    if (s.map.has("https://a.test/q/v1/cdn")) throw new Error("the key must be the trimmed view base");

    add("https://a.test/q/v1", "archive-films", 3);
    add("https://b.test/q/v2/stream", "games", 5);
    s.focus = "https://a.test/q/v1";

    // Opening the second did not close the first. This is the whole feature.
    if (s.loaded().length !== 2) throw new Error("corpora must accumulate, not replace");
    if (s.at().name !== "archive-films") throw new Error("unnamed must mean focused");
    if (s.at("games").rows.length !== 5) throw new Error("by name");
    if (s.at("GAMES").name !== "games") throw new Error("names are case-insensitive — an agent reads them off a listing");
    if (s.at("https://b.test/q/v2").name !== "games") throw new Error("by view url, trimmed either way");
    if (s.at("films").name !== "archive-films") throw new Error("a fragment must resolve — `films` for `archive-films` is the common agent guess");
    if (s.span("*").length !== 2) throw new Error('"*" must span everything open');
    if (s.span("games").length !== 1) throw new Error("a named span is one corpus");

    // A miss names what IS open. "not found" alone makes an agent retry the same call.
    try { s.at("netflix"); throw new Error("a miss must throw"); }
    catch (e) { if (!e.message.includes("archive-films") || !e.message.includes("games")) throw new Error(`a miss must list what is open: ${e.message}`); }

    // "*" against an empty session is an error, not an empty result — the
    // difference between "nothing is open" and "I searched and found nothing".
    const empty = session();
    try { empty.span("*"); throw new Error('"*" with nothing open must throw'); }
    catch (e) { if (!e.message.includes("no corpus open")) throw e; }

    // Merging is a sort across corpora, tagged, and untagged when it is one.
    const m = merge([
        { name: "films", hits: [{ t: "a", score: 0.9 }, { t: "b", score: 0.4 }] },
        { name: "games", hits: [{ t: "c", score: 0.7 }] },
    ], { limit: 2 });
    if (m.map((h) => h.t).join("") !== "ac") throw new Error(`cross-corpus merge must rank by score: ${JSON.stringify(m)}`);
    if (m[0].corpus !== "films" || m[1].corpus !== "games") throw new Error("a merged hit must say which corpus it came from");
    const one = merge([{ name: "films", hits: [{ t: "a", score: 0.9 }] }]);
    if ("corpus" in one[0]) throw new Error("a single-corpus result must not carry a corpus tag");

    // A dialogue corpus repeats one title per line; a ranked list must not.
    {
        const m = merge([
            { name: "films", hits: [{ title: "Beast", score: 0.7 }, { title: "Beast", score: 0.69 }, { title: "Other", score: 0.6 }] },
            { name: "games", hits: [{ title: "Beast", score: 0.65 }] },
        ], { limit: 5 });
        if (m.length !== 3) throw new Error(`repeated titles must collapse within a corpus: ${m.length}`);
        if (m[0].score !== 0.7) throw new Error("the best-scoring copy must be the one kept");
        if (!m.some((h) => h.corpus === "games" && h.title === "Beast")) throw new Error("the same title in another publisher is a different row");
    }

    // ── follow: two shelves that are one thing ──────────────────────────────
    {
        const films = {
            name: "archive-films",
            roles: { title: ["name"], media: ["url"] },
            rows: [
                { id: "f1", name: "King Kelly.mp4", path: "Comedy/King Kelly.mp4", url: "https://a.test/kk.mp4", mime: "video/mp4" },
                { id: "f2", name: "Nosferatu.mp4", path: "Horror/Nosferatu.mp4", url: "https://a.test/nos.mp4", mime: "video/mp4" },
            ],
        };
        const subs = {
            name: "archive-dialogue",
            roles: { title: ["name"], text: ["text"], refers: { field: "videoPath", corpus: "archive-films", to: "path" } },
            rows: [],
        };
        const line = (id, path, start) => ({ row: { id, videoPath: path, name: "x.mp4", start }, roles: subs.roles, corpus: subs.name });

        const got = follow(
            [{ ...line("s1", "Comedy/King Kelly.mp4", 41.5), score: 0.7 },
             { ...line("s2", "Comedy/King Kelly.mp4", 900), score: 0.6 },
             { ...line("s3", "Horror/Nosferatu.mp4"), score: 0.5 },
             { ...line("s4", "Missing/Gone.mp4"), score: 0.4 }],
            [films, subs], { at: (r) => r.start ?? null });

        if (got.length !== 3) throw new Error(`one film reached by two lines is one entry: ${got.length}`);
        if (got[0].row.id !== "f1" || got[0].corpus !== "archive-films") throw new Error("a matched line must become the film it came from");
        if (got[0].roles !== films.roles) throw new Error("…rendered by the FILM publisher's declaration, not the transcript's");
        if (got[0].via.row.id !== "s1" || got[0].via.corpus !== "archive-dialogue") throw new Error("what actually matched must survive as provenance");
        if (got[0].via.at !== 41.5) throw new Error("a timestamp the publisher gave away must come with it");
        if (got[0].via.roles !== subs.roles) throw new Error("the matched row's own roles must survive, or its text is read with the wrong declaration");
        if (got[0].via.also !== 1) throw new Error("the other lines into the same film must be counted, not silently dropped");
        if (got[0].score !== 0.7) throw new Error("the best line's score is the film's score");
        if (got[1].via.at !== null) throw new Error("a passage whose publisher withheld the timecode resolves to the film, not to a fake moment");

        // An unresolvable reference is kept, not lost: the target corpus may
        // simply not have downloaded yet.
        if (got[2].row.id !== "s4" || got[2].via) throw new Error("a reference that cannot be followed must leave the pick alone");
        const closed = follow([{ ...line("s1", "Comedy/King Kelly.mp4", 1), score: 1 }], [subs], { at: (r) => r.start });
        if (closed[0].row.id !== "s1") throw new Error("with the target corpus unopened, the hit still stands");

        // A corpus that declares nothing is untouched, and that is most of them.
        const plain = [{ row: { id: "g1" }, roles: { title: ["title"] }, corpus: "games", score: 1 }];
        if (follow(plain, [films])[0] !== plain[0]) throw new Error("a corpus with no declared reference must pass through");
    }

    console.log("corpora.js self-check ok — corpora accumulate, resolve by name/url/fragment, a miss lists what is open, merge ranks across publishers on one scale, a declared reference turns a matched subtitle into the film it came from");
}
