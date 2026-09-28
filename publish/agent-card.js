// The A2A agent card for a runtime-free backend: `/.well-known/agent-card.json`.
//
// A WebMCP tool lives on `document.modelContext` inside a loaded tab. There is
// no endpoint to crawl, so the card is the only machine-readable trace of the
// tools: a discovering agent learns the verbs exist from here or not at all.
//
// The tools are CAPTURED, not transcribed. The page's own register function is
// run against a stub `document.modelContext` that records what it registers.
// Registration only builds descriptors, and no `execute` fires, so the card is
// generated from the same declarations the browser sees. Add a tool and it
// appears on the next build; there is no second list to drift.
//
// The Fangorn extension is what makes the card an APP rather than a web page.
// It names the app, where its data starts on chain, and which namespaces and
// views hold it. It only counts once the app owner binds the card's URL on
// chain (`setAppAgentUri`). `discoverApp` refuses a card whose app does not
// point back at it, so writing someone else's appId here gets you nothing.

import { FANGORN_APP_EXTENSION, FangornConfig, appId as hashAppId } from "@fangorn-network/sdk";

/** Run `register` against a recording `document.modelContext`; return what it
 *  registered. `register` is whatever the page calls at load. */
export async function captureTools(register) {
    const tools = [];
    const had = "document" in globalThis, prev = globalThis.document;
    globalThis.document = { modelContext: { registerTool: (t) => tools.push(t) } };
    try { await register(); } finally {
        if (had) globalThis.document = prev; else delete globalThis.document;
    }
    if (!tools.length) throw new Error("no tools captured — does register() call document.modelContext.registerTool?");
    return tools;
}

const HEX32 = /^0x[0-9a-fA-F]{64}$/;

/**
 * The card.
 *
 * `fangorn` is optional: without it this is a plain A2A card for a page with
 * tools. With it, `{app, fromBlock, namespaces, views, config}`:
 *   app        the app's name or its bytes32 id
 *   fromBlock  a block at or before the app's registration. The reader's log
 *              scan starts here; leave it at 0 and a reader makes one RPC call
 *              per 1000 blocks of chain history.
 *   views      view bases (quickbeam) holding the baked data. Read by
 *              westmarch's directory; the SDK ignores it.
 *   config     the deployment; defaults to the SDK's, so the addresses in the
 *              card cannot drift from the ones `discoverApp` checks.
 */
export function agentCard({ name, description, url, version = "0.0.0", tools = [], tags = [], skills = [], fangorn, ...rest }) {
    if (!name || !url) throw new Error("agentCard: name and url are required");
    const card = {
        protocolVersion: "0.3.0",
        name, description: description ?? "", url, version,
        capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
        defaultInputModes: ["application/json"],
        defaultOutputModes: ["application/json"],
        ...rest,
        skills: [
            // `webmcp` is how a caller knows it needs a browser it can drive.
            ...tools.map((t) => ({
                id: t.name,
                name: t.name.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase()),
                description: t.description ?? "",
                tags: [...tags, "webmcp"],
            })),
            ...skills,
        ],
    };
    if (fangorn) card.capabilities.extensions = [fangornExtension(fangorn)];
    return card;
}

/** The params `discoverApp` reads, validated the same way it validates them.
 *  A malformed card should fail the build, not the first reader. */
