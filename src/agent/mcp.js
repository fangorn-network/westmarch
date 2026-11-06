#!/usr/bin/env node
// Fangorn for agents: every publisher's records, found through the explorer.
//
//   fangorn-mcp
//   claude mcp add fangorn -- fangorn-mcp
//
// The explorer (FANGORN_EXPLORER, default https://explorer.fangorn.network) is the Fangorn
// app that indexes every publisher. This server downloads the explorer's view and searches
// it here, so no query ever leaves the machine; it never reads the chain to find anything:
//
//   search      records across every publisher, or one (`publisher`)
//   publishers  who publishes what: each publisher's repos, with row counts
//   get         one record in full
//   buy         a record a publisher sells, quoted at the explorer, paid over x402
//   wallet      the person's address and balances
//   publish     records into the person's own repo, on their yes
//
// Buying needs FANGORN_MCP_WALLET_KEY and pays at most FANGORN_MCP_MAX_PRICE a record
// (default 0.10). Publishing signs with that key, else the fangorn CLI's.

import net from "node:net";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { createInterface } from "node:readline";

const log = (...a) => console.error("[fangorn-mcp]", ...a);   // stdout is the protocol

// FANGORN_NETWORK: the SDK's network name ("baseSepolia"); unset, its default.
const network = async () => (await import("../publish/view.js")).network();

// ── the server ──────────────────────────────────────────────────────────────
const text = (o) => ({ content: [{ type: "text", text: typeof o === "string" ? o : JSON.stringify(o, null, 1) }] });
const ADDRESS = { type: "string", description: "A publisher's address (0x…)" };

const TOOLS = [
    { name: "search",
      description: "Search every publisher's records on Fangorn by meaning. Each hit names its `publisher`, and carries `sale` ({publisher, repo, id, price} in USDC base units) when it is sold. Pass `publisher` to search one publisher's records.",
      inputSchema: { type: "object", required: ["query"], properties: {
          query: { type: "string", description: "What the person is looking for, in their words" },
          publisher: ADDRESS, limit: { type: "integer", minimum: 1, maximum: 50, default: 10 } } } },
    { name: "publishers",
      description: "Who publishes on Fangorn: each publisher's repos, with what they hold and how many records. Filter with `query` (matches a repo's name or description, or the address). The busiest first.",
      inputSchema: { type: "object", properties: { query: { type: "string" } } } },
    { name: "get",
      description: "One record in full, by the id a search hit gave.",
      inputSchema: { type: "object", required: ["id"], properties: { id: { type: "string" } } } },
    { name: "buy",
      description: "Buy one record a publisher sells (a search hit with `sale`) and return its sealed fields opened. Pays the price in USDC from the person's wallet (FANGORN_MCP_WALLET_KEY), never above FANGORN_MCP_MAX_PRICE. It checks the sealed data can be read before paying. Tell the person the price first.",
      inputSchema: { type: "object", required: ["publisher", "repo", "id"], properties: {
          publisher: ADDRESS, repo: { type: "string" }, id: { type: "string", description: "From the hit's `sale`" } } } },
    { name: "wallet",
      description: "The person's Fangorn wallet: its address and its USDC and ETH balances.",
      inputSchema: { type: "object", properties: {} } },
    { name: "publish",
      description: "Publish records to the person's own repo on Fangorn, from their wallet, where any agent can find them. Public and permanent: first show the person exactly what will be published and call this only on their yes to these records. Propose it when something you made for them (research, a list, a dataset) would be worth to others.",
      inputSchema: { type: "object", required: ["repo", "records"], properties: {
          repo: { type: "string", description: "Repo name, lowercase, e.g. \"notes\" or \"rust-crates\"; created if new" },
          records: { type: "array", items: { type: "object", required: ["id", "payload"], properties: {
              id: { type: "string", description: "Stable: the same thing keeps the same id" },
              type: { type: "string", description: "Record type, e.g. \"note.v1\"" },
              payload: { type: "object", description: "The record. Include a title and text that say what it is, in words" } } } } } } },
];

