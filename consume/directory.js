// Finding the corpus, before you can search inside it.
//
// Every other file here answers a question about rows you already have. This one
// answers the question that comes first, and that an agent facing a network of
// independent publishers cannot otherwise answer at all: WHICH corpus.
//
// It works because the bake already writes the answer. Each domain's
// catalog.json carries `coverage` — spherical k-means centroids over a sample of
// its own vectors, 8 of them at 128 dims, about 4 KB. That is a fingerprint of
// what a corpus is ABOUT, published by whoever baked it, costing nothing to
// fetch. Rank a query vector against every registered publisher's centroids and
// you have ranked the network's corpora without downloading a single shard.
//
// Which is the property that matters. A directory that had to index the rows
// would have to hold everyone's rows — it would be a search engine, with a
// crawler, and every publisher's data on its disks. This holds 4 KB per corpus
// and never sees a row. The query is embedded in the client too, so the
// directory does not learn what anyone is looking for either.
//
// ponytail: one flat pass over every registered domain, no index. A registry
// with 10k domains is 40MB of centroids and a linear scan of 80k × 128 floats —
// still well under a second. Past that, the directory needs its own coverage
// index, which is the same trick one level up.

import { trimView } from "./shard.js";
import { rankDomains, zFloor } from "./rank.js";
import { listApps } from "./apps.js";

/** Catalog URL for a view base, tolerating either form the registry prints. */
const catalogUrl = (view) => `${trimView(view)}/cdn/catalog`;

async function readJson(url, timeoutMs) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
        const res = await fetch(url, { signal: ctl.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
    } finally { clearTimeout(t); }
}

/**
 * Every corpus a set of publishers offers, with what it is about and what it
 * costs — but not its contents.
 *
 * `sources` are view bases. The on-chain app list (apps.js) resolves to a list
 * of them; this takes the list, so the directory works with a registry, a
 * hand-written array, or one URL a user pasted.
 *
 * A publisher that is down, slow, or serving something that isn't a catalog is
 * REPORTED, not thrown. A directory that fails because one of forty publishers
 * is offline is a directory nobody can rely on, and silently dropping them is
 * worse — an agent would conclude the corpus does not exist.
 */
export async function survey(sources = [], { timeoutMs = 8000 } = {}) {
    const corpora = [];
    const unreachable = [];
    await Promise.all(sources.map(async (src) => {
        const view = trimView(typeof src === "string" ? src : src.view);
        try {
            const cat = await readJson(catalogUrl(view), timeoutMs);
            for (const d of cat.domains ?? []) {
                corpora.push({
                    view,
                    publisher: typeof src === "string" ? null : (src.name ?? src.appId ?? null),
                    owner: typeof src === "string" ? null : (src.owner ?? null),
                    domain: d.name,
                    description: d.description || "",
                    rows: d.count ?? 0,
                    bytes: d.bytes ?? 0,
                    dim: d.dim ?? null,
                    entityTypes: d.entity_types ?? [],
                    coverage: d.coverage ?? null,
                    // Quoted from the catalog. The field NAMES are one fetch
                    // deeper, in the manifest — a listing should not carry every
                    // corpus's schema.
                    paywall: d.paywall ?? null,
                    model: cat.embedding_model ?? null,
                });
            }
        } catch (e) {
            unreachable.push({ view, error: e?.message ?? String(e) });
        }
    }));
    return { corpora, unreachable };
}

/**
 * Rank a survey against a query vector. The whole directory, in one line of
 * arithmetic, because `rankDomains` already scores coverage centroids.
 *
 * `affinity` is null — never 0 — for a corpus baked before coverage existed.
 * Sorting those last is right; scoring them 0 would claim they were measured and
 * found irrelevant, and an agent would stop looking at a corpus nobody has
 * described rather than at one that does not match.
 */
export function rankCorpora(corpora, qv) {
    return rankDomains(corpora, qv);
}

/** The model a corpus was embedded with must match the one that made `qv`, or
 *  cosine between them is noise. Publishers are independent, so this WILL happen
 *  the day someone bakes with a different model — and it is invisible without a
 *  check, because the numbers still come out looking like scores. */
export const comparable = (corpus, model) => !corpus.model || !model || corpus.model === model;

