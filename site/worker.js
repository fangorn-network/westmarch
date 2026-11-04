// A Fangorn app on the free tier: one Cloudflare Worker that is the app's indexer, its view,
// its MCP server and its site. `westmarch-ship` deploys it with the app's CONFIG.
//
//   cron                  the indexer. Follows the update log from where it left off, and runs
//                         the embedding lens (view.js, the Worker's AI binding as the encoder)
//                         over every member's repo whose head moved, into R2. A repo whose
//                         publisher leaves the app, or that the app excludes, loses its domain
//                         on the next run.
//   GET /view/…           the view, from R2: catalog, manifests, content-named shards
//   POST /mcp             the view as MCP tools (describe, search, get, similar, count, browse,
//                         threads) over streamable HTTP: no install, no browser
//   GET /doc?u=<url>      a record's source document, served from this origin so the page can
//                         show it inline. Source sites forbid framing and send no CORS, so the
//                         page cannot fetch or frame them itself. Only hosts the app's own
//                         records link to (each domain's `link_hosts`), only PDFs, cached a day.
//   GET /paid/<publisher>/<repo>/<id>   with CONFIG.paid: an x402 v2 quote for one record its
//                         publisher sells (scheme "fangorn", from the record's signed terms). With a
//                         PAYMENT-SIGNATURE header, the facilitator (Barliman) verifies and settles it
//   anything else         the static site (the stock page, the card)
//
// The app sells nothing of its own. A publisher seals a record's fields and signs its terms
// (`fangorn commit --paid`); this worker only quotes them. After paying, the buyer proves it to
// the relay and asks the record's key server for the key: nothing secret passes through here.
//
// Bindings: VIEW (R2), AI (Workers AI), ASSETS (the site), CONFIG (a JSON var: app, name,
// description, fromBlock, schema, repos, paid, facilitator, deployment), and optionally RPC_URL
// and IPFS_GATEWAY (vars).

import { Fangorn, FangornConfig, SupportedNetworks } from "@fangorn-network/sdk";
import { createPublicClient, http, parseAbi } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { EMBED_MODEL, DOCUMENT, QUERY, matryoshka } from "../src/core/embed.js";
import { configure, resetShard } from "../src/core/shard.js";
import { ORIGIN, publishView, r2Store } from "../src/publish/view.js";
import { viewTools } from "../src/agent/view-tools.js";

let CONFIG = { paid: null };

// ── the lens's encoder ────────────────────────────────────────────────────────

const AI_MODEL = "@cf/google/embeddinggemma-300m";
/** What a view built here records: the same model as embed.js, another runtime of it. */
export const WORKER_EMBEDDER = { runtime: "workers-ai", model: EMBED_MODEL, dtype: "workers-ai" };
// EMBED_URL: an encoder answering as the AI binding does ({text} → {data}), on a devnet, so
// nothing leaves the machine. Its views say so: {runtime, model, dtype} come back with it.
const ai = (env) => env.EMBED_URL
    ? async (body) => (await fetch(env.EMBED_URL, { method: "POST", body: JSON.stringify(body) })).json()
    : (body) => env.AI.run(AI_MODEL, body);
const embedderOf = async (env) => env.EMBED_URL ? (await (await fetch(env.EMBED_URL)).json()) : WORKER_EMBEDDER;
const encode = (env, prompt) => async (texts) =>
    (await ai(env)({ text: texts.map((t) => prompt + t) })).data.map((v) => matryoshka(v));

// ── the indexer ───────────────────────────────────────────────────────────────

const STATE = "state.json", LOCK = "index.lock";
// A live run beats its lock every BEAT_MS; one silent past LOCK_MS is presumed dead (killed for CPU
// or wall time, which skips `finally`) and its lock taken over. Lock: "<last beat ms> <run id>".
// ponytail: get-then-put, so two runs starting in the same instant can both take it; R2's onlyIf etag when that shows.
const LOCK_MS = 2 * 60_000, BEAT_MS = 30_000;
export async function takeLock(bucket, now = Date.now()) {
    const held = await (await bucket.get(LOCK))?.text();
    if (held && now - Number(held.split(" ")[0]) < LOCK_MS) return null;
    const id = crypto.randomUUID();
    const beat = () => bucket.put(LOCK, `${Date.now()} ${id}`);
    await beat();
    return { id, beat, release: async () => { if ((await (await bucket.get(LOCK))?.text())?.endsWith(id)) await bucket.delete(LOCK); } };
}

