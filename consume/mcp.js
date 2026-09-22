#!/usr/bin/env node
// Every Fangorn app's WebMCP tools, behind one stdio MCP server.
//
//   fangorn-mcp [--cdp <url>] [--headed] [--from-block <n>]
//   claude mcp add fangorn -- fangorn-mcp
//   claude mcp add fangorn -e FANGORN_MCP_CDP=ws://browser:9222 -- fangorn-mcp
//
// WebMCP tools live on `document.modelContext` inside a loaded tab. There is no
// endpoint, so an agent outside the browser cannot reach them, and one MCP
// server per app would mean one registration per app. Instead this server is
// the directory and the browser both:
//
//   list-apps      apps read off the chain (AppAgentChanged → verified cards)
//   open-app       verify one app's card, open its page in a tab, and add its
//                  tools to this server as `<app>__<tool>` (tools/list_changed)
//   call-app-tool  the same call by name, for clients that ignore list_changed
//
// One browser, one tab per opened app: a WebMCP browser at --cdp, or else a
// local Chrome with WebMCP on, headless unless --headed. Calls
// are relayed to the tab's own `modelContext.executeTool`, so the tools, their
// schemas and their answers are the page's, and queries still run in the tab.
// A local Chrome's profile persists (~/.cache/westmarch-mcp), so a page's
// downloads, such as an embedding model, are fetched once. A tab or browser that
// dies is reopened on the next call.

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { APP_EXTENSION, listApps } from "./apps.js";

// The current AppRegistry's first event on Arbitrum Sepolia. A reader's
// default, not deployment config: pass --from-block for another deployment.
const DEFAULT_FROM_BLOCK = 311637349n;
const log = (...a) => console.error("[fangorn-mcp]", ...a);   // stdout is the protocol

let client;
async function fangorn() {
    if (!client) {
        const [{ Fangorn, FangornConfig }, { generatePrivateKey }] = await Promise.all([
            import("@fangorn-network/sdk"), import("viem/accounts")]);
        client = Fangorn.create({ privateKey: generatePrivateKey(), config: FangornConfig });   // reads only
    }
    return client;
}

/** A card URL → the verified card and the page to open. A plain A2A card (no
 *  Fangorn extension) opens unverified: the caller asked for it by URL. */
async function resolveCard(cardUrl) {
    const card = await (await fetch(cardUrl)).json();
    const fangornApp = card.capabilities?.extensions?.some((e) => e.uri === APP_EXTENSION);
    if (fangornApp) await (await fangorn()).discoverApp(cardUrl);
    const page = new URL(card.url);
    if (page.protocol !== "https:" && page.protocol !== "http:") throw new Error(`card.url is not http(s): ${card.url}`);
    return { card, page: page.toString(), verified: fangornApp };
}

// ── the browser ─────────────────────────────────────────────────────────────
// Anything that speaks the Chrome DevTools Protocol and has WebMCP: a headless
// Chromium service, a hosted browser, or the local Chrome. `--cdp` (or
// FANGORN_MCP_CDP) names it as http(s)://host:port or a ws(s):// browser
// endpoint. Without it, a local Chrome is reused if one is already serving
// this profile (another session's), else launched.
//
// Everything goes over the one browser-level WebSocket (Target.* plus flat
// sessions). That is the endpoint every CDP host exposes, where the per-tab
// /json HTTP routes are not.

const PROFILE = `${homedir()}/.cache/westmarch-mcp`;

/** An http(s) DevTools address → its browser WebSocket, reached via the host we were given. */
async function browserWs(http) {
    const v = await (await fetch(new URL("/json/version", http), { signal: AbortSignal.timeout(3000) })).json();
    const ws = new URL(v.webSocketDebuggerUrl), base = new URL(http);
    ws.host = base.host;                                  // the service reports its own view of itself
    if (base.protocol === "https:") ws.protocol = "wss:";
    return ws.toString();
}

async function localChrome({ headed }) {
    mkdirSync(PROFILE, { recursive: true });
    const portFile = `${PROFILE}/DevToolsActivePort`;
    if (existsSync(portFile)) {
        const ws = await browserWs(`http://127.0.0.1:${readFileSync(portFile, "utf-8").split("\n")[0]}`).catch(() => null);
        if (ws) { log("reusing the Chrome already serving this profile"); return { ws }; }
        rmSync(portFile, { force: true });                // stale: that Chrome is gone
    }
    const bin = process.env.CHROME ?? "google-chrome";
    const proc = spawn(bin, [
        ...(headed ? [] : ["--headless=new"]),
        "--enable-features=WebMCP", "--remote-debugging-port=0", "--no-first-run",
        "--no-default-browser-check", `--user-data-dir=${PROFILE}`, "about:blank",
    ], { stdio: "ignore" });
    const failed = new Promise((_, j) => proc.on("error", (e) => j(new Error(
        `no browser: cannot launch ${bin} (${e.code}). Point --cdp / FANGORN_MCP_CDP at a WebMCP browser, or set CHROME.`))));
    for (let i = 0; i < 100; i++) {
        await Promise.race([new Promise((r) => setTimeout(r, 100)), failed]);
        if (existsSync(portFile)) return { ws: await browserWs(`http://127.0.0.1:${readFileSync(portFile, "utf-8").split("\n")[0]}`), proc };
    }
    proc.kill();
    throw new Error(`${bin} did not start`);
}