/**
 * One call: what is out there, for this question.
 *
 * Returns matches with their affinity, price and size, plus whatever could not
 * be reached and whatever could not be compared. `embed` is injected so the
 * query vector is made in the caller's own process — the directory never sees
 * the question, which is the same property the shards give search.
 */
export async function findCorpora(query, { sources = [], embed, model, limit = 10, timeoutMs } = {}) {
    const { corpora, unreachable } = await survey(sources, { timeoutMs });
    const usable = corpora.filter((c) => comparable(c, model));
    const mismatched = corpora.filter((c) => !comparable(c, model))
        .map((c) => ({ domain: c.domain, model: c.model }));

    let ranked = usable, qv = null;
    if (query?.trim() && embed) {
        try {
            qv = await embed(query);
            ranked = rankCorpora(usable, qv);
            // Cosine to a coverage centroid is offset per query — a raw 0.52
            // means nothing on its own, and "quantum chromodynamics" scores
            // higher against a film archive than "sci-fi monster movies" does.
            // So the answer to "which of these is actually about this" is a
            // floor computed FROM THIS QUERY's own spread, exactly as rank.js
            // does at row level. Marked, not cut: a person who typed something
            // vague should still see everything that exists.
            //
            // This is the part that has to hold at a thousand publishers, where
            // a ranked list nobody trimmed is a thousand rows of noise.
            const scored = ranked.map((c) => c.affinity).filter((a) => a != null);
            // `Math.min(floor, top)`: with a handful of corpora that ALL match,
            // mean+1σ sits above every one of them and would report nothing
            // relevant. The best match is relevant by definition — the floor's
            // job is to cut the tail, never to empty the list.
            const floor = Math.min(zFloor(scored), Math.max(...scored, -Infinity));
            ranked = ranked.map((c) => ({ ...c, relevant: c.affinity != null && c.affinity >= floor }));
        } catch (e) {
            // No embedder: still a useful directory, just unranked. Say so rather
            // than returning an arbitrary order that looks like a ranking.
            return { query, ranked: false, why: e?.message ?? String(e), corpora: usable, unreachable, mismatched };
        }
    }
    return {
        query: query ?? null,
        ranked: !!qv,
        corpora: ranked.slice(0, limit),
        searched: usable.length,
        // How many cleared the floor. An agent should open these and stop —
        // the tail is sorted, not relevant.
        relevant: qv ? ranked.filter((c) => c.relevant).length : null,
        unreachable,
        mismatched,
    };
}

/** Every app bound on chain → the view bases their cards list, as survey()
 *  sources. A thin pass-through of apps.js so a caller does not need both
 *  modules to run a survey. Rejected cards come back beside the sources. */
export async function sourcesFromChain(fangorn, opts) {
    const { apps, rejected } = await listApps(fangorn, opts);
    return { sources: apps.flatMap((a) => a.views.map((view) => ({ view, name: a.name, appId: a.appId }))), rejected };
}

