// A Fangorn indexer on Cloudflare: one Worker that follows repos, and serves their view, search and MCP.
// Deploy it as is (configured by CONFIG), or wrap it with an app's own MCP tools: indexer({ name, instructions, tools }).
//
//   cron (every minute)  one filtered log read: did any followed repo move? If so, restitch from the saved
//                        stitch (src/stitcher.js) into D1 (src/d1.js), at most FOLD_PER_RUN blocks a run: a catch-up
//                        from far back takes a few runs, each saving its step. Then embed rows that have no vector
//                        yet, with Workers AI, a bounded batch per run.
// The API every deployment serves is specified in worker/API.md (and worker/openapi.yaml).
//
//   GET /api.json        what this deployment is: name, network, gateway, repos, types, mcp, and the connect URL
//   GET /view.json       the view: every record, the stitch, the gateway
//                        With CONFIG.publishView, each new root's view also goes to Fangorn (storage, and a `view`
//                        record in that repo), so a static page hosted anywhere finds it on chain.
//   GET /search?q=&k=&type=  records by meaning: the query embedded here, by the same model as the rows
//   GET /repos?q=&publisher=&k=  with CONFIG.index "repos": { stitch, repos }, by meaning, or newest change first
//   POST /publish        { repo?, record, file?, pin? } into the bearer's own repo, on their fangorn.network grant; the app pays the
//                        gas, up to CONFIG.publishPerDay a day (unset: off). See worker/publisher.js.
//   POST /mcp            search, repos, get, publish, and the app's tools (streamable HTTP, stateless): add the URL to a client.
//                        A bearer token reaches the tools as ctx.auth.
//   anything else        ASSETS (a static site), when bound
//
// CONFIG.index "repos" indexes repos instead of records: each one's head and agent card (src/repos.js). With follow
// ["*"] that's Fangorn's registry. Its MCP tools are find, repo and read. (No publishView there: with "*" the view's
// own repo is in the stitch, so each publish would move the root and publish again.)
//
// Bindings: DB (D1), AI (Workers AI), ASSETS?, CONFIG (a JSON var: follow (publisher/repo pairs) or repos and publishers?,
// network, publishView?, name?, publishPerDay?, grantPerDay?, instructions?, types?, schema?, rules?, index?), VALIDATOR (a service
// binding to the app's validator Worker, worker/validator.js) when CONFIG names rules, and the secret INDEXER_KEY: it signs the stitch blocks' uploads and the view's commits, and pays their gas.

import { Fangorn, SupportedNetworks } from "@fangorn-network/sdk";
import { DOCUMENT, QUERY, matryoshka } from "../src/gemma.js";
import { patternsOf, reposOf, stitcher } from "../src/stitcher.js";
import { d1Index } from "../src/d1.js";
import { d1Repos } from "../src/repos.js";
import { publishView } from "../src/view.js";
import { mcpCall, BASE, REPOS_INSTRUCTIONS } from "./mcp.js";
import { publish, FANGORN } from "./publisher.js";
import { checkerOf, fileOf, gatesOf, listOf } from "../src/validate.js";

const AI_MODEL = "@cf/google/embeddinggemma-300m"; // EmbeddingGemma-300m, as src/embed.js runs it locally
const EMBED_PER_RUN = 100;
const CHECK_PER_RUN = 25; // each is a file read and a call to the validator Worker: subrequests
// The most blocks one run folds: a catch-up from far back (a repos index starts from nothing) goes in steps that each
// save, rather than one fold whose time and requests grow with the network's history. On Base Sepolia (2 s blocks, a
// 50,000-block log window) that's about 46 days of log. Measured there (2026-11-23), a `follow: ["*"]` catch-up from
// nothing took 5 steps: at most 18 s, 0.3 s of CPU and 314 RPC requests a step. Well inside a minute, so runs don't
// overlap; keep it so if this changes.
const FOLD_PER_RUN = 2_000_000;
// How far below the head the gate looks again on the next run. Its log read is filtered by repo, so (unlike a fold)
// it can't be checked against the contract's log root, and a load-balanced RPC's log backend can lag the one that
// answered the clock, leaving out the newest entries. 30 blocks: a minute on Base Sepolia, one cron interval.
const GATE_MARGIN = 30n;
// ponytail: no daily cap; rows are embedded once, so only a flood of publishes could run past Workers AI's free
// allowance (~30k rows a day). Count rows per UTC day in meta when that's a risk.

// The named network exactly as the SDK has it. Not spread over FangornConfig: a network without its own upload worker
// or SettlementRegistry (Base mainnet) would inherit Base Sepolia's, and an unknown name would silently be Base Sepolia.
export const networkOf = (env) => {
    const net = env.CONFIG.network ?? "baseSepolia";
    if (!SupportedNetworks[net]) throw new Error(`unknown network "${net}": one of ${Object.keys(SupportedNetworks).join(", ")}`);
    return SupportedNetworks[net];
};
/**
 * The index CONFIG.index names: "repos" (a row per repo: head and card, src/repos.js), else records (src/d1.js), gated
 * by `gate` (gatesOf(CONFIG)): with schemas or rules in CONFIG, it serves only records that passed them.
 */
