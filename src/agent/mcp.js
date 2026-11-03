#!/usr/bin/env node
// Every Fangorn app's tools, behind one stdio MCP server.
//
//   fangorn-mcp [--from-block <n>]
//   claude mcp add fangorn -- fangorn-mcp
//
// One MCP server for every app, so an agent registers once. It is a directory
// and a proxy:
//
//   list-apps      apps read off the chain (AppAgentChanged → verified cards)
//   open-app       verify one app's card and add its tools to this server as
//                  `<app>__<tool>` (tools/list_changed)
//   call-app-tool  the same call by name, for clients that ignore list_changed
//
// An app's tools are its own MCP server's (the card's `mcp`, the app's Worker at
// /mcp), relayed. The Worker alone reads the app's lens from R2, so nothing is
// downloaded here and access is the app's to gate.
// A private app's paid tools answer with x402's PaymentRequired. With FANGORN_MCP_WALLET_KEY set (or
// FANGORN_MCP_BUDGET, to pay from the fangorn CLI's key in ~/.fangorn/config.json), this server pays: a pass when the card sells
// one at or under FANGORN_MCP_MAX_PASS (USDC; unset, never), else that one call at or under
// FANGORN_MCP_MAX_PRICE (default 0.10), and never past FANGORN_MCP_BUDGET (USDC a month, default 5).
// Every payment is a receipt in ~/.fangorn/spend.json, shown by `wallet`. Without a wallet the price
// is handed back to the agent, to say to the person.
//
// With either key it also publishes: `publish` commits records to the person's own repo, on their yes.

import net from "node:net";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { APP_EXTENSION, listApps, pluginOf, skillOf, toApp } from "../discover/apps.js";

const log = (...a) => console.error("[fangorn-mcp]", ...a);   // stdout is the protocol
// FANGORN_MCP_TRACE=1: step timings on stderr, for finding where an answer waits.
const T0 = performance.now();
const trace = process.env.FANGORN_MCP_TRACE ? (what) => log(`${Math.round(performance.now() - T0)}ms ${what}`) : () => {};

// FANGORN_NETWORK: the SDK's network name ("baseSepolia"); unset, its default.
const network = async () => (await import("../publish/view.js")).network();

let client;
async function fangorn() {
    if (!client) {
        const [{ Fangorn }, { generatePrivateKey }] = await Promise.all([
            import("@fangorn-network/sdk"), import("viem/accounts")]);
        client = Fangorn.create({ privateKey: generatePrivateKey(), config: await network() });   // reads only
        // list-apps verifies every card and open-app verifies one again: once a minute is enough.
        const verify = client.discoverCard.bind(client), seen = new Map();
        client.discoverCard = (url) => {
            const hit = seen.get(url);
            if (hit && Date.now() - hit.at < 60_000) return hit.p;
            const p = verify(url).catch((e) => { seen.delete(url); throw e; });
            seen.set(url, { at: Date.now(), p });
            return p;
        };
    }
    return client;
}

/** A card URL → its app's MCP endpoint (the card's `mcp`), once the card verifies on chain. */
async function resolveCard(cardUrl) {
    const card = await (await fetch(cardUrl)).json();
    if (!card.capabilities?.extensions?.some((e) => e.uri === APP_EXTENSION)) throw new Error(`${cardUrl} is not a Fangorn app card`);
    const { mcp } = toApp(await (await fangorn()).discoverCard(cardUrl), cardUrl);
    return { card, mcp };
}

/** An app's own MCP server over streamable HTTP → `{ tools, call }`.
 *  The app's Worker is stateless (one JSON body per POST); a session id or an SSE
 *  reply from any other server is followed too. */
export async function remoteTools(url, fetcher = fetch) {
    let id = 0, session;
    const rpc = async (method, params) => {
        const r = await fetcher(url, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
            headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(session && { "mcp-session-id": session }) } });
        session ??= r.headers.get("mcp-session-id") ?? undefined;
        let body = await r.text();
        if (!r.ok) throw new Error(`${url}: HTTP ${r.status} ${body.slice(0, 200)}`);
        if (r.headers.get("content-type")?.includes("text/event-stream")) body = body.split("\n").filter((l) => l.startsWith("data:")).pop()?.slice(5) ?? "";
        const m = JSON.parse(body);
        if (m.error) throw new Error(`${url}: ${m.error.message}`);
        return m.result;
    };
    await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fangorn-mcp", version: "0.1.0" } });
    const { tools } = await rpc("tools/list", {});
    const call = (name, args) => rpc("tools/call", { name, arguments: args ?? {} });
    return { tools, call };
}