let conn;
/** The browser connection, opened once and reopened after it drops. */
function browser(opts) {
    return conn ??= (async () => {
        const { cdp } = opts;
        const { ws: url, proc } = !cdp ? await localChrome(opts)
            : /^wss?:/.test(cdp) ? { ws: cdp } : { ws: await browserWs(cdp) };
        const ws = new WebSocket(url);
        await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error(`cannot connect to the browser at ${url}`)); });
        let id = 0; const pending = new Map(), dead = new Set();
        ws.onmessage = (m) => {
            const d = JSON.parse(m.data);
            if (d.method === "Target.detachedFromTarget") dead.add(d.params.sessionId);
            if (d.id !== undefined) { pending.get(d.id)?.(d); pending.delete(d.id); }
        };
        ws.onclose = () => { conn = null; for (const r of pending.values()) r({ error: { message: "browser connection closed" } }); };
        const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
            if (ws.readyState !== WebSocket.OPEN) return rej(new Error("browser connection closed"));
            pending.set(++id, (d) => (d.error ? rej(new Error(d.error.message)) : res(d.result)));
            ws.send(JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) }));
        });
        const tabs = new Set();
        // Close what we opened. A shared or remote browser outlives this process.
        const bye = async () => {
            await Promise.race([Promise.all([...tabs].map((t) => send("Target.closeTarget", { targetId: t }).catch(() => {}))),
                                new Promise((r) => setTimeout(r, 500))]);
            // A local Chrome may be serving another session: leave it running
            // while anyone else has a tab open; the last one out closes it.
            const others = await Promise.race([send("Target.getTargets").then((r) => r.targetInfos.filter((t) => t.type === "page" && t.url !== "about:blank").length).catch(() => 0),
                                               new Promise((r) => setTimeout(() => r(0), 500))]);
            // Never a --cdp browser: that one is somebody's service.
            if (!cdp && !others) await Promise.race([send("Browser.close").catch(() => {}), new Promise((r) => setTimeout(r, 500))]);
            proc?.kill();
            process.exit(0);
        };
        process.once("SIGINT", bye); process.once("SIGTERM", bye); process.stdin.once("end", bye);
        log(`browser: ${cdp ?? (proc ? "launched local Chrome" : "local Chrome")}`);
        return { send, dead, tabs };
    })().catch((e) => { conn = null; throw e; });
}

/** A new tab on `page`; returns `ev(expr)`, which evaluates in it. */
async function openTab(page, opts) {
    const { send, dead, tabs } = await browser(opts);
    const { targetId } = await send("Target.createTarget", { url: page });
    tabs.add(targetId);
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    return async (expression) => {
        if (dead.has(sessionId)) throw new Error(`tab closed: ${page}`);
        const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId)
            .catch((e) => { throw new Error(`tab closed: ${page} (${e.message})`); });
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
        return r.result.value;
    };
}

