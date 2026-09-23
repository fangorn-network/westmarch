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
import { mkdirSync, readFileSync, existsSync, rmSync, writeFileSync, renameSync } from "node:fs";
import { createHash } from "node:crypto";
import net from "node:net";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { APP_EXTENSION, listApps, toApp } from "./apps.js";

// The current AppRegistry's first event on Arbitrum Sepolia. A reader's
// default, not deployment config: pass --from-block for another deployment.
const DEFAULT_FROM_BLOCK = 311637349n;
const log = (...a) => console.error("[fangorn-mcp]", ...a);   // stdout is the protocol
// FANGORN_MCP_TRACE=1: step timings on stderr, for finding where an answer waits.
const T0 = performance.now();
const trace = process.env.FANGORN_MCP_TRACE ? (what) => log(`${Math.round(performance.now() - T0)}ms ${what}`) : () => {};

let client;
async function fangorn() {
    if (!client) {
        const [{ Fangorn, FangornConfig }, { generatePrivateKey }] = await Promise.all([
            import("@fangorn-network/sdk"), import("viem/accounts")]);
        client = Fangorn.create({ privateKey: generatePrivateKey(), config: FangornConfig });   // reads only
        // list-apps verifies every card and open-app verifies one again: once a minute is enough.
        const verify = client.discoverApp.bind(client), seen = new Map();
        client.discoverApp = (url) => {
            const hit = seen.get(url);
            if (hit && Date.now() - hit.at < 60_000) return hit.p;
            const p = verify(url).catch((e) => { seen.delete(url); throw e; });
            seen.set(url, { at: Date.now(), p });
            return p;
        };
    }
    return client;
}

/** A card URL → the verified card and the page to open. A plain A2A card (no
 *  Fangorn extension) opens unverified: the caller asked for it by URL. */
async function resolveCard(cardUrl) {
    const card = await (await fetch(cardUrl)).json();
    const fangornApp = card.capabilities?.extensions?.some((e) => e.uri === APP_EXTENSION);
    // Views only from a verified card, and only http(s) ones (toApp filters).
    const views = fangornApp ? toApp(await (await fangorn()).discoverApp(cardUrl), cardUrl).views : [];
    const page = new URL(card.url);
    if (page.protocol !== "https:" && page.protocol !== "http:") throw new Error(`card.url is not http(s): ${card.url}`);
    return { card, page: page.toString(), verified: fangornApp, views };
}

// ── the network ─────────────────────────────────────────────────────────────
// Every byte an answer waits on, cached where it is safe to:
//   - a content-addressed file (`…-<12 hex>.<ext>`, every shard) never changes,
//     so it is kept on disk forever. shard.js still checks it against the
//     manifest's sha256, so a bad cache entry fails loudly, not silently.
//   - catalogs, manifests and cards change on a rebake: held for a minute, so
//     one search (or resolving then verifying a card) does not fetch each twice.
const CACHE = `${homedir()}/.cache/fangorn-mcp`;
/** Stale-while-revalidate from disk: the last copy at once, a fresh one fetched
 *  behind it for next time. Only for reads where stale is harmless. */
function staleFetch(fetcher) {
    mkdirSync(`${CACHE}/stale`, { recursive: true });
    return async (url) => {
        const f = `${CACHE}/stale/${createHash("sha256").update(url).digest("hex")}`;
        const refresh = fetcher(url).then(async (r) => {
            if (!r.ok) return r;
            const b = new Uint8Array(await r.arrayBuffer());
            writeFileSync(`${f}.tmp`, b); renameSync(`${f}.tmp`, f);
            return new Response(b);
        });
        if (existsSync(f)) { refresh.catch(() => {}); return new Response(readFileSync(f)); }
        return refresh;
    };
}