// CONFIG.network: the SDK's network name ("baseSepolia"); absent, its default.
const network = () => SupportedNetworks[CONFIG.network] ?? FangornConfig;

function reader(env) {
    // CONFIG.deployment: another deployment's addresses (and fromBlock as a string),
    // for a testnet fork or a local chain. Absent, the network's.
    const d = CONFIG.deployment ?? {};
    const config = { ...network(), ...d, ...(d.fromBlock != null ? { fromBlock: BigInt(d.fromBlock) } : {}),
                     ...(env.RPC_URL ? { rpcUrl: env.RPC_URL } : {}) };
    const fangorn = Fangorn.create({ privateKey: generatePrivateKey(), config,
        storage: { signedUrl: env.IPFS_GATEWAY ? { gateway: env.IPFS_GATEWAY } : {} } });
    return { fangorn, chain: createPublicClient({ chain: config.chain, transport: http(config.rpcUrl) }) };
}

/**
 * Every repo at its latest head, kept across runs in R2: each run reads only the updates
 * since the last. publishView narrows it to the repos the app lists.
 */
export async function presented({ fangorn, chain }, state) {
    const to = await chain.getBlockNumber();
    const from = state.block == null ? BigInt(CONFIG.fromBlock ?? network().fromBlock) : BigInt(state.block) + 1n;
    const registry = fangorn.getRegistry();
    if (from <= to) for (const e of await registry.log({}, from, to))
        state.repos[`${e.publisher.toLowerCase()}/${e.repo}`] = { owner: e.publisher, repo: e.repo, root: e.head };
    state.block = String(to);
    return Object.values(state.repos);
}

export async function index(env, { log = console.log } = {}) {
    const lock = await takeLock(env.VIEW);
    if (!lock) return log("index: a run is in progress; skipped");
    const beating = setInterval(() => lock.beat().catch(() => {}), BEAT_MS);
    try {
        const state = (await (await env.VIEW.get(STATE))?.json()) ?? { block: null, repos: {} };
        const r = reader(env);
        const report = await publishView({
            fangorn: r.fangorn, app: CONFIG.app, schema: CONFIG.schema, repos: CONFIG.repos, store: r2Store(env.VIEW),
            presented: await presented(r, state), embedBatch: encode(env, DOCUMENT), embedder: await embedderOf(env), log,
        });
        await env.VIEW.put(STATE, JSON.stringify(state));
        log(`index: through block ${state.block}, ${Object.keys(report).length} domain(s) changed`);
        return report;
    } finally {
        clearInterval(beating);
        await lock.release();
    }
}

// ── the view, from R2 ─────────────────────────────────────────────────────────

const CONTENT = { ".gz": "application/gzip" };
async function viewFile(env, path) {
    const o = await env.VIEW.get(`view/${path}`);
    if (!o) return new Response("not found", { status: 404, headers: CORS });
    const type = CONTENT[path.slice(path.lastIndexOf("."))] ?? "application/json";
    // Shards are content-named, so a reader's browser keeps one for good: a change or a
    // retraction writes new names. `private`: kept out of shared caches, so a retracted
    // record's shard stops being served the moment the indexer deletes it.
    const cache = path.includes("/shards/") ? "private, max-age=31536000, immutable" : "no-cache";
    return new Response(o.body, { headers: { "content-type": type, "cache-control": cache, ...CORS } });
}

// ── MCP over streamable HTTP ──────────────────────────────────────────────────
//
// Stateless: every POST is one JSON-RPC message, answered with one JSON body. The tools are
// view-tools.js's, reading the view straight from R2, ranking by a query embedded here by the
// same runtime that embedded the rows. They are rebuilt when the indexer writes a new catalog.