// ── what this wallet spent ──────────────────────────────────────────────────
/** This month's payments: `spent()` in USDC base units, `record({url, tool, amount, tx})`. */
export function memoryLedger(load = () => null, save = () => {}) {
    const month = () => new Date().toISOString().slice(0, 7);
    let book = load();
    const now = () => (book?.month === month() ? book : (book = { month: month(), receipts: [] }));
    return {
        spent: () => now().receipts.reduce((n, r) => n + BigInt(r.amount), 0n),
        receipts: () => now().receipts,
        record: (r) => { now().receipts.push({ at: new Date().toISOString(), ...r, amount: String(r.amount) }); save(book); },
    };
}

/** The ledger on disk. ponytail: two servers paying at once can drop a receipt; a lock if that bites. */
export function fileLedger(path) {
    return memoryLedger(() => { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; } },
        (b) => { try { writeFileSync(path, JSON.stringify(b, null, 1)); } catch (e) { log(`receipt not saved: ${e.message}`); } });
}

// ── the network ─────────────────────────────────────────────────────────────
// Catalogs, manifests and cards change on a rebake: held for a minute, so one
// search (or resolving then verifying a card) does not fetch each twice.
const CACHE = `${homedir()}/.cache/fangorn-mcp`;   // the embedding model (find-apps) and the chain logs read
function cachingFetch(real = globalThis.fetch) {
    const memo = new Map();
    return async (input, init) => {
        const url = String(input?.url ?? input);
        if ((init?.method ?? input?.method ?? "GET") !== "GET" || !/^https?:/.test(url)) return real(input, init);
        const path = new URL(url).pathname;
        // A card, catalog or manifest is small: 8s without one means the host is
        // down, and a dead card in the directory must not stall a listing for a
        // TCP timeout.
        init = { ...init, signal: init?.signal ?? AbortSignal.timeout(8000) };
        if (/\/cdn\/catalog$|\/manifest$|\/agent-card\.json$/.test(path)) {
            const hit = memo.get(url);
            if (hit && Date.now() - hit.at < 60_000) return new Response(hit.body, { headers: hit.headers });
            const r = await real(input, init);
            if (!r.ok) return r;
            const body = new Uint8Array(await r.arrayBuffer());
            memo.set(url, { at: Date.now(), body, headers: r.headers });
            return new Response(body, { headers: r.headers });
        }
        return real(input, init);
    };
}

/**
 * The chain logs a scan has read, on disk, so a new session reads only the
 * blocks since (apps.js cachedLogs). Logs carry bigints; JSON does not.
 * ponytail: two servers writing at once can tear the file. A torn file reads
 * as empty and the next scan starts over; write-then-rename if that ever bites.
 */
