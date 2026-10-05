// An app's views, served as tools, with no browser.
//
// A Fangorn app's card names its views: static, content-addressed shards any
// HTTP client can read. The page's WebMCP tools are one way in, but they need a
// browser, and a browser costs seconds and gigabytes before the first answer.
// These tools read the views directly with westmarch's own search, browse,
// count, get and similar, so the only code that runs is ours. The app's data is
// verified by its manifest's sha256, not trusted.
//
// Time to first answer is the point, so:
//   - a search goes to the 3 views whose coverage sketch best matches the query,
//     not to all of them (Kingsfoil: ~3 of 23 views, ~92% of the true top 10 with
//     a 32-vector sketch). The result names what was searched and what was not.
//   - `warm()` starts the embedder the moment an app is opened, and a search
//     never waits on a first-time model download.
//
// `get`/`similar`/`count` answer over what is loaded, and say so.

import { configure, loadShard, trimView } from "../core/shard.js";
import { rolesFrom, textOf } from "../core/roles.js";
import { browse, facet, getRow, neighbors, search } from "./tools.js";
import { lexScore, rankDomains } from "../core/rank.js";
import { existsSync } from "node:fs";
import { EMBED_MODEL, embedQueryDirect, warmDirect } from "../core/embed.js";

const ROUTE_TOP = 3;

// One roles table per view, set from its manifests before its first row parses.
const rolesByView = new Map();
const DEFAULT_ROLES = rolesFrom([]);
const rolesOf = (view) => rolesByView.get(view) ?? DEFAULT_ROLES;
configure({
    onManifests: (manifests, view) => rolesByView.set(view, rolesFrom(manifests)),
    rowText: (f, view) => textOf(f, rolesOf(view)),
});

// ponytail: an embedder that fails to load is remembered as failed, and search
// ranks by words for the rest of the process. Retry when that matters.
let embedder = null, ready = false, downloading = false;
/** `cacheDir`: where the model is kept. Outside node_modules, or every new
 *  install of this package downloads the same 131MB again. */
export const warm = ({ cacheDir } = {}) => (embedder ??= (async () => {
    if (cacheDir) {
        downloading = !existsSync(`${cacheDir}/${EMBED_MODEL}/onnx/model_quantized.onnx`);   // before any await
        (await import("@huggingface/transformers")).env.cacheDir = cacheDir;
    }
    await warmDirect();
})().then(() => (ready = true), (e) => { warmError = e?.message ?? String(e); return false; })
    .finally(() => { downloading = false; }));
/** Why the embedder did not load, if it did not. */
export let warmError = null;
// A model on disk loads in ~0.5s and is worth the wait. A download is 131MB, so
// until it lands, search ranks by words and says so, rather than stall ~10s.
export const queryVector = async (q) => {
    if (!ready && downloading) return null;
    return (await warm()) ? embedQueryDirect(q).catch(() => null) : null;
};
const rankedBy = (qv) => qv ? "meaning"
    : downloading ? "words (the embedding model is downloading; meaning once it lands)"
    : "words (embedder unavailable)";

const text = (o) => ({ content: [{ type: "text", text: JSON.stringify(o, null, 1) }] });
const str = (description) => ({ type: "string", description });
const num = (description) => ({ type: "number", description });
const VIEWS = { type: "array", items: { type: "string" }, description: 'View names from describe, or ["all"]. Omit to let the query choose.' };
const WHERE = { type: "object", description: 'Equality filters, e.g. {"phase":"PHASE3"}' };

/**
 * The tools for one app, or null when its card names no views.
 * `app` is `{ name, desc, views }` from a verified card. `fetchCatalog(url)` may
 * answer from a stale copy: the survey only describes and routes, and loading a
 * view re-reads its catalog through shard.js either way.
 */