let mcp = null;
async function tools(env, origin) {
    const catalog = await env.VIEW.get("view/cdn/catalog");
    const at = catalog?.uploaded?.getTime() ?? 0;
    if (mcp?.at !== at) {
        resetShard();
        configure({ fetch: (url) => viewFile(env, new URL(url).pathname.replace(/^\/view\//, "")) });
        const qv = encode(env, QUERY);
        mcp = { at, tools: viewTools({ name: CONFIG.name ?? CONFIG.app, desc: CONFIG.description ?? "", views: [`${origin}/view`] },
            { fetchCatalog: (url) => viewFile(env, new URL(url).pathname.replace(/^\/view\//, "")),
              queryVector: async (q) => (await qv([q]).catch(() => [null]))[0] }) };
        // viewTools starts its catalog survey unawaited. workerd cancels a request's I/O when
        // it returns, so a survey begun under tools/list never settles and every later call
        // waits on it forever. Finish it here, in the request that started it.
        await mcp.tools.call("describe").catch(() => {});
    }
    return mcp.tools;
}

export async function mcpCall(env, origin, msg) {
    const ok = (result) => ({ jsonrpc: "2.0", id: msg.id, result });
    switch (msg.method) {
        case "initialize": return ok({
            protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: CONFIG.name ?? CONFIG.app ?? "fangorn-app", version: "0.1.0" },
            instructions: `${CONFIG.description ?? ""} Call describe first, then search.`.trim(),
        });
        case "ping": return ok({});
        case "tools/list": return ok({ tools: (await tools(env, origin))?.tools ?? [] });
        case "tools/call": {
            const t = await tools(env, origin);
            try { return ok(await t.call(msg.params?.name, msg.params?.arguments ?? {})); }
            catch (e) { return ok({ isError: true, content: [{ type: "text", text: e?.message ?? String(e) }] }); }
        }
        default: return { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `unknown method ${msg.method}` } };
    }
}

async function serveMcp(request, env, url) {
    if (request.method !== "POST") return new Response("POST JSON-RPC here (MCP streamable HTTP)", { status: 405, headers: { allow: "POST", ...CORS } });
    let msg;
    try { msg = await request.json(); } catch { return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "not JSON" } }, 400); }
    if (Array.isArray(msg)) return json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "one message per request" } }, 400);
    if (msg.id === undefined) return new Response(null, { status: 202, headers: CORS });   // a notification
    return json(await mcpCall(env, url.origin, msg));
}

const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "PAYMENT-SIGNATURE, authorization, content-type",
               "access-control-expose-headers": "PAYMENT-REQUIRED, PAYMENT-RESPONSE" };
const json = (o, status = 200, headers = {}) =>
    new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", ...CORS, ...headers } });
const note = (msg, status) => new Response(`<!doctype html><meta charset="utf-8"><body style="font:15px system-ui;padding:24px;color:#555">${msg}</body>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } });

async function doc(request, env, url) {
    let src;
    try { src = new URL(url.searchParams.get("u") ?? ""); } catch { return note("No document named.", 400); }
    const hosts = new Set(((await (await env.VIEW.get("view/cdn/catalog"))?.json())?.domains ?? []).flatMap((d) => d.link_hosts ?? []));
    if (src.protocol !== "https:" || !hosts.has(src.hostname)) return note("Not one of this app's sources.", 403);
    const cache = caches.default, key = new Request(url.href);
    const hit = await cache.match(key);
    if (hit) return hit;
    const up = await fetch(src.href, { headers: { "user-agent": "Mozilla/5.0 (compatible; fangorn-app/0.1; +https://fangorn.network)" }, redirect: "follow" });
    // A redirect may not leave the allowed hosts, and only a PDF is shown: an HTML page from
    // someone else's site, served from this origin, would run as this app.
    if (!hosts.has(new URL(up.url).hostname)) return note("The source redirected elsewhere.", 403);
    if (!up.ok || !(up.headers.get("content-type") ?? "").includes("pdf"))
        return note(`This document is not a PDF. <a href="${src.href.replace(/"/g, "&quot;")}" target="_blank" rel="noopener">Open it on the source site</a>.`, 415);
    const res = new Response(up.body, { headers: { "content-type": "application/pdf", "content-disposition": "inline",
        "cache-control": "public, max-age=86400", "x-content-type-options": "nosniff" } });
    await cache.put(key, res.clone());
    return res;
}