/**
 * The server. `deps` is the outside world, so the self-check can fake it:
 *   explorer()        → { call(name, args) }   (view-tools over the explorer's view, run here)
 *   quote(p, r, id)   → the explorer's x402 URL for one record
 *   buy(quoteUrl)     → { fields, price, tx }  (src/agent/x402.js, from the person's wallet)
 *   wallet(), publish({ repo, records })
 */
export function handlers(deps) {
    const ask = async (name, args) => {
        const r = await (await deps.explorer()).call(name, args);
        if (r.isError) throw new Error(`explorer: ${r.content?.[0]?.text ?? "error"}`);
        return r;
    };
    const run = {
        search: ({ query, publisher, limit = 10 }) =>
            ask("search", { query, limit: Math.min(50, Math.max(1, limit)), ...(publisher ? { where: { owner: publisher } } : {}) }),
        publishers: async ({ query }) => {
            const { views = [] } = JSON.parse((await ask("describe", {})).content[0].text);
            const by = new Map();
            for (const r of views.flatMap((v) => v.repos ?? [])) {
                const p = by.get(r.publisher.toLowerCase()) ?? { publisher: r.publisher, rows: 0, repos: [] };
                p.rows += r.rows;
                p.repos.push({ repo: r.repo, rows: r.rows, description: r.description });
                by.set(r.publisher.toLowerCase(), p);
            }
            const q = String(query ?? "").toLowerCase();
            const hit = (p) => !q || p.publisher.toLowerCase().includes(q) || p.repos.some((r) => `${r.repo} ${r.description}`.toLowerCase().includes(q));
            return text({ publishers: [...by.values()].filter(hit).sort((a, b) => b.rows - a.rows) });
        },
        get: ({ id }) => ask("get", { id }),
        buy: async ({ publisher, repo, id }) => text({ publisher, repo, id, ...await deps.buy(deps.quote(publisher, repo, id)) }),
        wallet: async () => text(await deps.wallet()),
        publish: async ({ repo, records }) => {
            if (!records?.length) throw new Error("no records to publish");
            return text(await deps.publish({ repo, records: records.map(({ id, type = "record.v1", payload }) => ({ id: String(id), type, payload })) }));
        },
    };

    return {
        initialize: async (p) => ({
            protocolVersion: p.protocolVersion ?? "2025-06-18",
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "fangorn-mcp", version: "0.2.0" },
            instructions: "Fangorn is publishers' records, anchored on chain and indexed by the Fangorn explorer. search finds records across every publisher; publishers says who publishes what; get reads one; buy pays for a sold one (say the price first).",
        }),
        ping: async () => ({}),
        "tools/list": async () => ({ tools: TOOLS }),
        "tools/call": async ({ name, arguments: args = {} }) => {
            try {
                if (!run[name]) throw new Error(`no tool ${name}`);
                return await run[name](args);
            } catch (e) { return { isError: true, content: [{ type: "text", text: e?.message ?? String(e) }] }; }
        },
    };
}

/** JSON-RPC over newline-delimited stdio. Returns `notify` for server → client messages. */
export function serve(handlers, { input = process.stdin, output = process.stdout } = {}) {
    const send = (m) => output.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
    createInterface({ input }).on("line", async (line) => {
        let msg; try { msg = JSON.parse(line); } catch { return; }
        if (msg.id === undefined) return;   // notifications
        const h = handlers[msg.method];
        if (!h) return send({ id: msg.id, error: { code: -32601, message: `unknown method ${msg.method}` } });
        try { send({ id: msg.id, result: await h(msg.params ?? {}) }); }
        catch (e) { send({ id: msg.id, error: { code: -32000, message: e?.message ?? String(e) } }); }
    });
    return (method, params = {}) => send({ method, params });
}