export const indexOf = (env, fangorn, gate) => (env.CONFIG.index === "repos" ? d1Repos : d1Index)({ db: env.DB, fangorn, gate });
export const fangornOf = (env) => Fangorn.create({ privateKey: env.INDEXER_KEY, config: networkOf(env), storage: { signedUrl: {} } });
const encode = (env, prompt) => async (texts) =>
    (await env.AI.run(AI_MODEL, { text: texts.map((t) => prompt + t) })).data.map((v) => matryoshka(v));
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type, authorization, mcp-protocol-version", "access-control-allow-methods": "POST" };
const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json", "access-control-allow-origin": "*" } });

/** GET /api.json: what this deployment is and how to use it (worker/API.md, Manifest). `origin` is the API's own. */
export function manifest(config, { origin, gateway, name }) {
    const repos = reposOf(config) ?? [], publish = Boolean(config.publishPerDay), mcp = `${origin}/mcp`;
    return {
        name, network: config.network ?? "baseSepolia", gateway, repos, types: config.types ?? {}, schema: config.schema ?? null, rules: listOf(config.rules), publish, mcp,
        ...(publish && { connect: `${FANGORN}/#/connect?${new URLSearchParams({ app: origin, repos: repos.join(","), name, mcp, ...(config.grantPerDay && { perDay: String(config.grantPerDay) }) })}` }),
    };
}

/** One cron run. `fangorn` and `step` (blocks folded at most) are for tests; the Worker passes neither. */
export async function update(env, log = console.log, { fangorn = fangornOf(env), step = FOLD_PER_RUN } = {}) {
    const config = env.CONFIG, gate = await gatesOf(config), index = indexOf(env, fangorn, gate);
    const registry = fangorn.getRegistry(), head = await registry.clock();
    // Where the gate starts: after the block the saved stitch is folded up to (saved in the same batch as its records),
    // or after the block an earlier run's gate found nothing up to (`checked`), whichever is later.
    const saved = await index.getMeta("stitch"), checked = await index.getMeta("checked");
    const marks = [saved?.t, checked].filter((v) => v != null).map(BigInt);
    const from = marks.length ? marks.reduce((a, b) => (a > b ? a : b)) : null;
    // Fold without asking: a new or reseeded database (nothing to start from), a catch-up that stopped a step short of
    // the head, or a stitch of other patterns (the config changed: the stitcher starts over).
    const behind = from == null || saved?.caughtUp === false || JSON.stringify(saved?.patterns) !== JSON.stringify(patternsOf(config));
    // The gate: restitching uploads a new stitch whenever ANY repo on the network moved, so first ask the chain,
    // filtered by repo name, whether one we follow did. (With publishers named, every run restitches.)
    const names = reposOf(config);
    // A prefix pattern (one ending in *, e.g. lb-*) can't be asked for by name: restitch every run then.
    let moved = checked == null || config.publishers || !names || names.some((n) => n.endsWith("*"));
    for (const repo of moved ? [] : names)
        if ((await registry.log({ repo }, from + 1n, head)).length) { moved = true; break; }
    if (moved) log(`root ${await stitcher(fangorn, config, { store: index.store, lens: index.lens, step }).update()}`);
    // Nothing moved: the next gate starts GATE_MARGIN short of this head, in case the RPC's log lagged it.
    else if (head - GATE_MARGIN > from) await index.setMeta("checked", (head - GATE_MARGIN).toString());
    const cards = await index.cardsMissing?.();
    if (cards) log(`cards read ${cards}`);
    // The gate, before embedding: a refused record is never embedded. `verdicts` versions the view along with the root.
    if (gate) {
        const checker = await checkerOf(config, env.VALIDATOR);
        const { checked, refused } = await index.checkMissing((r, c) => checker.check(r, { ...c, file: fileOf(fangorn, r) }), CHECK_PER_RUN);
        if (checked) { log(`checked ${checked}, refused ${refused}`); await index.setMeta("verdicts", Date.now()); }
    }
    const n = await index.embedMissing(encode(env, DOCUMENT), EMBED_PER_RUN);
    if (n) log(`embedded ${n}`);
    const packed = await index.packVectors?.();
    if (packed) log(`vectors packed ${packed}`);
    // The view to Fangorn, once per root (and per batch of verdicts): `published` moves only when it landed, so a
    // failed run retries.
    // ponytail: a backfill under a new checker publishes once a run until it's through; skip while records are unchecked if that gas matters
    const s = await index.getMeta("stitch"), version = s && `${s.root}:${(await index.getMeta("verdicts")) ?? ""}`;
    if (config.publishView && s && version !== await index.getMeta("published")) {
        const view = { root: s.root, stitch: s.stitch, gateway: networkOf(env).ipfsGateway, records: await index.rows(), ...(gate && { refused: await index.refused() }) };
        log(`view published: ${await publishView(fangorn, config.publishView, view)}`);
        await index.setMeta("published", version);
    }
}