/** The tab's tools in MCP's shape. Waits for the page to register them. */
async function tabTools(ev) {
    let hasWebMCP = false;
    for (let i = 0; i < 150; i++) {
        const got = await ev(`(async () => {
            const mc = document.modelContext;
            if (!mc?.getTools) return { webmcp: false, loaded: location.protocol.startsWith("http") && document.readyState === "complete" };
            return { webmcp: true, tools: (await mc.getTools()).map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) };
        })()`).catch(() => null);
        hasWebMCP ||= !!got?.webmcp;
        // modelContext is there from the first script or never; no need to wait out the page.
        if (got && !got.webmcp && got.loaded) break;
        if (got?.tools?.length) return got.tools.map((t) => ({ ...t, inputSchema: t.inputSchema ? JSON.parse(t.inputSchema) : { type: "object" } }));
        await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(hasWebMCP
        ? "the page registered no WebMCP tools in 30s (is card.url the page that registers them?)"
        : "this browser has no WebMCP (document.modelContext.getTools): it needs Chrome 150+ with --enable-features=WebMCP, or a Chromium built with it");
}

/** One call, relayed. WebMCP takes the arguments as a JSON string and returns one. */
async function tabCall(ev, name, args) {
    const out = await ev(`document.modelContext.getTools().then((ts) => {
        const t = ts.find((t) => t.name === ${JSON.stringify(name)});
        if (!t) throw new Error("no tool " + ${JSON.stringify(name)});
        return document.modelContext.executeTool(t, ${JSON.stringify(JSON.stringify(args ?? {}))});
    })`);
    try { const r = JSON.parse(out); if (Array.isArray(r?.content)) return r; } catch {}
    return { content: [{ type: "text", text: String(out) }] };
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
      description: "List the Fangorn apps registered on chain whose agent cards verify: name, description, card URL, and the WebMCP tools each page offers. Filter with `query`. Call open-app on one to use its tools.",
      inputSchema: { type: "object", properties: { query: { type: "string", description: "Case-insensitive match on name or description" } } } },
    { name: "open-app",
      description: "Verify an app's card against the chain, open its page in a browser tab, and add its tools to this server as `<app>__<tool>`. Returns the tools and their input schemas. `app` is a name from list-apps, an appId, or a card URL.",
      inputSchema: { type: "object", properties: { app: { type: "string" } }, required: ["app"] } },
    { name: "call-app-tool",
      description: "Call one tool of an opened app. Same as calling `<app>__<tool>` directly.",
      inputSchema: { type: "object", properties: { app: { type: "string" }, tool: { type: "string" }, arguments: { type: "object" } }, required: ["app", "tool"] } },
];

/**
 * The server. `deps` is the outside world, so the self-check can fake it:
 *   findApps()          → { apps: [{ name, desc, card, appId }], rejected }
 *   resolveCard(url)    → { card, page, verified }
 *   openTab(page)       → ev
 *   tabTools(ev), tabCall(ev, name, args)
 *   notify(method)      set after serve()
 */