// ── main / self-check ───────────────────────────────────────────────────────
// A command, not a module: installed as a bin, argv[1] is the symlink, so there is no is-main check.
if (process.argv[2] === "--selfcheck") {
    const { PassThrough } = await import("node:stream");
    const input = new PassThrough(), output = new PassThrough();
    const replies = [];
    createInterface({ input: output }).on("line", (l) => replies.push(JSON.parse(l)));
    const P = "0xAbC0000000000000000000000000000000000001", Q = "0x0000000000000000000000000000000000000002";
    // The explorer's view tools, as view-tools.js answers them.
    const views = [{ view: "view", rows: 6, repos: [
        { publisher: P, repo: "weather", rows: 4, description: "hourly readings" },
        { publisher: Q, repo: "notes", rows: 1, description: "" },
        { publisher: P, repo: "tides", rows: 1, description: "" }] }];
    const explorer = { call: async (name, args) => (name === "describe" ? text({ views }) : text({ via: name, ...args })) };
    const published = [];
    serve(handlers({
        explorer: async () => explorer,
        quote: (p, r, id) => `https://explorer.test/paid/${p}/${r}/${encodeURIComponent(id)}`,
        buy: async (quoted) => ({ fields: { quoted }, price: "10000" }),
        wallet: async () => ({ address: "0xme" }),
        publish: async (a) => (published.push(a), { repo: a.repo, records: a.records.length }),
    }), { input, output });
    const rpc = (id, method, params) => input.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    const call = (id, name, args) => rpc(id, "tools/call", { name, arguments: args });
    const wait = () => new Promise((r) => setTimeout(r, 20));
    const res = (id) => replies.find((r) => r.id === id);
    const body = (id) => JSON.parse(res(id).result.content[0].text);
    const assert = (c, m) => { if (!c) throw new Error(m); };

    rpc(1, "initialize", {}); rpc(2, "tools/list"); call(3, "search", { query: "rain", publisher: P }); call(4, "search", { query: "rain", limit: 500 });
    call(5, "publishers", {}); call(6, "publishers", { query: "HOURLY" }); call(7, "get", { id: "a" }); call(8, "nope"); rpc(9, "nope"); await wait();
    assert(res(2).result.tools.map((t) => t.name).join() === "search,publishers,get,buy,wallet,publish", "the six tools, no apps");
    assert(body(3).via === "search" && body(3).where.owner === P && body(4).where === undefined && body(4).limit === 50, "search goes to the explorer, narrowed to a publisher on request, capped");
    assert(body(5).publishers.map((p) => [p.publisher, p.rows, p.repos.length]).join("|") === `${P},5,2|${Q},1,1`, "publishers groups repos by publisher, busiest first");
    assert(body(6).publishers.length === 1 && body(6).publishers[0].publisher === P, "publishers filters on what a repo holds");
    assert(body(7).via === "get" && body(7).id === "a", "get goes to the explorer");
    assert(res(8).result.isError && res(9).error.code === -32601, "unknown tool and method");
    call(10, "buy", { publisher: P, repo: "weather", id: "a/b" }); call(11, "publish", { repo: "notes", records: [{ id: 1, payload: { title: "t" } }] });
    call(12, "publish", { repo: "notes", records: [] }); call(13, "wallet"); await wait();
    assert(body(10).fields.quoted === `https://explorer.test/paid/${P}/weather/a%2Fb` && body(10).price === "10000", "buy quotes the record at the explorer, the id escaped");
    assert(body(11).records === 1 && published[0].records[0].id === "1" && published[0].records[0].type === "record.v1", "publish commits, ids as strings, a default type");
    assert(res(12).result.isError && body(13).address === "0xme", "publishing nothing is an error; wallet reports");
    const failing = handlers({ explorer: async () => ({ call: async () => ({ isError: true, content: [{ type: "text", text: "down" }] }) }) });
    assert(/explorer: down/.test((await failing["tools/call"]({ name: "search", arguments: { query: "x" } })).content[0].text), "an explorer error says so");
    console.log("mcp.js self-check ok — search, get and publishers ask the explorer and never the chain; publishers groups repos by publisher; buy quotes at the explorer; publish and wallet");
    process.exit(0);
}