/**
 * The Worker: { scheduled, fetch }. `name` and `instructions` (a string, or gateway → string) describe its MCP
 * server; `tools` are the app's MCP tools (see worker/mcp.js), added to search, repos and get or replacing one.
 */
export function indexer({ name, instructions, tools = [] } = {}) {
    return {
        async scheduled(_, env, ctx) { ctx.waitUntil(update(env)); },

        async fetch(req, env) {
            const gate = await gatesOf(env.CONFIG), url = new URL(req.url), index = indexOf(env, undefined, gate), gateway = networkOf(env).ipfsGateway;
            const config = env.CONFIG, appName = name ?? config.name ?? "westmarch", meta = { get: index.getMeta, set: index.setMeta };
            const info = () => manifest(config, { origin: url.origin, gateway, name: appName });
            if (url.pathname === "/api.json") return json(info());
            if (url.pathname === "/view.json") {
                const s = await index.getMeta("stitch");
                if (!s) return json({ error: "not indexed yet" }, 404);
                // The view only changes with the root: cached at the edge under it, so every row is read once per root per
                // Cloudflare location, and never stale. s-maxage is for that cache; browsers ask again each time.
                // ponytail: the Cache API is a no-op on *.workers.dev, so there every request still reads every row.
                const version = gate ? `&gate=${gate.all}&verdicts=${(await index.getMeta("verdicts")) ?? ""}` : "";
                const key = new Request(`${url.origin}/view.json?root=${s.root}${version}`), hit = await caches.default.match(key);
                if (hit) return hit;
                const res = json({ root: s.root, stitch: s.stitch, gateway, records: await index.rows(), ...(gate && { refused: await index.refused() }) });
                res.headers.set("cache-control", "public, s-maxage=31536000, max-age=0");
                await caches.default.put(key, res.clone());
                return res;
            }
            if (url.pathname === "/mcp") {
                if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
                if (req.method !== "POST") return new Response("POST JSON-RPC here (MCP streamable HTTP)", { status: 405, headers: { allow: "POST" } });
                let msg;
                try { msg = await req.json(); } catch { return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "not JSON" } }, 400); }
                if (Array.isArray(msg)) return json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "one message per request" } }, 400);
                const fangorn = fangornOf(env), repos = config.index === "repos", told = instructions ?? config.instructions ?? (repos ? REPOS_INSTRUCTIONS : undefined);
                const answer = await mcpCall({
                    index, fangorn, gateway, env, origin: url.origin,
                    auth: req.headers.get("authorization")?.match(/^Bearer\s+(\S+)/i)?.[1],
                    query: async (q) => (await encode(env, QUERY)([q]))[0],
                    name: appName,
                    instructions: typeof told === "function" ? told(gateway) : told?.replaceAll("{gateway}", gateway),
                    types: config.types, repos,
                    ...(config.publishPerDay && { publish: (token, body) => publish({ fangorn, config, meta, check: checkOf(env) }, token, body), connect: info().connect }),
                    tools,
                }, msg);
                return answer ? json(answer) : new Response(null, { status: 202, headers: { "access-control-allow-origin": "*" } });
            }
            if (url.pathname === "/publish") {
                if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
                if (req.method !== "POST") return json({ error: "POST { repo, record }, { repo, records }, or { commits }" }, 405);
                const token = req.headers.get("authorization")?.match(/^Bearer\s+(\S+)/i)?.[1];
                if (!token) return json({ error: "a fangorn.network grant token is the bearer" }, 401);
                const body = await req.json().catch(() => null);
                const fangorn = fangornOf(env);
                try { return json(await publish({ fangorn, config, meta, check: checkOf(env) }, token, body ?? {})); }
                catch (e) { return json({ error: e.message }, e.status ?? 502); }
            }
            if (url.pathname === "/repos" && index.find) {
                const q = url.searchParams.get("q")?.trim(), k = Math.min(Math.max(Number(url.searchParams.get("k")) || 20, 1), 100);
                const repos = await index.find({ q: q ? (await encode(env, QUERY)([q]))[0] : null, publisher: url.searchParams.get("publisher") || undefined, k });
                return json({ stitch: (await index.getMeta("stitch"))?.stitch ?? null, repos });
            }
            if (url.pathname === "/search") {
                const q = url.searchParams.get("q")?.trim();
                if (!q) return json([]);
                const query = async (text) => (await encode(env, QUERY)([text]))[0];
                const args = { query: q };
                for (const key of ["k", "type", "mode", "keywords"])
                    if (url.searchParams.has(key)) args[key] = url.searchParams.get(key);
                return json(await BASE.search.run(args, { index, query }));
            }
            return env.ASSETS ? env.ASSETS.fetch(req) : new Response("not found", { status: 404 });
        },
    };
}

/** /publish's check: the app's checker (src/validate.js), built on first use, or null when it checks nothing. */
const checkOf = (env) => async (record, ctx) => (await checkerOf(env.CONFIG, env.VALIDATOR))?.check(record, ctx) ?? null;

export default indexer();