// ── paid records ─────────────────────────────────────────────────────────────
// x402 v2 over HTTP: the 402's PaymentRequired in the PAYMENT-REQUIRED header (base64 JSON) and the
// body, the buyer's payment in PAYMENT-SIGNATURE, the settlement back in PAYMENT-RESPONSE. Only the
// payment's `payload` is taken from the buyer: the requirement sent to the facilitator is ours.

const b64json = (o) => btoa(JSON.stringify(o));

/**
 * A record's quote: `{ requirement, body }`, or null when its publisher doesn't sell it.
 * `read(publisher, repo, id)` → the record's payload, or null. `chain`: chainId, registry, usdc and
 * its EIP-712 name and version. The facilitator's /supported names the referrer the buyer signs in.
 */
export async function quoteOf({ publisher, repo, id, read, chain, facilitator }) {
    const payload = await read(publisher, repo, id);
    const t = payload?.["@terms"];
    if (!t?.terms || !t.signature) return null;
    const fields = Object.fromEntries(Object.entries(payload).filter(([, v]) => v?.["@type"] === "handle" && v.gadget === "field-v1"));
    const generation = Object.values(fields)[0]?.generation;
    if (generation == null) return null;
    const deposit = await read(publisher, repo, `@deposit/${generation}`);
    if (!deposit) return null;
    const network = `eip155:${chain.chainId}`;
    const kind = (await (await fetch(`${facilitator}/supported`)).json()).kinds?.find((k) => k.scheme === "fangorn" && k.network === network);
    if (!kind?.extra?.referrer) throw new Error(`${facilitator} does not settle scheme "fangorn" on ${network}`);
    return {
        requirement: { scheme: "fangorn", network, amount: String(t.terms.price), asset: chain.usdc, payTo: chain.registry, maxTimeoutSeconds: 300,
                       extra: { terms: t.terms, signature: t.signature, referrer: kind.extra.referrer, name: chain.usdcName, version: chain.usdcVersion } },
        body: { record: { publisher, repo, id }, fields, deposit, relay: facilitator },
    };
}

let chainInfo = null;
/** The SettlementRegistry and its USDC (address, EIP-712 name and version), read once per isolate. */
function chainOf(fangorn) {
    return (chainInfo ??= (async () => {
        const c = fangorn.getConfig(), registry = fangorn.getSettlementRegistry().getAddress();
        const pub = createPublicClient({ transport: http(c.rpcUrl) });
        const usdc = await pub.readContract({ address: registry, abi: parseAbi(["function usdc() view returns (address)"]), functionName: "usdc" });
        const str = (fn, fallback) => pub.readContract({ address: usdc, abi: parseAbi([`function ${fn}() view returns (string)`]), functionName: fn }).catch(() => fallback);
        return { chainId: c.chain.id, registry, usdc, usdcName: await str("name", "USDC"), usdcVersion: await str("version", "2") };
    })().catch((e) => { chainInfo = null; throw e; }));
}

async function sell(request, env, url) {
    if (!CONFIG.facilitator) return json({ error: "this app names no facilitator (CONFIG.facilitator)" }, 503);
    const [publisher, repo, ...rest] = url.pathname.slice("/paid/".length).split("/").map(decodeURIComponent);
    const id = rest.join("/");
    if (!/^0x[0-9a-fA-F]{40}$/.test(publisher ?? "") || !repo || !id) return json({ error: "GET /paid/<publisher>/<repo>/<record id>" }, 400);
    const { fangorn } = reader(env);
    const read = async (p, r, i) => (await fangorn.engine.readRecord(p, r, i).catch(() => null))?.payload ?? null;
    let q;
    try { q = await quoteOf({ publisher, repo, id, read, chain: await chainOf(fangorn), facilitator: CONFIG.facilitator }); }
    catch (e) { return json({ error: e.message }, 502); }
    if (!q) return json({ error: "not for sale" }, 404);

    const resource = { url: url.href, mimeType: "application/json", serviceName: CONFIG.name, description: `${CONFIG.name}: ${id}` };
    const required = (error) => {
        const r = { x402Version: 2, error, resource, accepts: [q.requirement] };
        return json({ ...r, ...q.body }, 402, { "payment-required": b64json(r) });
    };
    const header = request.headers.get("PAYMENT-SIGNATURE");
    if (!header) return required("payment required");
    let payment;
    try { payment = JSON.parse(atob(header)); } catch { return required("PAYMENT-SIGNATURE is not base64 JSON"); }
    const paymentPayload = { x402Version: 2, resource, accepted: q.requirement, payload: payment?.payload };
    const call = (path) => fetch(`${CONFIG.facilitator}/${path}`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ x402Version: 2, paymentPayload, paymentRequirements: q.requirement }) })
        .then((r) => r.json()).catch((e) => ({ error: `facilitator ${path}: ${e.message}` }));
    const verified = await call("verify");
    if (!verified.isValid) return required(verified.invalidReason ?? verified.error ?? "payment did not verify");
    const settled = await call("settle");
    if (!settled.success) return required(settled.errorReason ?? settled.error ?? "settlement failed");
    return json({ ...q.body, settlement: settled }, 200, { "payment-response": b64json(settled) });
}

