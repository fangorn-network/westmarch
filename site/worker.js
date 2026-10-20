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
//   GET /paid/<item id>   with CONFIG.paid: 402 + the price; with a valid X-PAYMENT header, the
//                         facilitator verifies and settles it, then the record's KEY is returned
//   POST /paid {ids}      many keys for one price, paid by one payment or several (vouchers)
//   POST /key {ids, tokenId, issuedAt, signature}
//                         keys for a member: Barliman checks the signed request against the
//                         MembershipRegistry (`canRead`), and nothing is paid here
//   anything else         the static site (the stock page, the card)
//
// The paid records are not here. Each is already in the app's committed rows on IPFS,
// encrypted (`paid_ct`, AES-256-GCM), with the sha256 of its plaintext beside it. This worker
// sells only the key, HMAC-SHA256(PAID_SECRET, id): the buyer holds the ciphertext before
// paying, so nobody pays for a record that does not exist, and decrypts and checks it after.
//
// Bindings: VIEW (R2), AI (Workers AI), ASSETS (the site), CONFIG (a JSON var: app, name,
// description, fromBlock, repos, paid, deployment), and optionally RPC_URL and IPFS_GATEWAY
// (vars) and PAID_SECRET (a secret).

import { Fangorn, FangornConfig, SupportedNetworks, repoExcluded } from "@fangorn-network/sdk";
import { createPublicClient, http } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { EMBED_MODEL, DOCUMENT, QUERY, matryoshka } from "../src/core/embed.js";
import { configure, resetShard } from "../src/core/shard.js";
import { publishView, r2Store } from "../src/publish/view.js";
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
// A run past this is presumed dead and its lock taken over. Cron runs get 15 minutes.
const LOCK_MS = 14 * 60_000;

// CONFIG.network: the SDK's network name ("baseSepolia"); absent, its default.
const network = () => SupportedNetworks[CONFIG.network] ?? FangornConfig;

function reader(env) {
    // CONFIG.deployment: another deployment's addresses (and appRegistryFromBlock as a string),
    // for a testnet fork or a local chain. Absent, the network's.
    const d = CONFIG.deployment ?? {};
    const config = { ...network(), ...d, ...(d.appRegistryFromBlock ? { appRegistryFromBlock: BigInt(d.appRegistryFromBlock) } : {}),
                     ...(env.RPC_URL ? { rpcUrl: env.RPC_URL } : {}) };
    const fangorn = Fangorn.create({ privateKey: generatePrivateKey(), config, appId: CONFIG.app,
        storage: { signedUrl: env.IPFS_GATEWAY ? { gateway: env.IPFS_GATEWAY } : {} } });
    return { fangorn, chain: createPublicClient({ chain: config.chain, transport: http(config.rpcUrl) }) };
}

/**
 * What the app presents now, kept across runs in R2: each run reads only the updates since
 * the last, then asks which repos the app presents: its members' (`presents`), less what it
 * excludes. Neither membership nor exclusions move a head, so they are read, not followed.
 * ponytail: reads every publisher's updates, and 4 contract reads per repo per run; follow
 * the app's members and ExclusionChanged events when an app holds enough repos to show it.
 */
export async function presented({ fangorn, chain }, state) {
    const to = await chain.getBlockNumber();
    const from = state.block == null ? BigInt(CONFIG.fromBlock ?? network().appRegistryFromBlock) : BigInt(state.block) + 1n;
    const app = fangorn.getAppId();
    const registry = fangorn.getRegistry();
    if (from <= to) for (const e of await registry.log({}, from, to))
        state.repos[`${e.publisher.toLowerCase()}/${e.repo}`] = { owner: e.publisher, repo: e.repo, root: e.head };
    state.block = String(to);
    const all = Object.values(state.repos);
    const kept = await Promise.all(all.map(async (r) => await registry.presents(app, r.owner)
        && !(await repoExcluded(registry, app, { publisher: r.owner, repo: r.repo }))));
    return all.filter((_, i) => kept[i]);
}