// ── self-check: `node consume/directory.js` ─────────────────────────────────
if (typeof process !== "undefined" && import.meta.url === `file://${process.argv[1]}` && process.argv[1].endsWith("/directory.js")) {
    const warn = console.warn; console.warn = () => {};
    const cov = (...vectors) => ({ dim: 2, sampled: 100, vectors, counts: vectors.map(() => 50) });

    const CATALOGS = {
        "https://films.test/q/v1": {
            embedding_model: "nomic", domains: [{
                name: "films", count: 42215, bytes: 15400000, dim: 256,
                description: "Public-domain film", entity_types: ["video", "subtitles"],
                coverage: cov([1, 0]),
                paywall: { price: "50000", asset: "USDC", locked: 22, free: 14, buyable: true },
            }],
        },
        "https://places.test/q/v2": {
            embedding_model: "nomic", domains: [{
                name: "places", count: 917, bytes: 5600000, dim: 256,
                description: "Local businesses and events", entity_types: ["Business", "Event"],
                coverage: cov([0, 1]),
            }, { name: "menus", count: 30, dim: 256, coverage: cov([0, 1]) },
               { name: "listings", count: 30, dim: 256, coverage: cov([0, 1]) }],
        },
        "https://old.test/q/v3": {
            embedding_model: "nomic",
            domains: [{ name: "legacy", count: 10, dim: 256 }],   // baked before coverage
        },
        "https://other.test/q/v4": {
            embedding_model: "some-other-model",
            domains: [{ name: "foreign", count: 5, dim: 384, coverage: cov([1, 0]) }],
        },
    };
    globalThis.fetch = async (url) => {
        const base = String(url).replace("/cdn/catalog", "");
        if (base === "https://down.test/q/v9") throw new Error("connect ECONNREFUSED");
        const body = CATALOGS[base];
        return body ? { ok: true, json: async () => body } : { ok: false, status: 404 };
    };
    const SOURCES = [...Object.keys(CATALOGS), "https://down.test/q/v9"];
    const embed = async (q) => (/film|movie|cinema/.test(q) ? [1, 0] : [0, 1]);

    // The directory ranks corpora it has not downloaded.
    let r = await findCorpora("old movies about war", { sources: SOURCES, embed, model: "nomic" });
    if (!r.ranked) throw new Error("a query with an embedder must rank");
    if (r.corpora[0].domain !== "films") throw new Error(`wrong corpus first: ${r.corpora[0].domain}`);
    if (!(r.corpora[0].affinity > 0.99)) throw new Error(`affinity should be ~1: ${r.corpora[0].affinity}`);
    // …and the price is quoted from the catalog, with no manifest fetched.
    if (r.corpora[0].paywall.price !== "50000") throw new Error("a listing must quote a price");

    // The floor. Absolute affinity is meaningless across queries, so "which of
    // these is about this" is answered from THIS query's own spread — the thing
    // that has to hold when the directory is a thousand publishers deep.
    if (r.relevant !== 1) throw new Error(`only the film archive is about war films, got ${r.relevant}`);
    if (r.corpora.find((c) => c.domain === "places").relevant) throw new Error("an unrelated corpus must not clear the floor");

    // The same directory, a different question. Nothing was downloaded in between.
    r = await findCorpora("somewhere to eat tonight", { sources: SOURCES, embed, model: "nomic" });
    if (r.corpora[0].domain !== "places") throw new Error("the question must decide the corpus");

    // …and when everything matches, the floor must not empty the list.
    if (r.relevant !== 3) throw new Error(`three place corpora all match "eat tonight", got ${r.relevant}`);

    // Undescribed corpora sort last and stay null — unrankable is not irrelevant.
    const legacy = r.corpora.find((c) => c.domain === "legacy");
    if (legacy.affinity !== null) throw new Error("a corpus with no coverage must rank null, not 0");
    if (r.corpora.at(-1).domain !== "legacy") throw new Error("unrankable sorts last");

    // A corpus embedded with another model is EXCLUDED and named. Cosine between
    // two models' vectors is noise that still looks like a score.
    if (r.corpora.some((c) => c.domain === "foreign")) throw new Error("a foreign model must not be ranked against ours");
    if (r.mismatched[0]?.domain !== "foreign") throw new Error("an excluded corpus must be reported, not dropped");

    // One publisher being down must not take the directory down, and must not
    // look like that corpus does not exist.
    if (r.unreachable[0]?.view !== "https://down.test/q/v9") throw new Error("an unreachable publisher must be reported");
    if (!r.corpora.length) throw new Error("one bad publisher must not empty the directory");

    // No embedder: a listing, honestly labelled, rather than a fake ranking.
    r = await findCorpora("anything", { sources: SOURCES, embed: async () => { throw new Error("model offline"); }, model: "nomic" });
    if (r.ranked !== false || !r.why.includes("model offline")) throw new Error("a failed embed must say so");
    if (!r.corpora.length) throw new Error("an unranked directory is still a directory");

    // No query at all is a valid call — "what is out there".
    r = await findCorpora("", { sources: SOURCES, embed, model: "nomic" });
    if (r.ranked || r.corpora.length !== 5) throw new Error(`a bare survey must list everything comparable: ${r.corpora.length}`);

    // Publisher identity rides through when the source came from a registry.
    r = await findCorpora("film", { sources: [{ view: "https://films.test/q/v1", name: "Archive", owner: "0xa" }], embed, model: "nomic" });
    if (r.corpora[0].publisher !== "Archive" || r.corpora[0].owner !== "0xa") throw new Error("publisher identity lost");

    console.warn = warn;
    console.log("directory.js self-check ok — ranks undownloaded corpora by coverage, quotes price from the catalog, "
        + "excludes foreign models, survives dead publishers, unranked is labelled not faked");
}