// Node gives each address 250ms before trying the next; on a slow link, or a
// host with no working IPv6, every attempt times out and fetch fails outright.
net.setDefaultAutoSelectFamilyAttemptTimeout?.(2000);
const EXPLORER = (process.env.FANGORN_EXPLORER || "https://explorer.fangorn.network").replace(/\/+$/, "");
let explorer;
// The person's key: this server's own, else the one the fangorn CLI signs with.
const FANGORN_DIR = `${homedir()}/.fangorn`;
let KEY = process.env.FANGORN_MCP_WALLET_KEY || undefined;   // the plugin passes "" when unset
try { KEY ??= JSON.parse(readFileSync(`${FANGORN_DIR}/config.json`, "utf8")).privateKey; } catch { /* no CLI config */ }
KEY &&= `0x${KEY.trim().replace(/^0x/i, "")}`;   // a key file may lack 0x
const needKey = () => { if (!KEY) throw new Error("no wallet: run `fangorn init`, or set FANGORN_MCP_WALLET_KEY"); return KEY; };
let signer, pub;
const signing = async () => (signer ??= (await import("@fangorn-network/sdk")).Fangorn.create({
    privateKey: needKey(), config: await network(), storage: { signedUrl: {} } }));
const chainClient = async () => {
    if (!pub) {
        const [{ createPublicClient, http }, n] = await Promise.all([import("viem"), network()]);
        pub = createPublicClient({ chain: n.chain, transport: http(n.rpcUrl) });
    }
    return pub;
};
// Circle's USDC on Base Sepolia. ponytail: one network's; FANGORN_USDC for another.
const USDC = process.env.FANGORN_USDC || "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const deps = {
    // The explorer's view, searched here. Re-read every 5 minutes, so a long session sees new publishers.
    // ponytail: the first search downloads the whole view; route to the best domains (shard.js setDomains)
    // once the network is big enough for that to hurt.
    explorer: async () => {
        if (!explorer || Date.now() - explorer.at > 300_000) {
            const [vt, { resetShard }] = await Promise.all([import("./view-tools.js"), import("../core/shard.js")]);
            resetShard();
            explorer = { at: Date.now(), ...vt.viewTools({ name: "the Fangorn explorer", desc: "every publisher", views: [`${EXPLORER}/view`] }) };
        }
        return explorer;
    },
    quote: (p, r, id) => `${EXPLORER}/paid/${encodeURIComponent(p)}/${encodeURIComponent(r)}/${encodeURIComponent(id)}`,
    // Paying is opted into with this server's own key; the CLI's key alone only publishes.
    buy: async (quote) => {
        if (!process.env.FANGORN_MCP_WALLET_KEY) throw new Error("buying is off: set FANGORN_MCP_WALLET_KEY");
        const { buyRecord } = await import("./x402.js");
        return buyRecord(quote, { privateKey: needKey(), fangorn: await signing(),
            maxPrice: BigInt(Math.round(Number(process.env.FANGORN_MCP_MAX_PRICE || "0.10") * 1e6)) });
    },
    wallet: async () => {
        const [{ privateKeyToAccount }, { parseAbi, formatUnits, formatEther }, c] = await Promise.all([import("viem/accounts"), import("viem"), chainClient()]);
        const address = privateKeyToAccount(needKey()).address;
        const [usdc, eth] = await Promise.all([
            c.readContract({ address: USDC, abi: parseAbi(["function balanceOf(address) view returns (uint256)"]), functionName: "balanceOf", args: [address] }),
            c.getBalance({ address })]);
        return { address, usdc: formatUnits(usdc, 6), eth: formatEther(eth) };
    },
    publish: async ({ repo, records }) => {
        const f = await signing();
        await f.initRepo(repo);
        const { txHash, commitCid } = await f.uploadBatch(repo, records);
        return { publisher: f.getAddress(), repo, records: records.length, commit: commitCid, tx: txHash };
    },
};
serve(handlers(deps));
log(`ready: explorer ${EXPLORER}`);
// Queries are embedded here, never sent anywhere: start the model now, kept outside node_modules
// (FANGORN_MODEL_CACHE, default ~/.cache/fangorn/models) so an upgrade doesn't download its 131MB
// again. Until a first download lands, search ranks by words and says so. Without
// @huggingface/transformers installed (the plugin installs it) search ranks by words only.
const MODELS = process.env.FANGORN_MODEL_CACHE || `${homedir()}/.cache/fangorn/models`;
import("./view-tools.js").then((vt) => vt.warm({ cacheDir: MODELS })).then(async (ok) => {
    const { warmError } = await import("./view-tools.js");
    log(ok ? `embedder ready (${MODELS})` : `embedder unavailable, search ranks by words: ${warmError}`);
});