export async function index(env, { log = console.log } = {}) {
    const lock = await env.VIEW.get(LOCK);
    if (lock && Date.now() - Number(await lock.text()) < LOCK_MS) return log("index: a run is in progress; skipped");
    await env.VIEW.put(LOCK, String(Date.now()));
    try {
        const state = (await (await env.VIEW.get(STATE))?.json()) ?? { block: null, repos: {} };
        const r = reader(env);
        const report = await publishView({
            fangorn: r.fangorn, app: CONFIG.app, repos: CONFIG.repos, store: r2Store(env.VIEW),
            presented: await presented(r, state), embedBatch: encode(env, DOCUMENT), embedder: await embedderOf(env), log,
        });
        await env.VIEW.put(STATE, JSON.stringify(state));
        log(`index: through block ${state.block}, ${Object.keys(report).length} domain(s) changed`);
        return report;
    } finally {
        await env.VIEW.delete(LOCK);
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
        case "tools/list": {
            const t = await tools(env, origin);
            return ok({ tools: t ? t.tools : [] });
        }
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

const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "X-PAYMENT, content-type", "access-control-expose-headers": "X-PAYMENT-RESPONSE" };
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

/** A record's key: HMAC-SHA256(PAID_SECRET, id), hex. The same derivation as the sources that
 *  encrypt (and x402.js's paidKey). */
async function keyFor(env, id) {
    if (!env.PAID_SECRET) throw new Error("PAID_SECRET is not set (wrangler pages secret put PAID_SECRET)");
    const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.PAID_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(id)));
    return [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const keysFor = async (env, ids) => Object.fromEntries(await Promise.all(ids.map(async (id) => [id, await keyFor(env, id)])));

async function facilitator(path, payment, requirements) {
    // A network failure is an answer too: thrown, it would turn a half-settled batch into a 500.
    let r;
    try {
        r = await fetch(`${CONFIG.paid.facilitator}/${path}`, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ x402Version: 1, paymentPayload: payment, paymentRequirements: requirements }),
        });
    } catch (e) { return { error: `facilitator ${path}: ${e.message}` }; }
    const text = await r.text();
    try { return JSON.parse(text); } catch { return { error: `facilitator ${path}: HTTP ${r.status} ${text.slice(0, 200)}` }; }
}

async function sell(request, env, url) {
    const P = CONFIG.paid;
    const id = decodeURIComponent(url.pathname.slice("/paid/".length));
    if (!id) return json({ error: "no id" }, 400);
    const requirements = {
        scheme: "exact", network: P.network, maxAmountRequired: P.price, resource: url.href,
        description: P.description, mimeType: "application/json", payTo: P.payTo,
        maxTimeoutSeconds: 120, asset: P.asset, extra: { name: P.name, version: P.version },
    };
    const refuse = (error) => json({ x402Version: 1, error, accepts: [requirements] }, 402);
    const header = request.headers.get("X-PAYMENT");
    if (!header) return refuse("X-PAYMENT header is required");
    let payment;
    try { payment = JSON.parse(atob(header)); } catch { return refuse("X-PAYMENT is not base64 JSON"); }
    const verified = await facilitator("verify", payment, requirements);
    if (!verified.isValid) return refuse(verified.invalidReason ?? verified.error ?? "payment did not verify");
    const settled = await facilitator("settle", payment, requirements);
    if (!settled.success) return refuse(settled.errorReason ?? settled.error ?? "settlement failed");
    return json({ id, key: await keyFor(env, id) }, 200, { "x-payment-response": btoa(JSON.stringify(settled)) });
}

// POST /paid {ids}: many keys, one price. 402 with the total; then X-PAYMENT may be one payment
// or a JSON array of them (an agent's vouchers) that add up to it. The only subrequests are the
// facilitator's (2 per payment, 50 on the free plan), hence MAX_PAYMENTS; keys cost nothing.
const MAX_BATCH = 1000, MAX_PAYMENTS = 10;
async function sellBatch(request, env, url) {
    const P = CONFIG.paid;
    let ids;
    try { ids = [...new Set((await request.json()).ids)].filter((x) => typeof x === "string"); } catch { return json({ error: "body must be {\"ids\": [...]}" }, 400); }
    if (!ids.length || ids.length > MAX_BATCH) return json({ error: `between 1 and ${MAX_BATCH} ids per purchase` }, 400);
    const found = ids, missing = [];
    const total = BigInt(P.price) * BigInt(found.length);
    const requirements = (amount) => ({
        scheme: "exact", network: P.network, maxAmountRequired: String(amount), resource: url.href,
        description: P.description, mimeType: "application/json", payTo: P.payTo,
        maxTimeoutSeconds: 120, asset: P.asset, extra: { name: P.name, version: P.version },
    });
    const refuse = (error, more = {}) => json({ x402Version: 1, error, accepts: [requirements(total)], found, missing, ...more }, 402);
    const header = request.headers.get("X-PAYMENT");
    if (!header) return refuse("X-PAYMENT header is required");
    let payments;
    try { payments = [JSON.parse(atob(header))].flat(); } catch { return refuse("X-PAYMENT is not base64 JSON"); }
    if (payments.length > MAX_PAYMENTS) return refuse(`at most ${MAX_PAYMENTS} payments per purchase`);
    const auths = payments.map((p) => p?.payload?.authorization ?? {});
    if (new Set(auths.map((a) => a.nonce)).size !== auths.length) return refuse("a payment is repeated");
    if (auths.some((a) => String(a.to).toLowerCase() !== P.payTo.toLowerCase())) return refuse("a payment is not to this app");
    let sum = 0n;
    try { for (const a of auths) sum += BigInt(a.value); } catch { return refuse("a payment has no amount"); }
    if (sum !== total) return refuse(`payments add up to ${sum}, the price is ${total}`);
    for (const [i, p] of payments.entries()) {
        const v = await facilitator("verify", p, requirements(auths[i].value));
        if (!v.isValid) return refuse(`payment ${i + 1}: ${v.invalidReason ?? v.error ?? "did not verify"}`);
    }
    // Settle one by one. A spent voucher (or one the wallet can no longer cover) passes verify
    // and fails here. If that happens after others settled, the buyer still gets what the
    // settled money pays for, never more: a spent voucher riding along with a fresh one buys
    // only what the fresh one pays for. `paid` and `rejected` name the vouchers (by nonce) so
    // the buyer's stack can drop them either way.
    const receipts = [];
    let settled = 0n;
    for (const [i, p] of payments.entries()) {
        const s = await facilitator("settle", p, requirements(auths[i].value));
        if (!s.success) {
            const error = `payment ${i + 1}: ${s.errorReason ?? s.error ?? "settlement failed"}`;
            if (!receipts.length) return refuse(error, { rejected: [auths[i].nonce] });
            const n = Number(settled / BigInt(P.price));
            return json({ keys: await keysFor(env, found.slice(0, n)), missing, undelivered: found.slice(n), receipts, error,
                paid: auths.slice(0, i).map((a) => a.nonce), rejected: [auths[i].nonce] });
        }
        receipts.push(s);
        settled += BigInt(auths[i].value);
    }
    return json({ keys: await keysFor(env, found), missing, receipts, paid: auths.map((a) => a.nonce) });
}