export function fangornExtension({ app, fromBlock, namespaces = [], views = [], paid, config = FangornConfig }) {
    if (!app) throw new Error("fangorn.app is required");
    const id = HEX32.test(app) ? app : hashAppId(app);
    const from = String(fromBlock ?? "");
    if (!/^\d+$/.test(from)) throw new Error(`fangorn.fromBlock must be a non-negative integer, got ${fromBlock}`);
    if (!namespaces.every((n) => typeof n === "string")) throw new Error("fangorn.namespaces must be strings");
    for (const v of views) {
        const u = new URL(v);   // throws on garbage
        if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error(`fangorn.views: not http(s): ${v}`);
    }
    // `paid`: records sold over x402. `url` has an `{id}` for the record's id; `price` is in
    // the token's base units. Readers only offer to buy; the 402 itself is the quote.
    if (paid) {
        const u = new URL(paid.url.replace("{id}", "x"));
        if (!/^https?:$/.test(u.protocol) || !paid.url.includes("{id}")) throw new Error(`fangorn.paid.url must be http(s) with {id}: ${paid.url}`);
        if (!/^\d+$/.test(String(paid.price))) throw new Error(`fangorn.paid.price must be base units, got ${paid.price}`);
        if (!/^0x[0-9a-fA-F]{40}$/.test(paid.asset ?? "")) throw new Error(`fangorn.paid.asset must be a token address`);
    }
    return {
        uri: FANGORN_APP_EXTENSION,
        description: "The Fangorn app this agent fronts.",
        required: false,
        params: {
            chainId: config.caip2,
            appRegistry: config.appRegistryContractAddress,
            dataRegistry: config.dataRegistryContractAddress,
            appId: id, fromBlock: from, namespaces, views,
            ...(paid ? { paid: { url: paid.url, price: String(paid.price), asset: paid.asset, network: paid.network,
                                 symbol: paid.symbol ?? "USDC", decimals: paid.decimals ?? 6, description: paid.description ?? "" } } : {}),
        },
    };
}

// ── self-check: `node publish/agent-card.js` ────────────────────────────────
if (typeof process !== "undefined" && import.meta.url === `file://${process.argv[1]}` && process.argv[1].endsWith("/agent-card.js")) {
    const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); };
    const throws = (f, re, m) => { try { f(); } catch (e) { if (re.test(e.message)) return; throw e; } throw new Error(`must throw: ${m}`); };

    const { APP_EXTENSION } = await import("../consume/apps.js");
    eq(APP_EXTENSION, FANGORN_APP_EXTENSION, "consume/apps.js's copy of the extension uri");

    let fired = 0;
    const tools = await captureTools(() => {
        document.modelContext.registerTool({ name: "search-rows", description: "Search.", execute: () => fired++ });
        document.modelContext.registerTool({ name: "get-row", description: "One row.", execute: () => fired++ });
    });
    eq(tools.map((t) => t.name), ["search-rows", "get-row"], "captured tools");
    if (fired) throw new Error("capture must not execute tools");
    if ("document" in globalThis) throw new Error("stub document must not leak");
    await captureTools(() => {}).then(() => { throw new Error("empty capture must throw"); }, () => {});

    const plain = agentCard({ name: "X", url: "https://x.test", tools, tags: ["x"] });
    eq(plain.skills.map((s) => [s.id, s.name, s.tags]), [["search-rows", "Search rows", ["x", "webmcp"]], ["get-row", "Get row", ["x", "webmcp"]]], "skills");
    if (plain.capabilities.extensions) throw new Error("no fangorn → no extension");

    const card = agentCard({ name: "X", url: "https://x.test", tools, fangorn: { app: "kingsfoil", fromBlock: 5n, namespaces: ["kingsfoil"], views: ["https://x.test/v1"] } });
    const [ext] = card.capabilities.extensions;
    eq(ext.uri, FANGORN_APP_EXTENSION, "extension uri");
    eq(ext.params.appId, hashAppId("kingsfoil"), "app name hashes to the id the registry uses");
    eq([ext.params.chainId, ext.params.appRegistry, ext.params.fromBlock], [FangornConfig.caip2, FangornConfig.appRegistryContractAddress, "5"], "deployment + fromBlock as a decimal string");
    eq(fangornExtension({ app: ext.params.appId, fromBlock: 0 }).params.appId, ext.params.appId, "a bytes32 id passes through");

    throws(() => fangornExtension({ app: "a", fromBlock: -1 }), /fromBlock/, "negative fromBlock");
    throws(() => fangornExtension({ app: "a" }), /fromBlock/, "missing fromBlock");
    throws(() => fangornExtension({ app: "a", fromBlock: 0, views: ["javascript:alert(1)"] }), /views/, "non-http view");
    throws(() => agentCard({ name: "X" }), /url/, "missing url");

    console.log("agent-card.js self-check ok — tools captured without executing, extension matches the SDK's, bad params fail the build");
}