function cachingFetch(real = globalThis.fetch) {
    mkdirSync(`${CACHE}/blobs`, { recursive: true });
    const memo = new Map();
    return async (input, init) => {
        const url = String(input?.url ?? input);
        if ((init?.method ?? input?.method ?? "GET") !== "GET" || !/^https?:/.test(url)) return real(input, init);
        const path = new URL(url).pathname;
        if (/-[0-9a-f]{12}\.[a-z.]+$/.test(path)) {
            const f = `${CACHE}/blobs/${createHash("sha256").update(url).digest("hex")}`;
            if (existsSync(f)) return new Response(readFileSync(f));
            const r = await real(input, init);
            if (!r.ok) return r;
            const b = new Uint8Array(await r.arrayBuffer());
            writeFileSync(`${f}.tmp`, b); renameSync(`${f}.tmp`, f);   // never a torn file
            return new Response(b, { headers: r.headers });
        }
        // A card, catalog or manifest is small: 8s without one means the host is
        // down, and a dead card in the directory must not stall a listing for a
        // TCP timeout. Shards get no deadline; a big file on a slow link is legitimate.
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
    // 30s: a cold start on a loaded machine or CI box has taken 16s.
    for (let i = 0; i < 300; i++) {
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
      description: "Verify an app's card against the chain and add its tools to this server as `<app>__<tool>`. An app that publishes views gets fast data tools (describe, search, get, similar, count, browse) with no browser. `page: true` also opens the app's page in a browser for its own WebMCP tools (slower). `app` is a name from list-apps, an appId, or a card URL.",
      inputSchema: { type: "object", properties: { app: { type: "string" }, page: { type: "boolean", description: "Also load the page's own WebMCP tools in a browser" } }, required: ["app"] } },
    { name: "call-app-tool",
      description: "Call one tool of an opened app. Same as calling `<app>__<tool>` directly.",
      inputSchema: { type: "object", properties: { app: { type: "string" }, tool: { type: "string" }, arguments: { type: "object" } }, required: ["app", "tool"] } },
];

/**
 * The server. `deps` is the outside world, so the self-check can fake it:
 *   findApps()          → { apps: [{ name, desc, card, appId }], rejected }
 *   findByName(name)    → { card, appId } | null     (optional: a direct registry read)
 *   resolveCard(url)    → { card, page, verified, views }
 *   viewTools(app)      → { tools, call(name, args) } | null   (no browser)
 *   openTab(page)       → ev
 *   tabTools(ev), tabCall(ev, name, args)
 *   notify(method)      set after serve()
 */
export function handlers(deps) {
    const open = new Map();   // slug → { name, card, verified, page, views?, pages?, tools }

    const findOpen = (app) => open.get(slug(app)) ?? [...open.values()].find((o) => o.card === app || o.appId === app);
    const retool = (o) => {
        const taken = new Set(o.views?.tools.map((t) => t.name));
        // A page tool that shares a data tool's name is kept, under `page-<name>`.
        o.pageNames = new Map((o.pageTools ?? []).map((t) => [taken.has(t.name) ? `page-${t.name}` : t.name, t.name]));
        o.tools = [...(o.views?.tools ?? []), ...(o.pageTools ?? []).map((t) => ({ ...t, name: taken.has(t.name) ? `page-${t.name}` : t.name }))];
    };
    async function openPage(o) {
        o.ev = await deps.openTab(o.page);
        o.pageTools = await deps.tabTools(o.ev);
    }

    async function openApp(app, { page = false } = {}) {
        const hit = findOpen(app);
        if (hit && (hit.ev || !page)) return hit;
        let o = hit;
        if (!o) {
            let cardUrl = app, appId;
            if (!/^https?:\/\//.test(app)) {
                // One registry read when the name is the app's own; the scan only when it is not.
                trace(`open ${app}: lookup`);
                const a = await deps.findByName?.(app)
                    ?? (await deps.findApps()).apps.find((x) => x.appId === app || slug(x.name) === slug(app));
                if (!a) throw new Error(`no verified app named ${JSON.stringify(app)}; see list-apps`);
                ({ card: cardUrl, appId } = a);
            }
            trace(`open ${app}: resolve ${cardUrl}`);
            const { card, page: url, verified, views } = await deps.resolveCard(cardUrl);
            trace(`open ${app}: verified`);
            let s = slug(card.name ?? app);
            while (open.has(s)) s += "-";
            o = { slug: s, name: card.name, card: cardUrl, appId, verified, page: url,
                  views: deps.viewTools?.({ name: card.name, desc: card.description, views }) ?? null };
        }
        // The browser only when asked, or when there is no other way in.
        if (page || !o.views) await openPage(o);
        retool(o);
        trace(`open ${app}: ready`);
        open.set(o.slug, o);
        deps.notify?.("notifications/tools/list_changed");
        return o;
    }

    async function call(app, tool, args) {
        const o = findOpen(app);
        if (!o) throw new Error(`${app} is not open; call open-app first`);
        if (!o.pageNames?.has(tool)) {
            if (o.views?.tools.some((t) => t.name === tool)) return o.views.call(tool, args);
            throw new Error(`${o.slug} has no tool ${tool}${o.ev ? "" : " (its page tools load with open-app page: true)"}`);
        }
        const name = o.pageNames.get(tool);
        try { return await deps.tabCall(o.ev, name, args); }
        catch (e) {
            if (!/tab closed/.test(e.message)) throw e;
            // The tab or the whole browser went away. Reopen once; the tools keep their names.
            await openPage(o);
            return deps.tabCall(o.ev, name, args);
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
        "open-app": async ({ app, page }) => {
            const o = await openApp(app, { page });
            return text({ app: o.slug, name: o.name, verified: o.verified,
                          data_tools: !!o.views, page_tools: o.ev ? o.page : false,
                          call_as: `${o.slug}__<tool>, or call-app-tool`, tools: o.tools });
        },
        "call-app-tool": async ({ app, tool, arguments: args }) => call(app, tool, args),
    };

    return {
        initialize: async (p) => ({
            protocolVersion: p.protocolVersion ?? "2025-06-18",
            capabilities: { tools: { listChanged: true } },
            serverInfo: { name: "fangorn-mcp", version: "0.1.0" },
            instructions: "Fangorn apps are static sites anchored on chain. list-apps to find one, open-app to load it, then call its tools as <app>__<tool>. Start with <app>__describe when it exists.",
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

    // An app with views: data tools, no browser, until page: true.
    {
        const out2 = new PassThrough(), in2 = new PassThrough(), r2 = [];
        createInterface({ input: out2 }).on("line", (l) => r2.push(JSON.parse(l)));
        let tabs = 0;
        const d2 = { ...deps,
            resolveCard: async () => ({ card: { name: "Kings Foil" }, page: "https://k.test/p", verified: true, views: ["https://k.test/v"] }),
            viewTools: (app) => ({ tools: [{ name: "search" }, { name: "greet" }], call: async (n, a) => text({ via: "views", n, a, views: app.views }) }),
            openTab: async () => (tabs++, "ev"),
        };
        d2.notify = serve(handlers(d2), { input: in2, output: out2 });
        const q = (id, name, args) => in2.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) + "\n");
        const got = (id) => r2.find((r) => r.id === id)?.result;
        q(1, "open-app", { app: "Kings Foil" }); await wait(); q(2, "kings-foil__search", { query: "x" }); await wait();
        assert(tabs === 0 && JSON.parse(got(1).content[0].text).data_tools, "views mean no browser");
        assert(JSON.parse(got(2).content[0].text).via === "views", "data tools answer from the views");
        q(3, "open-app", { app: "kings-foil", page: true }); await wait();
        const names = JSON.parse(got(3).content[0].text).tools.map((t) => t.name);
        assert(tabs === 1 && names.includes("search") && names.includes("greet") && names.includes("page-greet"), `page: true adds page tools, a clash renamed: ${names}`);
        q(4, "kings-foil__page-greet", { who: "p" }); q(5, "kings-foil__greet", {}); await wait();
        assert(JSON.parse(got(4).content[0].text).ev === "ev" && JSON.parse(got(5).content[0].text).via === "views", "each name reaches its own side");
    }
    console.log("mcp.js self-check ok — one server, apps opened on demand, data tools without a browser, page tools on request");
    process.exit(0);
}

const argv = process.argv.slice(2);
globalThis.fetch = cachingFetch();
// Node gives each address 250ms before trying the next; on a slow link, or a
// host with no working IPv6, every attempt times out and fetch fails outright.
net.setDefaultAutoSelectFamilyAttemptTimeout?.(2000);
const vt = await import("./view-tools.js");
const stale = staleFetch(globalThis.fetch);
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
    findByName: async (name) => {
        const [f, { appId }] = await Promise.all([fangorn(), import("@fangorn-network/sdk")]);
        const reg = f.getAppRegistry();
        for (const id of /^0x[0-9a-fA-F]{64}$/.test(name) ? [name] : [...new Set([name, name.toLowerCase()])].map(appId)) {
            const card = await reg.appAgentUri(id).catch(() => "");
            if (card) return { card, appId: id };
        }
        return null;
    },
    resolveCard,
    viewTools: (app) => {
        const v = vt.viewTools(app, { fetchCatalog: stale });
        if (v) vt.warm({ cacheDir: `${CACHE}/models` });   // already started at initialize; this is the fallback
        return v;
    },
    openTab: (page) => openTab(page, { headed, cdp }),
    tabTools, tabCall,
};
const h = handlers(deps);
// The client starts this server with the session, long before an agent opens an
// app: load the SDK and the embedding model then, behind the agent's first
// thought. After the initialize reply, not before: both block the thread while
// they load, and the client is waiting on that reply.
const reply = h.initialize;
h.initialize = async (p) => {
    setImmediate(() => {
        fangorn().then(() => trace("sdk ready"), () => {});
        vt.warm({ cacheDir: `${CACHE}/models` }).then((ok) => ok ? trace("embedder ready")
            : log(`embedder unavailable, searching by words: ${vt.warmError}`));
    });
    return reply(p);
};
deps.notify = serve(h);
log(`ready: apps from block ${fromBlock}; browser ${cdp ?? "local Chrome"}, connected on the first open-app`);