// POST /key: keys for a member. Barliman recovers who signed the request and asks the
// MembershipRegistry whether that address may read this app now; this worker trusts its answer.
// ponytail: one Barliman call per request; cache {tokenId, reader} → until if it gets busy.
async function member(request, env) {
    const M = CONFIG.paid.membership;
    if (!M) return json({ error: "this app sells no memberships" }, 404);
    let b;
    try { b = await request.json(); } catch { return json({ error: "body must be JSON" }, 400); }
    const ids = [...new Set(b?.ids ?? [])].filter((x) => typeof x === "string");
    if (!ids.length || ids.length > MAX_BATCH) return json({ error: `between 1 and ${MAX_BATCH} ids` }, 400);
    let check;
    try {
        const r = await fetch(`${M.barliman}/check`, { method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ appId: M.appId, tokenId: String(b.tokenId), ids, issuedAt: b.issuedAt, signature: b.signature }) });
        check = await r.json();
    } catch (e) { return json({ error: `could not check the membership: ${e.message}` }, 502); }
    if (!check.ok) return json({ error: check.error ?? "this membership cannot read this app now", until: check.until ?? null }, 403);
    return json({ keys: await keysFor(env, ids), reader: check.reader, until: check.until });
}

const worker = {
    async fetch(request, env) {
        CONFIG = env.CONFIG ?? CONFIG;
        const url = new URL(request.url);
        const p = url.pathname;
        if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
        if (p.startsWith("/view/")) return viewFile(env, p.slice("/view/".length));
        if (p === "/mcp") return serveMcp(request, env, url);
        if (p === "/doc") return doc(request, env, url);
        if (p === "/paid" && request.method === "POST") return CONFIG.paid ? sellBatch(request, env, url) : json({ error: "nothing is sold here" }, 404);
        if (p.startsWith("/paid/")) return CONFIG.paid ? sell(request, env, url) : json({ error: "nothing is sold here" }, 404);
        if (p === "/key" && request.method === "POST") return CONFIG.paid ? member(request, env) : json({ error: "nothing is sold here" }, 404);

        const res = await env.ASSETS.fetch(request);
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
    const { localFangorn, SCHEMA_REPO, TYPE_TAG } = await import("../src/publish/view.js");
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
    // Words → a 768-d vector, so a query shares dimensions with the rows that share its words.
    const calls = [];
    const AI = { run: async (model, { text }) => { calls.push({ model, text });
        return { data: text.map((t) => { const v = new Array(768).fill(0); for (const w of t.toLowerCase().split(/\W+/)) if (w.length > 3) v[[...w].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 256, 7)] += 1; return v; }) }; } };
    const env = { VIEW, AI, ASSETS: { fetch: async () => new Response("<!doctype html>site") },
                  CONFIG: { app: "shop", name: "Shop", description: "Things for a room.", repos: [] } };
    CONFIG = env.CONFIG;

    const APP = `0x${"ab".repeat(32)}`, OWNER = `0x${"11".repeat(20)}`, PUB = `0x${"22".repeat(20)}`, TAG = "shop.item.v1";
    const rec = (cid, type, payload) => ({ id: cid, cid, type, payload });
    const chain = {
        [`${OWNER}/${SCHEMA_REPO}`]: { records: [rec("t", TYPE_TAG, { tag: TAG, role_map: { identity: "sku", title: "name", text: "about", media: "doc" } })] },
        [`${PUB}/shop`]: { records: [
            rec("c1", TAG, { sku: "a1", name: "Oak table", about: "a solid oak dining table", doc: "https://docs.example/oak.pdf" }),
            rec("c2", TAG, { sku: "b2", name: "Brass lamp", about: "a brass reading lamp" })] },
    };
    const fangorn = localFangorn(chain, { appId: APP, owner: OWNER });
    await publishView({ fangorn, app: APP, store: r2Store(VIEW), embedBatch: encode(env, DOCUMENT), embedder: WORKER_EMBEDDER, log: () => {} });
    eq([calls[0].model, calls[0].text[0].startsWith(DOCUMENT)], [AI_MODEL, true], "documents go to the AI binding with the document prompt");

    const call = async (method, params) => (await (await worker.fetch(new Request("https://shop.test/mcp",
        { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }), env)).json());
    eq((await call("initialize", {})).result.serverInfo.name, "Shop", "initialize names the app");
    const names = (await call("tools/list")).result.tools.map((t) => t.name);
    for (const t of ["describe", "search", "get", "similar", "count", "browse"]) if (!names.includes(t)) throw new Error(`missing tool ${t}: ${names}`);
    const described = JSON.parse((await call("tools/call", { name: "describe", arguments: {} })).result.content[0].text);
    eq(described.views.map((v) => v.rows), [2], "describe reads the catalog from R2");
    const found = JSON.parse((await call("tools/call", { name: "search", arguments: { query: "reading lamp", limit: 1 } })).result.content[0].text);
    eq([found.ranked_by, found.hits[0].title], ["meaning", "Brass lamp"], "search ranks by meaning, the query embedded by the same runtime");
    if (!calls.at(-1).text[0].startsWith(QUERY)) throw new Error("the query goes to the AI binding with the query prompt");
    eq((await (await worker.fetch(new Request("https://shop.test/mcp", { method: "POST", body: '{"jsonrpc":"2.0","method":"notifications/initialized"}' }), env)).status), 202, "a notification is accepted, not answered");

    const cat = await worker.fetch(new Request("https://shop.test/view/cdn/catalog"), env);
    eq([cat.status, cat.headers.get("access-control-allow-origin"), (await cat.json()).domains[0].link_hosts], [200, "*", ["docs.example"]], "the view is served from R2, with the hosts its records link to");
    eq((await worker.fetch(new Request("https://shop.test/doc?u=https://evil.example/x.pdf"), env)).status, 403, "/doc refuses a host no record links to");
    eq((await worker.fetch(new Request("https://shop.test/view/cdn/nope"), env)).status, 404, "a missing file is a 404");

    // The incremental scan: only updates since the last run, membership and exclusions applied every run.
    const STRANGER = "0x" + "9".repeat(40);
    const logs = [{ publisher: PUB, repo: "shop", head: "0x01", t: 10n }, { publisher: OWNER, repo: "notes", head: "0x02", t: 12n },
                  { publisher: STRANGER, repo: "spam", head: "0x04", t: 14n }];
    const asked = [];
    let excluded = null, block = 20n;
    const r = { chain: { getBlockNumber: async () => block }, fangorn: { getAppId: () => APP, getRegistry: () => ({
        log: async (_f, from, to) => { asked.push([from, to]); return logs.filter((l) => l.t >= from && l.t <= to); },
        presents: async (_app, p) => p !== STRANGER,
        exclusionCount: async (_app, x) => (excluded && x.publisher === excluded && !x.repo ? 1 : 0),
    }) } };
    CONFIG = { ...CONFIG, fromBlock: "5" };
    const state = { block: null, repos: {} };
    eq((await presented(r, state)).map((t) => t.repo).sort(), ["notes", "shop"], "the first run scans from the app's fromBlock, and keeps members only");
    logs.push({ publisher: PUB, repo: "shop", head: "0x03", t: 25n });
    block = 30n;
    excluded = OWNER;
    eq((await presented(r, state)).map((t) => [t.repo, t.root]), [["shop", "0x03"]], "the next reads only what is new, and drops what the app excludes");
    eq(asked.map((a) => a.map(String)), [["5", "20"], ["21", "30"]], "each run starts where the last ended");
    console.log("worker.js self-check ok — the lens embeds through the AI binding, /mcp serves the view's tools from R2 with queries embedded by the same runtime, the view and /doc are served from R2, and the indexer scans only new updates and applies membership and exclusions every run");
}
