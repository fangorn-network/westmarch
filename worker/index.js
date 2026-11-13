// A Fangorn indexer on Cloudflare: one Worker that follows repos, and serves their view, search and MCP.
// Deploy it as is (configured by CONFIG), or wrap it with an app's own MCP tools: indexer({ name, instructions, tools }).
//
//   cron (every minute)  one filtered log read: did any followed repo move? If so, restitch from the saved
//                        stitch (src/stitcher.js) into D1 (src/d1.js). Then embed rows that have no vector yet,
//                        with Workers AI, a bounded batch per run.
//   GET /view.json       the view: every record, the stitch, the gateway
//                        With CONFIG.publishView, each new root's view also goes to Fangorn (storage, and a `view`
//                        record in that repo), so a static page hosted anywhere finds it on chain.
//   GET /search?q=&k=    records by meaning: the query embedded here, by the same model as the rows
//   POST /mcp            search, repos, get, and the app's tools (streamable HTTP, stateless): add the URL to a client.
//                        A bearer token reaches the tools as ctx.auth.
//   anything else        ASSETS (a static site), when bound
//
// Bindings: DB (D1), AI (Workers AI), ASSETS?, CONFIG (a JSON var: repos, publishers?, network, publishView?, name?),
// and the secret INDEXER_KEY: it signs the stitch blocks' uploads and the view's commits, and pays their gas.

import { Fangorn, FangornConfig, SupportedNetworks } from "@fangorn-network/sdk";
import { DOCUMENT, QUERY, matryoshka } from "../src/gemma.js";
import { stitcher } from "../src/stitcher.js";
import { d1Index } from "../src/d1.js";
import { publishView } from "../src/view.js";
import { mcpCall } from "./mcp.js";

const AI_MODEL = "@cf/google/embeddinggemma-300m"; // EmbeddingGemma-300m, as src/embed.js runs it locally
const EMBED_PER_RUN = 100;
// ponytail: no daily cap; rows are embedded once, so only a flood of publishes could run past Workers AI's free
// allowance (~30k rows a day). Count rows per UTC day in meta when that's a risk.

export const networkOf = (env) => ({ ...FangornConfig, ...SupportedNetworks[env.CONFIG.network ?? "baseSepolia"] });
export const fangornOf = (env) => Fangorn.create({ privateKey: env.INDEXER_KEY, config: networkOf(env), storage: { signedUrl: {} } });
const encode = (env, prompt) => async (texts) =>
    (await env.AI.run(AI_MODEL, { text: texts.map((t) => prompt + t) })).data.map((v) => matryoshka(v));
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type, authorization, mcp-protocol-version", "access-control-allow-methods": "POST" };
const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json", "access-control-allow-origin": "*" } });

export async function update(env, log = console.log) {
    const config = env.CONFIG, fangorn = fangornOf(env), index = d1Index({ db: env.DB, fangorn });
    const registry = fangorn.getRegistry(), head = await registry.clock(), checked = await index.getMeta("checked");
    // The gate: restitching uploads a new stitch whenever ANY repo on the network moved, so first ask the chain,
    // filtered by repo name, whether one we follow did. (With publishers named, every run restitches.)
    let moved = checked == null || config.publishers;
    for (const repo of moved ? [] : config.repos)
        if ((await registry.log({ repo }, BigInt(checked) + 1n, head)).length) { moved = true; break; }
    if (moved) log(`root ${await stitcher(fangorn, config, { store: index.store, lens: index.lens }).update()}`);
    await index.setMeta("checked", head.toString());
    const n = await index.embedMissing(encode(env, DOCUMENT), EMBED_PER_RUN);
    if (n) log(`embedded ${n}`);
    // The view to Fangorn, once per root: `published` moves only when it landed, so a failed run retries.
    const s = await index.getMeta("stitch");
    if (config.publishView && s && s.root !== await index.getMeta("published")) {
        const view = { root: s.root, stitch: s.stitch, gateway: networkOf(env).ipfsGateway, records: await index.rows() };
        log(`view published: ${await publishView(fangorn, config.publishView, view)}`);
        await index.setMeta("published", s.root);
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
            const url = new URL(req.url), index = d1Index({ db: env.DB }), gateway = networkOf(env).ipfsGateway;
            if (url.pathname === "/view.json") {
                const s = await index.getMeta("stitch");
                if (!s) return json({ error: "not indexed yet" }, 404);
                return json({ root: s.root, stitch: s.stitch, gateway, records: await index.rows() });
            }
            if (url.pathname === "/mcp") {
                if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
                if (req.method !== "POST") return new Response("POST JSON-RPC here (MCP streamable HTTP)", { status: 405, headers: { allow: "POST" } });
                let msg;
                try { msg = await req.json(); } catch { return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "not JSON" } }, 400); }
                if (Array.isArray(msg)) return json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "one message per request" } }, 400);
                const answer = await mcpCall({
                    index, fangorn: fangornOf(env), gateway, env, origin: url.origin,
                    auth: req.headers.get("authorization")?.match(/^Bearer\s+(\S+)/i)?.[1],
                    query: async (q) => (await encode(env, QUERY)([q]))[0],
                    name: name ?? env.CONFIG.name ?? "westmarch",
                    instructions: typeof instructions === "function" ? instructions(gateway) : instructions,
                    tools,
                }, msg);
                return answer ? json(answer) : new Response(null, { status: 202, headers: { "access-control-allow-origin": "*" } });
            }
            if (url.pathname === "/search") {
                const q = url.searchParams.get("q")?.trim();
                if (!q) return json([]);
                const k = Math.min(Number(url.searchParams.get("k")) || 10, 50);
                const [vec] = await encode(env, QUERY)([q]);
                return json(await index.search(vec, { k }));
            }
            return env.ASSETS ? env.ASSETS.fetch(req) : new Response("not found", { status: 404 });
        },
    };
}

export default indexer();