function fileStore(path) {
    const big = (_, v) => (typeof v === "bigint" ? { $n: String(v) } : v);
    const unbig = (_, v) => (v?.$n !== undefined ? BigInt(v.$n) : v);
    let data;
    try { data = JSON.parse(readFileSync(path, "utf8"), unbig); } catch { data = {}; }
    return {
        get: (k) => data[k],
        set: (k, v) => {
            data[k] = v;
            try { mkdirSync(CACHE, { recursive: true }); writeFileSync(path, JSON.stringify(data, big)); }
            catch (e) { log(`log cache not saved: ${e.message}`); }
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

const text = (o) => ({ content: [{ type: "text", text: typeof o === "string" ? o : JSON.stringify(o, null, 1) }] });
// MCP tool names: [a-zA-Z0-9_-]{1,64}. `__` separates app from tool.
const slug = (name) => String(name).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "app";

const META = [
    { name: "list-apps",
      description: "List the Fangorn apps whose agent cards verify on chain (an app is a publisher's repo with a card): name, description, card URL, and its id (publisher:repo). Filter with `query`. Call open-app on one to use its tools.",
      inputSchema: { type: "object", properties: { query: { type: "string", description: "Case-insensitive match on name or description" } } } },
    { name: "find-apps",
      description: "Find Fangorn apps for a question, ranked by what their data is about (e.g. \"where can I learn about weather?\", \"music\"). Each app carries its site, agent card, ERC-8004 agent with an 8004scan link, ERC-8004 reputation (feedback count and average), record count and bound block. Only apps whose cards verify on chain. `relevant: true` marks the ones worth opening; the rest are sorted, not relevant. With no query, lists every app. Then open-app.",
      inputSchema: { type: "object", properties: {
          query: { type: "string", description: "What the person is looking for, in their words" },
          limit: { type: "integer", minimum: 1, maximum: 50, default: 10 } } } },
    { name: "open-app",
      description: "Verify an app's card against the chain and add its tools to this server as `<app>__<tool>`. The tools are the app's own MCP server's (typically describe, search, get, similar, count, browse). `app` is a name from list-apps, an id (publisher:repo), or a card URL.",
      inputSchema: { type: "object", properties: { app: { type: "string" } }, required: ["app"] } },
    { name: "call-app-tool",
      description: "Call one tool of an opened app. Same as calling `<app>__<tool>` directly.",
      inputSchema: { type: "object", properties: { app: { type: "string" }, tool: { type: "string" }, arguments: { type: "object" } }, required: ["app", "tool"] } },
    { name: "buy",
      description: "Buy one record a publisher sells, from an open app whose search hits carry `sale` ({publisher, repo, id, price}), and return its sealed fields opened. Pays the price in USDC from the person's wallet (FANGORN_MCP_WALLET_KEY), never above FANGORN_MCP_MAX_PRICE a record or the monthly FANGORN_MCP_BUDGET. Tell the person the price first.",
      inputSchema: { type: "object", required: ["app", "publisher", "repo", "id"], properties: {
          app: { type: "string", description: "The open app the hit came from" },
          publisher: { type: "string" }, repo: { type: "string" }, id: { type: "string", description: "From the hit's `sale`" } } } },
    { name: "wallet",
      description: "The person's Fangorn wallet: its address, USDC and ETH balances, this month's budget, what was spent and the receipt for each payment. Call it when they ask what they have earned or spent.",
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
 *   findApps()          → { apps: [{ name, desc, card, id }], rejected }
 *   exploreApps(query)  → { apps: ranked explore.js entries, ranked_by }
 *   resolveCard(url)    → { card, mcp }
 *   remoteTools(url)    → { tools, call(name, args) }   (the app's own MCP server)
 *   buy(quoteUrl)       → { fields, price, tx }          (src/agent/x402.js, from the person's wallet)
 *   notify(method)      set after serve()
 */
export function handlers(deps) {
    const open = new Map();   // slug → { slug, name, card, id, tools, call }

    const findOpen = (app) => open.get(slug(app)) ?? [...open.values()].find((o) => o.card === app || o.id === app);

    async function openApp(app) {
        const hit = findOpen(app);
        if (hit) return hit;
        let cardUrl = app, id;
        if (!/^https?:\/\//.test(app)) {
            trace(`open ${app}: lookup`);
            const a = (await deps.findApps()).apps.find((x) => x.id === app || slug(x.name) === slug(app));
            if (!a) throw new Error(`no verified app named ${JSON.stringify(app)}; see list-apps`);
            ({ card: cardUrl, id } = a);
        }
        trace(`open ${app}: resolve ${cardUrl}`);
        const { card, mcp } = await deps.resolveCard(cardUrl);
        if (!mcp) throw new Error(`${card.name ?? cardUrl} has no MCP server (its card has no \`mcp\`)`);
        let s = slug(card.name ?? app);
        while (open.has(s)) s += "-";
        const ext = card.capabilities?.extensions?.find((e) => e.uri === APP_EXTENSION);
        const o = { slug: s, name: card.name, card: cardUrl, id, skill: skillOf(ext), plugin: pluginOf(ext), paid: ext?.params?.paid?.url ?? null,
                    ...await deps.remoteTools(mcp) };
        trace(`open ${app}: ready`);
        open.set(o.slug, o);
        deps.notify?.("notifications/tools/list_changed");
        return o;
    }

    async function call(app, tool, args) {
        const o = findOpen(app);
        if (!o) throw new Error(`${app} is not open; call open-app first`);
        if (!o.tools.some((t) => t.name === tool)) throw new Error(`${o.slug} has no tool ${tool}`);
        return o.call(tool, args);
    }

    const run = {
        "list-apps": async ({ query }) => {
            const { apps, rejected } = await deps.findApps();
            const q = String(query ?? "").toLowerCase();
            return text({
                apps: apps.filter((a) => !q || `${a.name} ${a.desc}`.toLowerCase().includes(q)).map((a) => ({
                    app: slug(a.name), name: a.name, description: a.desc, card: a.card, id: a.id,
                    open: open.has(slug(a.name)),
                })),
                unverified: rejected.length,
            });
        },
        "find-apps": async ({ query, limit = 10 }) => {
            const { apps, ranked_by } = await deps.exploreApps(query);
            return text({ query: query ?? null, ranked_by, apps: apps.slice(0, Math.min(50, Math.max(1, limit)))
                .map((a) => ({ ...a, open: open.has(a.app) })) });
        },
        "open-app": async ({ app }) => {
            const o = await openApp(app);
            return text({ app: o.slug, name: o.name, card: o.card,
                          call_as: `${o.slug}__<tool>, or call-app-tool`, tools: o.tools,
                          // An app's own skill: standing instructions for the reader's agent, so never loaded
                          // silently. The fangorn-index skill offers it to the user and pins the hash on a yes.
                          ...(o.skill ? { skill: { ...o.skill, adopt: "The app ships an agent skill. Offer it to the user (what it would make you do, from its description); adopt it only on their yes, checking sha256, and ask again if the hash changes." } } : {}),
                          // Its Claude Code plugin: hooks run code on every matching event, so the same rule, louder.
                          ...(o.plugin ? { plugin: { ...o.plugin, install: `claude plugin install ${o.plugin.name} --marketplace ${o.plugin.marketplace}`,
                              adopt: "The app ships a Claude Code plugin, whose hooks run code on this machine without being called. Offer it to the user once, saying what its hooks trigger on; install only on their yes. It takes effect next session." } } : {}) });
        },
        "call-app-tool": async ({ app, tool, arguments: args }) => call(app, tool, args),
        buy: async ({ app, publisher, repo, id }) => {
            const o = findOpen(app);
            if (!o) throw new Error(`${app} is not open; call open-app first`);
            if (!o.paid) throw new Error(`${o.name} sells nothing (its card has no paid quote)`);
            const quote = o.paid.replace("{publisher}", encodeURIComponent(publisher)).replace("{repo}", encodeURIComponent(repo)).replace("{id}", encodeURIComponent(id));
            return text({ publisher, repo, id, ...await deps.buy(quote) });
        },
        wallet: async () => text(await deps.wallet()),
        publish: async ({ repo, records }) => {
            if (!records?.length) throw new Error("no records to publish");
            return text(await deps.publish({ repo, records: records.map(({ id, type = "record.v1", payload }) => ({ id: String(id), type, payload })) }));
        },
    };

    return {
        initialize: async (p) => ({
            protocolVersion: p.protocolVersion ?? "2025-06-18",
            capabilities: { tools: { listChanged: true } },
            serverInfo: { name: "fangorn-mcp", version: "0.1.0" },
            instructions: "Fangorn apps are anchored on chain and each serves its own MCP. list-apps to find one, open-app to load it, then call its tools as <app>__<tool>. Start with <app>__describe when it exists.",
        }),
        ping: async () => ({}),
        "tools/list": async () => ({ tools: [
            ...META,
            ...[...open.values()].flatMap((o) => o.tools.map((t) => ({ ...t, name: `${o.slug}__${t.name}`, description: `[${o.name}] ${t.description ?? ""}` }))),
        ] }),
        "tools/call": async ({ name, arguments: args = {} }) => {
            try {
                if (run[name]) return await run[name](args);
                const i = name.indexOf("__");
                if (i > 0) return await call(name.slice(0, i), name.slice(i + 2), args);
                throw new Error(`no tool ${name}`);
            } catch (e) { return { isError: true, content: [{ type: "text", text: e?.message ?? String(e) }] }; }
        },
    };
}

// ── main / self-check ───────────────────────────────────────────────────────
// A command, not a module: installed as a bin, argv[1] is the symlink, so there is no is-main check.
if (process.argv[2] === "--selfcheck") {
    const { PassThrough } = await import("node:stream");
    const input = new PassThrough(), output = new PassThrough();
    const replies = [];
    createInterface({ input: output }).on("line", (l) => replies.push(JSON.parse(l)));
    const posts = [];
    // The app's Worker: initialize, tools/list, tools/call over JSON-RPC POSTs.
    const remote = await remoteTools("https://k.test/mcp", async (url, init) => {
        const m = JSON.parse(init.body);
        posts.push(m.method);
        const result = m.method === "tools/list" ? { tools: [{ name: "search" }] }
            : m.method === "tools/call" ? text({ via: "remote", ...m.params }) : {};
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }), { headers: { "content-type": "application/json" } });
    });
    let opened = 0;
    const deps = {
        findApps: async () => ({ apps: [{ name: "Kings Foil", desc: "trials", card: "https://k.test/card", id: "0xk:kings-foil" },
                                        { name: "Bare", desc: "", card: "https://b.test/card", id: "0xb:bare" }], rejected: [{}] }),
        exploreApps: async (q) => ({ ranked_by: q ? "meaning" : null, apps: [{ app: "kings-foil", name: "Kings Foil", relevant: true }, { app: "b", name: "B", relevant: false }] }),
        resolveCard: async (url) => (url.includes("b.test") ? { card: { name: "Bare" }, mcp: null } : { card: { name: "Kings Foil", capabilities: { extensions: [{ uri: APP_EXTENSION,
            params: { skill: { url: "https://k.test/skill/kings-foil/SKILL.md", sha256: "b".repeat(64) }, plugin: { marketplace: "k/kf", name: "kings-foil" },
            paid: { url: "https://k.test/paid/{publisher}/{repo}/{id}" } } }] } }, mcp: "https://k.test/mcp" }),
        remoteTools: async () => (opened++, remote),
        wallet: async () => ({ address: "0xme", spent: "0" }),
        buy: async (quoted) => ({ fields: { quoted }, price: "10000" }),
        publish: async (a) => (published.push(a), { repo: a.repo, records: a.records.length }),
    };
    const published = [];
    deps.notify = serve(handlers(deps), { input, output });
    const rpc = (id, method, params) => input.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    const wait = () => new Promise((r) => setTimeout(r, 20));
    const call = (id, name, args) => rpc(id, "tools/call", { name, arguments: args });
    const res = (id) => replies.find((r) => r.id === id);
    const body = (id) => JSON.parse(res(id).result.content[0].text);
    const assert = (c, m) => { if (!c) throw new Error(m); };

    rpc(1, "initialize", {}); rpc(2, "tools/list"); call(3, "list-apps", { query: "TRIAL" }); call(4, "kings-foil__search"); await wait();
    assert(res(1).result.capabilities.tools.listChanged, "advertises list_changed");
    assert(res(2).result.tools.length === 7, "only the meta tools before anything is open");
    assert(body(3).apps.length === 1 && body(3).apps[0].app === "kings-foil" && body(3).unverified === 1, "list-apps filters and slugs");
    assert(res(4).result.isError && /not open/.test(res(4).result.content[0].text), "an unopened app's tool is an error");

    call(30, "find-apps", { query: "trials", limit: 1 }); await wait();
    assert(body(30).ranked_by === "meaning" && body(30).apps.length === 1 && body(30).apps[0].open === false, "find-apps ranks, caps, and says what is open");

    call(5, "open-app", { app: "Kings Foil" }); await wait();
    call(6, "open-app", { app: "https://k.test/card" }); await wait();
    assert(body(5).tools[0].name === "search" && opened === 1, "open once, by name or by card URL");
    assert(body(5).skill?.url === "https://k.test/skill/kings-foil/SKILL.md" && /user/.test(body(5).skill.adopt), "open-app offers the app's skill, for the user to adopt");
    assert(body(5).plugin?.marketplace === "k/kf" && /user/.test(body(5).plugin.adopt), "open-app offers the app's plugin, for the user to install");
    assert(replies.some((r) => r.method === "notifications/tools/list_changed"), "opening notifies");
    rpc(7, "tools/list"); call(8, "kings-foil__search", { query: "x" }); call(9, "call-app-tool", { app: "kings-foil", tool: "search" });
    call(10, "call-app-tool", { app: "kings-foil", tool: "boom" }); call(11, "open-app", { app: "nope" }); call(13, "open-app", { app: "Bare" }); rpc(12, "nope"); await wait();
    assert(res(7).result.tools.some((t) => t.name === "kings-foil__search"), "opened tools are listed under the app");
    assert(body(8).via === "remote" && body(8).arguments.query === "x" && body(9).name === "search", "both call paths reach the app's server");
    assert(posts.join() === "initialize,tools/list,tools/call,tools/call", `initialize, list, then calls: ${posts}`);
    assert(res(10).result.isError && res(11).result.isError, "failures are tool errors");
    assert(res(13).result.isError && /no MCP server/.test(res(13).result.content[0].text), "an app without `mcp` cannot open");
    assert(res(12).error.code === -32601, "unknown method");
    call(14, "publish", { repo: "notes", records: [{ id: 1, payload: { title: "t" } }] }); call(15, "publish", { repo: "notes", records: [] }); call(16, "wallet"); await wait();
    assert(body(14).records === 1 && published[0].records[0].id === "1" && published[0].records[0].type === "record.v1", "publish commits, ids as strings, a default type");
    assert(res(15).result.isError && body(16).address === "0xme", "publishing nothing is an error; wallet reports");
    call(17, "buy", { app: "kings-foil", publisher: "0xp", repo: "notes", id: "a/b" }); call(18, "buy", { app: "nope", publisher: "0xp", repo: "r", id: "x" }); await wait();
    assert(body(17).fields.quoted === "https://k.test/paid/0xp/notes/a%2Fb", "buy quotes the record at the app's paid URL, the id escaped");
    assert(res(18).result.isError, "buying from an app that is not open is an error");
    // The budget: what a month's receipts add up to.
    const ledger = memoryLedger();
    ledger.record({ url: "q", amount: 10000n });
    if (ledger.spent() !== 10000n || ledger.receipts().length !== 1) throw new Error(`receipts: ${JSON.stringify(ledger.receipts())}`);
    console.log("mcp.js self-check ok — one server, apps opened on demand, calls relayed to each app's own MCP server; buy quotes a record at the opened app's paid URL; publish and wallet");
    process.exit(0);
}

const argv = process.argv.slice(2);
globalThis.fetch = cachingFetch();
// Node gives each address 250ms before trying the next; on a slow link, or a
// host with no working IPv6, every attempt times out and fetch fails outright.
net.setDefaultAutoSelectFamilyAttemptTimeout?.(2000);
const vt = await import("./view-tools.js");
const fb = argv.indexOf("--from-block");
// The SDK's deployment by default: pass --from-block for another one.
const fromBlock = fb >= 0 ? BigInt(argv[fb + 1]) : (await network()).fromBlock;
let found, foundAt = 0, explored, exploredAt = 0, pub, warming;
const chainClient = async () => {
    if (!pub) {
        const [{ createPublicClient, http }, net] = await Promise.all([import("viem"), network()]);
        pub = createPublicClient({ chain: net.chain, transport: http(net.rpcUrl) });
    }
    return pub;
};
const store = fileStore(`${CACHE}/logs-${(await network()).chain.id}.json`);
// The person's key: this server's own, else the one the fangorn CLI signs with.
const FANGORN_DIR = `${homedir()}/.fangorn`;
let KEY = process.env.FANGORN_MCP_WALLET_KEY;
try { KEY ??= JSON.parse(readFileSync(`${FANGORN_DIR}/config.json`, "utf8")).privateKey; } catch { /* no CLI config */ }
KEY &&= `0x${KEY.trim().replace(/^0x/i, "")}`;   // a key file may lack 0x
const ledger = fileLedger(`${FANGORN_DIR}/spend.json`);
const needKey = () => { if (!KEY) throw new Error("no wallet: run `fangorn init`, or set FANGORN_MCP_WALLET_KEY"); return KEY; };
let signer;
const signing = async () => (signer ??= (await import("@fangorn-network/sdk")).Fangorn.create({
    privateKey: needKey(), config: await network(), storage: { signedUrl: {} } }));
// Circle's USDC on Base Sepolia. ponytail: one network's; FANGORN_USDC for another.
const USDC = process.env.FANGORN_USDC ?? "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
// The embedder is for find-apps' ranking alone. Loading it blocks the thread for
// seconds, so not at startup, where it would hold up list-apps.
const warmEmbedder = () => (warming ??= vt.warm({ cacheDir: `${CACHE}/models` }).then((ok) => ok ? trace("embedder ready")
    : log(`embedder unavailable, searching by words: ${vt.warmError}`)));
const deps = {
    // ponytail: cached for a minute. One log scan, a @card read per changed repo, a fetch per card.
    findApps: async () => {
        if (!found || Date.now() - foundAt > 60_000) {
            const { apps, rejected } = await listApps(await fangorn(), { fromBlock, store });
            found = { apps, rejected };
            foundAt = Date.now();
        }
        return found;
    },
    // ponytail: cached for a minute, like findApps. Two getLogs, a card and catalog per app.
    exploreApps: async (query) => {
        if (query?.trim()) warmEmbedder();   // loads behind the directory read; a first download ranks by words
        if (!explored || Date.now() - exploredAt > 60_000) {
            const [ex, client, net, f] = await Promise.all([import("../discover/explore.js"), chainClient(), network(), fangorn()]);
            explored = { ex, dir: await ex.readDirectory(f, client, { chain: ex.chainOf(net), store }) };
            exploredAt = Date.now();
        }
        const { ex, dir } = explored;
        const { EMBED_MODEL } = await import("../core/embed.js");
        const qv = query?.trim() ? await vt.queryVector(query) : null;
        const apps = ex.rankApps(dir.apps, query, { qv, model: EMBED_MODEL }).map(ex.brief);
        return { apps, ranked_by: apps[0]?.ranked_by ?? null };
    },
    resolveCard,
    remoteTools: (url) => remoteTools(url, fetch),
    // Paying is opted into: this server's own key, or a budget set. The CLI's key alone only publishes.
    buy: async (quote) => {
        if (!(process.env.FANGORN_MCP_WALLET_KEY || process.env.FANGORN_MCP_BUDGET)) throw new Error("buying is off: set FANGORN_MCP_WALLET_KEY (or FANGORN_MCP_BUDGET to pay from the CLI's wallet)");
        const usdc = (n) => BigInt(Math.round(Number(n) * 1e6));
        const left = usdc(process.env.FANGORN_MCP_BUDGET ?? "5") - ledger.spent();
        const cap = usdc(process.env.FANGORN_MCP_MAX_PRICE ?? "0.10");
        const { buyRecord } = await import("./x402.js");
        const r = await buyRecord(quote, { privateKey: needKey(), fangorn: await signing(), maxPrice: cap < left ? cap : left });
        if (r.tx) ledger.record({ url: quote, tool: "buy", amount: BigInt(r.price), tx: r.tx });
        return r;
    },
    wallet: async () => {
        const [{ privateKeyToAccount }, { parseAbi, formatUnits, formatEther }, c] = await Promise.all([import("viem/accounts"), import("viem"), chainClient()]);
        const address = privateKeyToAccount(needKey()).address;
        const [usdc, eth] = await Promise.all([
            c.readContract({ address: USDC, abi: parseAbi(["function balanceOf(address) view returns (uint256)"]), functionName: "balanceOf", args: [address] }),
            c.getBalance({ address })]);
        return { address, usdc: formatUnits(usdc, 6), eth: formatEther(eth),
                 budget: `${process.env.FANGORN_MCP_BUDGET ?? "5"} USDC a month`, spent: formatUnits(ledger.spent(), 6),
                 receipts: ledger.receipts().slice(-10).map((r) => ({ ...r, amount: formatUnits(BigInt(r.amount), 6) })) };
    },
    publish: async ({ repo, records }) => {
        const f = await signing();
        await f.initRepo(repo);
        const { txHash, commitCid } = await f.uploadBatch(repo, records);
        return { publisher: f.getAddress(), repo, records: records.length, commit: commitCid, tx: txHash };
    },
};
const h = handlers(deps);
// The client starts this server with the session, long before an agent opens an
// app: load the SDK then, behind the agent's first thought. After the initialize
// reply, not before: it blocks the thread while it loads, and the client is
// waiting on that reply.
const reply = h.initialize;
h.initialize = async (p) => {
    setImmediate(() => fangorn().then(() => trace("sdk ready"), () => {}));
    return reply(p);
};
deps.notify = serve(h);
log(`ready: apps from block ${fromBlock}`);