export function handlers(deps) {
    const open = new Map();   // slug → { name, card, verified, ev, tools }

    const findOpen = (app) => open.get(slug(app)) ?? [...open.values()].find((o) => o.card === app || o.appId === app);

    async function openApp(app) {
        const hit = findOpen(app);
        if (hit) return hit;
        let cardUrl = app, appId;
        if (!/^https?:\/\//.test(app)) {
            const { apps } = await deps.findApps();
            const a = apps.find((x) => x.appId === app || slug(x.name) === slug(app));
            if (!a) throw new Error(`no verified app named ${JSON.stringify(app)}; see list-apps`);
            ({ card: cardUrl, appId } = a);
        }
        const { card, page, verified } = await deps.resolveCard(cardUrl);
        let s = slug(card.name ?? app);
        while (open.has(s)) s += "-";
        const ev = await deps.openTab(page);
        const entry = { slug: s, name: card.name, card: cardUrl, appId, verified, page, ev, tools: await deps.tabTools(ev) };
        open.set(s, entry);
        deps.notify?.("notifications/tools/list_changed");
        return entry;
    }

    async function call(app, tool, args) {
        const o = findOpen(app);
        if (!o) throw new Error(`${app} is not open; call open-app first`);
        try { return await deps.tabCall(o.ev, tool, args); }
        catch (e) {
            if (!/tab closed/.test(e.message)) throw e;
            // The tab or the whole browser went away. Reopen once; the tools keep their names.
            o.ev = await deps.openTab(o.page);
            await deps.tabTools(o.ev);
            return deps.tabCall(o.ev, tool, args);
        }
    }

    const run = {
        "list-apps": async ({ query }) => {
            const { apps, rejected } = await deps.findApps();
            const q = String(query ?? "").toLowerCase();
            return text({
                apps: apps.filter((a) => !q || `${a.name} ${a.desc}`.toLowerCase().includes(q)).map((a) => ({
                    app: slug(a.name), name: a.name, description: a.desc, card: a.card, appId: a.appId,
                    tools: a.tools, open: open.has(slug(a.name)),
                })),
                unverified: rejected.length,
            });
        },
        "open-app": async ({ app }) => {
            const o = await openApp(app);
            return text({ app: o.slug, name: o.name, page: o.page, verified: o.verified,
                          call_as: `${o.slug}__<tool>, or call-app-tool`, tools: o.tools });
        },
        "call-app-tool": async ({ app, tool, arguments: args }) => call(app, tool, args),
    };

    return {
        initialize: async (p) => ({
            protocolVersion: p.protocolVersion ?? "2025-06-18",
            capabilities: { tools: { listChanged: true } },
            serverInfo: { name: "fangorn-mcp", version: "0.1.0" },
            instructions: "Fangorn apps are static sites whose tools run in the browser. list-apps to find one, open-app to load it, then call its tools as <app>__<tool>.",
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
    let opened = 0;
    const deps = {
        findApps: async () => ({ apps: [{ name: "Kings Foil", desc: "trials", card: "https://k.test/card", appId: "0xk", tools: ["greet"] }], rejected: [{}] }),
        resolveCard: async () => ({ card: { name: "Kings Foil" }, page: "https://k.test/p", verified: true }),
        openTab: async () => (opened++ ? "ev" : "dead"),   // the first tab dies
        tabTools: async () => [{ name: "greet", description: "Hi.", inputSchema: { type: "object" } }],
        tabCall: async (ev, name, args) => (name === "boom" ? Promise.reject(new Error("no tool boom"))
            : ev === "dead" ? Promise.reject(new Error("tab closed: x")) : text({ ev, name, args })),
    };
    deps.notify = serve(handlers(deps), { input, output });
    const rpc = (id, method, params) => input.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    const wait = () => new Promise((r) => setTimeout(r, 20));
    const call = (id, name, args) => rpc(id, "tools/call", { name, arguments: args });
    const res = (id) => replies.find((r) => r.id === id);
    const body = (id) => JSON.parse(res(id).result.content[0].text);
    const assert = (c, m) => { if (!c) throw new Error(m); };

    rpc(1, "initialize", {}); rpc(2, "tools/list"); call(3, "list-apps", { query: "TRIAL" }); call(4, "kings-foil__greet"); await wait();
    assert(res(1).result.capabilities.tools.listChanged, "advertises list_changed");
    assert(res(2).result.tools.length === 3, "only the meta tools before anything is open");
    assert(body(3).apps[0].app === "kings-foil" && body(3).unverified === 1, "list-apps filters and slugs");
    assert(res(4).result.isError && /not open/.test(res(4).result.content[0].text), "an unopened app's tool is an error");

    call(5, "open-app", { app: "Kings Foil" }); await wait();
    call(6, "open-app", { app: "https://k.test/card" }); await wait();
    assert(body(5).tools[0].name === "greet" && opened === 1, "open once, by name or by card URL");
    call(50, "kings-foil__greet", { who: "b" }); await wait();
    assert(body(50).ev === "ev" && opened === 2, "a dead tab is reopened and the call retried");
    assert(replies.some((r) => r.method === "notifications/tools/list_changed"), "opening notifies");
    rpc(7, "tools/list"); call(8, "kings-foil__greet", { who: "a" }); call(9, "call-app-tool", { app: "kings-foil", tool: "greet" });
    call(10, "call-app-tool", { app: "kings-foil", tool: "boom" }); call(11, "open-app", { app: "nope" }); rpc(12, "nope"); await wait();
    assert(res(7).result.tools.some((t) => t.name === "kings-foil__greet"), "opened tools are listed under the app");
    assert(body(8).args.who === "a" && body(9).name === "greet", "both call paths reach the tab");
    assert(res(10).result.isError && res(11).result.isError, "failures are tool errors");
    assert(res(12).error.code === -32601, "unknown method");
    console.log("mcp.js self-check ok — one server, apps opened on demand, their tools listed as <app>__<tool>");
    process.exit(0);
}

const argv = process.argv.slice(2);
const fb = argv.indexOf("--from-block");
const fromBlock = fb >= 0 ? BigInt(argv[fb + 1]) : DEFAULT_FROM_BLOCK;
const headed = argv.includes("--headed");
const ci = argv.indexOf("--cdp");
const cdp = ci >= 0 ? argv[ci + 1] : process.env.FANGORN_MCP_CDP || undefined;
let found, foundAt = 0;
const deps = {
    // ponytail: cached for a minute. The scan is a few RPC calls plus a fetch per card.
    findApps: async () => {
        if (!found || Date.now() - foundAt > 60_000) {
            const { apps, rejected } = await listApps(await fangorn(), { fromBlock });
            found = { rejected, apps: await Promise.all(apps.map(async (a) => {
                const card = await (await fetch(a.card)).json().catch(() => ({}));
                return { ...a, tools: card.skills?.filter((s) => s.tags?.includes("webmcp")).map((s) => s.id) ?? [] };
            })) };
            foundAt = Date.now();
        }
        return found;
    },
    resolveCard,
    openTab: (page) => openTab(page, { headed, cdp }),
    tabTools, tabCall,
};
deps.notify = serve(handlers(deps));
log(`ready: apps from block ${fromBlock}; browser ${cdp ?? "local Chrome"}, connected on the first open-app`);