export function viewTools(app, { fetchCatalog = fetch } = {}) {
    if (!app.views?.length) return null;
    const names = new Map();   // view url → its name in every result
    const label = (url) => names.get(url) ?? url.split("/").pop();
    let surveyed;
    // The catalogs: what each view holds and its coverage sketch. Small, and no rows.
    const survey = () => (surveyed ??= Promise.all(app.views.map(async (url) => {
        const view = trimView(url);
        const { domains = [] } = await (await fetchCatalog(`${view}/cdn/catalog`)).json();
        names.set(view, domains.length === 1 ? domains[0].name : label(view));
        return {
            view, name: label(view),
            description: domains.map((d) => d.description).filter(Boolean).join(" "),
            count: domains.reduce((s, d) => s + (d.count ?? 0), 0),
            coverage: { vectors: domains.flatMap((d) => d.coverage?.vectors ?? []) },
        };
    })).catch((e) => { surveyed = null; throw e; }));

    survey().catch(() => {});   // started now, so describe and the first search do not wait on it
    const loaded = new Map();   // view → rows
    const load = async (v) => { if (!loaded.has(v.view)) loaded.set(v.view, await loadShard(v.view)); return loaded.get(v.view); };
    const pick = async (names) => {
        const all = await survey();
        if (names?.includes("all")) return all;
        const bad = names.filter((n) => !all.some((v) => v.name === n || label(v.view) === n));
        if (bad.length) throw new Error(`unknown view(s) ${bad.join(", ")}; views: ${all.map((v) => v.name).join(", ")}`);
        return all.filter((v) => names.includes(v.name) || names.includes(label(v.view)));
    };
    // The query decides: coverage sketch by meaning, else the descriptions by words.
    const route = async (query, qv) => {
        const all = await survey();
        return qv ? rankDomains(all, qv)
            : all.map((v) => ({ ...v, affinity: lexScore({ text: `${v.name} ${v.description}` }, query) }))
                 .sort((a, b) => b.affinity - a.affinity);
    };
    const loadedRows = () => [...loaded.entries()].flatMap(([view, rows]) => rows.map((r) => ({ r, view })));

    const run = {
        describe: async () => ({
            app: app.name, description: app.desc,
            views: (await survey()).map((v) => ({ view: v.name, rows: v.count, description: v.description, loaded: loaded.has(v.view) })),
        }),
        search: async ({ query, limit = 10, views, where: w }) => {
            if (!query) throw new Error("query is required");
            const qv = await queryVector(query);
            const ranked = views?.length ? await pick(views) : (await route(query, qv)).slice(0, ROUTE_TOP);
            const others = views?.length ? [] : (await route(query, qv)).slice(ROUTE_TOP, ROUTE_TOP + 5).map((v) => v.name);
            const per = await Promise.all(ranked.map(async (v) =>
                search(await load(v), query, rolesOf(v.view), { qv, limit, where: w }).map((h) => ({ ...h, view: v.name }))));
            const hits = per.flat().sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, limit);
            return { query, ranked_by: rankedBy(qv), searched: ranked.map((v) => v.name),
                     next_views: others, hits };
        },
        get: async ({ id, view }) => {
            if (view) for (const v of await pick([view])) await load(v);
            for (const [v, rows] of loaded) { const r = getRow(rows, id, rolesOf(v)); if (r) return r; }
            return { error: `${id} is not in a loaded view. Search for it, or pass its view.`, loaded: [...loaded.keys()].map(label) };
        },
        similar: async ({ id, limit = 10, views }) => {
            const hit = loadedRows().find(({ r }) => r.id === id);
            if (!hit) return { error: `${id} is not loaded. Search for it first.` };
            // Neighbours by design live anywhere, so route on the row's own vector.
            const targets = views?.length ? await pick(views)
                : hit.r.vector ? (await route("", hit.r.vector)).slice(0, ROUTE_TOP) : [];
            await Promise.all(targets.map(load));
            const rows = [...loaded.values()].flat();
            const { seed, near } = neighbors(rows, id, rolesOf(hit.view), { limit });
            return { id, seed, searched: [...loaded.keys()].map(label), hits: near };
        },
        count: async ({ field, views, limit = 20, where: w }) => {
            if (!field) throw new Error("field is required");
            if (views?.length) await Promise.all((await pick(views)).map(load));
            if (!loaded.size) return { error: 'nothing loaded yet. Pass views (or ["all"]) to count over.' };
            return { field, over: [...loaded.keys()].map(label), ...facet([...loaded.values()].flat(), field, { limit, where: w }) };
        },
        browse: async ({ view, limit = 20, offset = 0, sort, where: w }) => {
            const [v] = await pick([view]);
            return { view: v.name, ...browse(await load(v), rolesOf(v.view), { limit, offset, sort, where: w }) };
        },
    };

    const n = app.name;
    const tools = [
        { name: "describe", description: `What ${n} holds: its views, each with a description and row count. Downloads no rows; call it first.`,
          inputSchema: { type: "object", properties: {} } },
        { name: "search", description: `Search ${n} by meaning. Without views, searches the ${ROUTE_TOP} views whose coverage best matches the query and names the next candidates; pass views to widen.`,
          inputSchema: { type: "object", properties: { query: str("A question in natural language"), limit: num("Max hits (default 10)"), views: VIEWS, where: WHERE }, required: ["query"] } },
        { name: "get", description: `One record of ${n} in full, by id.`,
          inputSchema: { type: "object", properties: { id: str("The record id, as search returns it"), view: str("Its view, if it has not been loaded") }, required: ["id"] } },
        { name: "similar", description: `Records of ${n} nearest to one record, across the views its vector points to.`,
          inputSchema: { type: "object", properties: { id: str("A record id from search"), limit: num("Max results (default 10)"), views: VIEWS }, required: ["id"] } },
        { name: "count", description: `Count the distinct values of a field in ${n}: the shape of a result set before reading it.`,
          inputSchema: { type: "object", properties: { field: str("Field name, e.g. from get"), views: VIEWS, limit: num("Max values (default 20)"), where: WHERE }, required: ["field"] } },
        { name: "browse", description: `List one view of ${n} without a query, with filters, sorting and paging.`,
          inputSchema: { type: "object", properties: { view: str("View name from describe"), limit: num("default 20"), offset: num("default 0"), sort: str("Field to sort by"), where: WHERE }, required: ["view"] } },
    ];
    // Records the app sells over x402 (its card's `paid`). Paid from this server's wallet,
    // never above FANGORN_MCP_MAX_PRICE, and checked against the sha256 the app published
    // for that record, so what was paid for is what was committed.
    if (app.paid) {
        const p = app.paid, dec = p.decimals ?? 6;
        const price = `${(Number(p.price) / 10 ** dec).toFixed(dec).replace(/0+$/, "").replace(/\.$/, "")} ${p.symbol ?? "USDC"}`;
        const cap = BigInt(Math.round(Number(process.env.FANGORN_MCP_MAX_PRICE ?? "0.10") * 10 ** dec));
        run.buy = async ({ id }) => {
            if (!id) throw new Error("id is required");
            const hit = loadedRows().find(({ r, view }) => r.id === id || r[rolesOf(view).identity] === id);
            const key = hit ? hit.r[rolesOf(hit.view).identity] ?? id : id;
            const { payAndFetch } = await import("./x402.js");
            const r = await payAndFetch(p.url.replace("{id}", encodeURIComponent(key)),
                { privateKey: process.env.FANGORN_MCP_WALLET_KEY, maxPrice: cap });
            if (r.status !== 200) return { id: key, error: `HTTP ${r.status}: ${r.body.slice(0, 200)}` };
            const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(r.body)))]
                .map((b) => b.toString(16).padStart(2, "0")).join("");
            const want = hit?.r.paid_sha256;
            return { id: key, paid: r.price ? price : "free", transaction: r.receipt?.transaction ?? null, network: r.receipt?.network ?? p.network,
                     verified: want ? (want === digest ? "matches the published sha256" : `MISMATCH: published ${want}, got ${digest}`) : "not checked (search for the record first)",
                     record: JSON.parse(r.body) };
        };
        tools.push({ name: "buy", description: `Buy one ${n} record's paid detail for ${price} (x402 on ${p.network}): ${p.description || "the structured record"}. ` +
                "Pass an id from search. Paid from this server's wallet (FANGORN_MCP_WALLET_KEY), never above FANGORN_MCP_MAX_PRICE.",
            inputSchema: { type: "object", properties: { id: str("A record id from search or get") }, required: ["id"] } });
    }

    return { tools, call: async (name, args = {}) => {
        if (!run[name]) throw new Error(`no tool ${name}`);
        return text(await run[name](args));
    } };
}