const BY_ORIGIN = new Set(["/.well-known/agent-card.json"]);

const worker = {
    async fetch(request, env) {
        CONFIG = env.CONFIG ?? CONFIG;
        const url = new URL(request.url);
        const p = url.pathname;
        if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
        if (p.startsWith("/view/")) return viewFile(env, p.slice("/view/".length));
        if (p === "/mcp") return serveMcp(request, env, url);
        if (p === "/doc") return doc(request, env, url);
        if (p.startsWith("/paid/")) return CONFIG.paid ? sell(request, env, url) : json({ error: "nothing is sold here" }, 404);

        let res = await env.ASSETS.fetch(request);
        // A site built before its URL was known (`westmarch build`, under the deploy button) names
        // ORIGIN wherever it means its own: it is wherever it is served from.
        if (res.ok && BY_ORIGIN.has(p)) {
            const body = (await res.text()).replaceAll(ORIGIN, url.origin);
            res = new Response(body, { status: res.status, headers: res.headers });
            res.headers.delete("content-length");
        }
        const out = new Response(res.body, res);
        if (p === "/.well-known/agent-card.json") out.headers.set("access-control-allow-origin", "*");
        if (p.startsWith("/assets/")) out.headers.set("cache-control", "public, max-age=31536000, immutable");
        return out;
    },
    async scheduled(_event, env, ctx) {
        CONFIG = env.CONFIG ?? CONFIG;
        ctx.waitUntil(index(env));
    },
};
export default worker;

// ── self-check: `node site/worker.js` — a fake bucket, a fake AI binding, a fake registry ──
if (typeof process !== "undefined" && import.meta.url === `file://${process.argv[1]}` && process.argv[1]?.endsWith("/worker.js")) {
    const { localFangorn } = await import("../src/publish/view.js");
    const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); };

    const objs = new Map();
    const object = (k) => { const b = objs.get(k).bytes; return { body: new Blob([b]).stream(), uploaded: objs.get(k).at,
        arrayBuffer: async () => b, text: async () => new TextDecoder().decode(b), json: async () => JSON.parse(new TextDecoder().decode(b)) }; };
    const VIEW = {
        get: async (k) => (objs.has(k) ? object(k) : null),
        head: async (k) => (objs.has(k) ? {} : null),
        put: async (k, b) => { objs.set(k, { bytes: typeof b === "string" ? new TextEncoder().encode(b) : b, at: new Date(Date.now() + objs.size) }); },
        delete: async (ks) => { for (const k of [ks].flat()) objs.delete(k); },
        list: async ({ prefix, delimiter }) => {
            const ks = [...objs.keys()].filter((k) => k.startsWith(prefix)).sort();
            const rest = (k) => k.slice(prefix.length);
            if (!delimiter) return { objects: ks.map((key) => ({ key })), truncated: false };
            return { objects: ks.filter((k) => !rest(k).includes("/")).map((key) => ({ key })), truncated: false,
                     delimitedPrefixes: [...new Set(ks.filter((k) => rest(k).includes("/")).map((k) => `${prefix + rest(k).split("/")[0]}/`))] };
        },
    };
    const a = await takeLock(VIEW);
    eq([!!a, await takeLock(VIEW)], [true, null], "a held lock skips the next run");
    objs.set(LOCK, { bytes: new TextEncoder().encode(`${Date.now() - LOCK_MS - 1} dead`), at: new Date() });
    const b = await takeLock(VIEW);
    await a.release();
    eq([!!b, objs.has(LOCK)], [true, true], "a silent lock is taken over, and its dead owner can't release the new one");
    await b.release();
    eq(objs.has(LOCK), false, "the owner releases its own lock");

    // Words → a 768-d vector, so a query shares dimensions with the rows that share its words.
    const calls = [];
    const AI = { run: async (model, { text }) => { calls.push({ model, text });
        return { data: text.map((t) => { const v = new Array(768).fill(0); for (const w of t.toLowerCase().split(/\W+/)) if (w.length > 3) v[[...w].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 256, 7)] += 1; return v; }) }; } };
    const env = { VIEW, AI, ASSETS: { fetch: async (r) => new Response(new URL(r.url).pathname.endsWith("agent-card.json") ? `{"url":"${ORIGIN}/"}` : "<!doctype html>site") },
                  CONFIG: { app: "shop", name: "Shop", description: "Things for a room.", repos: [] } };
    CONFIG = env.CONFIG;

    const APP = `0x${"ab".repeat(32)}`, OWNER = `0x${"11".repeat(20)}`, PUB = `0x${"22".repeat(20)}`, TAG = "shop.item.v1";
    const rec = (cid, type, payload) => ({ id: cid, cid, type, payload });
    CONFIG.schema = { types: { [TAG]: { role_map: { identity: "sku", title: "name", text: "about", media: "doc" } } } };
    const chain = {
        [`${PUB}/shop`]: { records: [
            rec("c1", TAG, { sku: "a1", name: "Oak table", about: "a solid oak dining table", doc: "https://docs.example/oak.pdf" }),
            rec("c2", TAG, { sku: "b2", name: "Brass lamp", about: "a brass reading lamp" })] },
    };
    const fangorn = localFangorn(chain);
    await publishView({ fangorn, app: APP, schema: CONFIG.schema, store: r2Store(VIEW), embedBatch: encode(env, DOCUMENT), embedder: WORKER_EMBEDDER, log: () => {} });
    eq([calls[0].model, calls[0].text[0].startsWith(DOCUMENT)], [AI_MODEL, true], "documents go to the AI binding with the document prompt");

    const call = async (method, params) => (await (await worker.fetch(new Request("https://shop.test/mcp",
        { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }), env)).json());
    eq((await call("initialize", {})).result.serverInfo.name, "Shop", "initialize names the app");
    const names = (await call("tools/list")).result.tools.map((t) => t.name);
    for (const t of ["describe", "search", "get", "similar", "count", "browse"]) if (!names.includes(t)) throw new Error(`missing tool ${t}: ${names}`);
    const described = JSON.parse((await call("tools/call", { name: "describe", arguments: {} })).result.content[0].text);
    eq(described.views.map((v) => v.rows), [2], "describe reads the catalog from R2");
    eq(described.views[0].repos.map((r) => [r.publisher, r.repo, r.rows]), [[PUB, "shop", 2]], "describe names each repo's publisher");
    const found = JSON.parse((await call("tools/call", { name: "search", arguments: { query: "reading lamp", limit: 1 } })).result.content[0].text);
    eq([found.ranked_by, found.hits[0].title, found.hits[0].publisher], ["meaning", "Brass lamp", PUB], "search ranks by meaning, the query embedded by the same runtime; a hit names its publisher");
    const theirs = JSON.parse((await call("tools/call", { name: "search", arguments: { query: "lamp", where: { owner: OWNER } } })).result.content[0].text);
    eq(theirs.hits.length, 0, "search narrows to one publisher with where.owner");
    if (!calls.at(-1).text[0].startsWith(QUERY)) throw new Error("the query goes to the AI binding with the query prompt");
    eq((await (await worker.fetch(new Request("https://shop.test/mcp", { method: "POST", body: '{"jsonrpc":"2.0","method":"notifications/initialized"}' }), env)).status), 202, "a notification is accepted, not answered");

    const cat = await worker.fetch(new Request("https://shop.test/view/cdn/catalog"), env);
    const card = await worker.fetch(new Request("https://shop.example.workers.dev/.well-known/agent-card.json"), env);
    eq([await card.json(), card.headers.get("access-control-allow-origin")], [{ url: "https://shop.example.workers.dev/" }, "*"], "a card built before its URL was known names the origin it is served from");
    eq([cat.status, cat.headers.get("access-control-allow-origin"), (await cat.json()).domains[0].link_hosts], [200, "*", ["docs.example"]], "the view is served from R2, with the hosts its records link to");
    eq((await worker.fetch(new Request("https://shop.test/doc?u=https://evil.example/x.pdf"), env)).status, 403, "/doc refuses a host no record links to");
    eq((await worker.fetch(new Request("https://shop.test/view/cdn/nope"), env)).status, 404, "a missing file is a 404");

    // A paid record's quote: its signed terms as the requirement, its handles and deposit beside it.
    const H = (b) => `0x${b.repeat(32)}`;
    const terms = { terms: { publisher: PUB, repo: H("22"), key: H("33"), price: "10000", shareBps: 500, generation: "0", deadline: "2000000000" }, signature: "0x12" };
    const handle = { "@type": "handle", gadget: "field-v1", generation: "0", cid: "bafy" };
    const records = { [`${PUB}/shop/a1`]: { name: "Oak", body: handle, "@terms": terms }, [`${PUB}/shop/@deposit/0`]: { "@type": "deposit", sealed: "0x99" },
                      [`${PUB}/shop/free`]: { name: "Free" } };
    const read = async (p, r, i) => records[`${p}/${r}/${i}`] ?? null;
    const chainInfo = { chainId: 84532, registry: `0x${"e0".repeat(20)}`, usdc: `0x${"aa".repeat(20)}`, usdcName: "USDC", usdcVersion: "2" };
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (u) => (u === "https://fac/supported"
        ? new Response(JSON.stringify({ kinds: [{ x402Version: 2, scheme: "fangorn", network: "eip155:84532", extra: { referrer: `0x${"fe".repeat(20)}` } }] }))
        : realFetch(u));
    try {
        const q = await quoteOf({ publisher: PUB, repo: "shop", id: "a1", read, chain: chainInfo, facilitator: "https://fac" });
        eq([q.requirement.scheme, q.requirement.amount, q.requirement.payTo, q.requirement.extra.referrer, q.requirement.extra.terms.key],
           ["fangorn", "10000", chainInfo.registry, `0x${"fe".repeat(20)}`, H("33")], "the requirement is the record's signed terms, paid to the registry, with the facilitator's referrer");
        eq([Object.keys(q.body.fields), q.body.deposit.sealed, q.body.relay], [["body"], "0x99", "https://fac"], "the body carries the sealed fields' handles, the deposit and the relay");
        eq(await quoteOf({ publisher: PUB, repo: "shop", id: "free", read, chain: chainInfo, facilitator: "https://fac" }), null, "a record with no terms is not for sale");
    } finally { globalThis.fetch = realFetch; }
    eq((await worker.fetch(new Request(`https://shop.test/paid/${PUB}/shop/a1`), env)).status, 404, "an app without `paid` sells nothing");

    // The incremental scan: only updates since the last run.
    const logs = [{ publisher: PUB, repo: "shop", head: "0x01", t: 10n }, { publisher: OWNER, repo: "notes", head: "0x02", t: 12n }];
    const asked = [];
    let block = 20n;
    const r = { chain: { getBlockNumber: async () => block }, fangorn: { getRegistry: () => ({
        log: async (_f, from, to) => { asked.push([from, to]); return logs.filter((l) => l.t >= from && l.t <= to); },
    }) } };
    CONFIG = { ...CONFIG, fromBlock: "5" };
    const state = { block: null, repos: {} };
    eq((await presented(r, state)).map((t) => t.repo).sort(), ["notes", "shop"], "the first run scans from the app's fromBlock");
    logs.push({ publisher: PUB, repo: "shop", head: "0x03", t: 25n });
    block = 30n;
    eq((await presented(r, state)).map((t) => [t.repo, t.root]).sort(), [["notes", "0x02"], ["shop", "0x03"]], "the next reads only what is new");
    eq(asked.map((a) => a.map(String)), [["5", "20"], ["21", "30"]], "each run starts where the last ended");
    console.log("worker.js self-check ok — the lens embeds through the AI binding, /mcp serves the view's tools from R2 with queries embedded by the same runtime, the view and /doc are served from R2, a paid record is quoted from its signed terms, and the indexer scans only new updates");
}
