// The index of apps — read off the chain.
//
// An app owner binds its agent card with `setAppAgentUri`, and the AppRegistry
// emits `AppAgentChanged(appId, uri)`. The log IS the directory: no registry
// namespace to bake, no relay to ask, nobody's server in the loop. Scan the
// logs, keep each app's latest uri, and hand every uri to `discoverApp`, which
// fetches the card and checks it names that app and is still the one bound on
// chain. The card then says where the data is (`views`) and where it starts
// (`fromBlock`).
//
// `fangorn` is an SDK client, passed in rather than imported, so this module
// stays usable where the SDK is not installed, and testable without a chain.
// Reads only: a reader can create one with a throwaway key.
//
// ponytail: one flat list, no ranking. Every card is one fetch, all in
// parallel. Past a few hundred apps, rank by the cards' own coverage instead of
// fetching them all.

/**
 * A pointer someone else wrote, and following it is the one place a reader
 * navigates to a URL it did not configure. So: http(s) only. `javascript:` and
 * `data:` never reach a fetch or an EventSource from here.
 */
function safeView(url) {
    try {
        const u = new URL(String(url));
        if (u.protocol !== "https:" && u.protocol !== "http:") return null;
        return u.toString().replace(/\/+$/, "").replace(/\/(stream|cdn)$/, "");
    } catch { return null; }
}

/** The SDK's FANGORN_APP_EXTENSION. Copied so this file needs no SDK;
 *  src/agent/agent-card.js's self-check fails if the two drift. */
export const APP_EXTENSION = "https://fangorn.network/a2a/app/v1";

/** A verified card → an app entry. `views` is westmarch's param; the SDK does not read it. */
export function toApp({ card, appId, fromBlock, namespaces }, cardUrl) {
    const ext = card.capabilities.extensions.find((e) => e.uri === APP_EXTENSION);
    const views = (Array.isArray(ext?.params?.views) ? ext.params.views : []).map(safeView).filter(Boolean);
    const p = ext?.params?.paid;
    const paid = p && /^https?:\/\//.test(p.url ?? "") && p.url.includes("{id}") && /^\d+$/.test(String(p.price)) ? p : null;
    return {
        appId, card: cardUrl, fromBlock, namespaces, views, paid,
        name: card.name ?? appId,
        desc: card.description ?? "",
        url: safeView(card.url),
    };
}

/**
 * Every app with a bound, verifiable card. The ones that fail are reported
 * with the reason, not dropped: a card that is down and a card that lies look
 * the same from outside, and an agent should see both.
 *
 * An app that cleared its uri (bound to "") is skipped. It is not an error.
 */
export async function listApps(fangorn, { fromBlock, toBlock } = {}) {
    if (fromBlock == null) throw new Error("listApps: pass fromBlock, a block at or before the AppRegistry's deployment — from 0 is one RPC call per 1000 blocks of chain history");
    const logs = await fangorn.getAppRegistry().getAppAgentLogs({ fromBlock: BigInt(fromBlock), toBlock });
    // Oldest first, so the last write wins. discoverApp re-reads the binding,
    // so a stale uri here is caught there, not trusted.
    const latest = new Map(logs.map((l) => [l.appId, l.agentUri]));
    const apps = [], rejected = [];
    await Promise.all([...latest].map(async ([appId, uri]) => {
        if (!uri) return;
        try { apps.push(toApp(await fangorn.discoverApp(uri), uri)); }
        catch (e) { rejected.push({ appId, card: uri, why: e?.message ?? String(e) }); }
    }));
    apps.sort((a, b) => a.name.localeCompare(b.name));
    return { apps, rejected };
}

// ── self-check: `node src/discover/apps.js` ──────────────────────────────────────
if (typeof process !== "undefined" && import.meta.url === `file://${process.argv[1]}` && process.argv[1].endsWith("/apps.js")) {
    const j = (x) => JSON.stringify(x, (_, v) => (typeof v === "bigint" ? `${v}n` : v));
    const eq = (a, b, m) => { if (j(a) !== j(b)) throw new Error(`${m}: ${j(a)} != ${j(b)}`); };
    const A = "0x" + "a".repeat(64), B = "0x" + "b".repeat(64), C = "0x" + "c".repeat(64);
    const card = (appId, name, views) => ({ name, description: `${name}!`, url: "https://x.test/", capabilities: { extensions: [
        { uri: "https://other/ext", params: { appId, views: ["https://evil.test/"] } },
        { uri: "https://fangorn.network/a2a/app/v1", params: { appId, views } },
    ] } });
    const cards = {
        "https://a.test/card": card(A, "Beta", ["https://a.test/q/v1/stream", "javascript:alert(1)"]),
        "https://a.test/old": card(A, "Old", []),
        "https://b.test/card": card(B, "Alpha", []),
    };
    let askedFrom;
    const fangorn = {
        getAppRegistry: () => ({ getAppAgentLogs: ({ fromBlock }) => (askedFrom = fromBlock, Promise.resolve([
            { appId: A, agentUri: "https://a.test/old" },
            { appId: B, agentUri: "https://b.test/card" },
            { appId: A, agentUri: "https://a.test/card" },   // A rebound: last wins
            { appId: C, agentUri: "https://c.test/card" },
            { appId: C, agentUri: "" },                      // C unbound
            { appId: "0x" + "d".repeat(64), agentUri: "https://liar.test/card" },
        ])) }),
        discoverApp: async (uri) => {
            if (uri === "https://liar.test/card") throw new Error("not bound to app");
            const c = cards[uri];
            return { card: c, appId: c.capabilities.extensions[1].params.appId, fromBlock: 7n, namespaces: ["n"] };
        },
    };
    const { apps, rejected } = await listApps(fangorn, { fromBlock: 42 });
    eq(askedFrom, 42n, "fromBlock forwarded as bigint");
    eq(apps.map((a) => a.name), ["Alpha", "Beta"], "one entry per app, latest card, sorted, unbound skipped");
    const beta = apps[1];
    eq(beta.views, ["https://a.test/q/v1"], "views from the fangorn extension only, trimmed, non-http dropped");
    eq([beta.appId, beta.card, beta.url, beta.fromBlock, beta.desc], [A, "https://a.test/card", "https://x.test", 7n, "Beta!"], "entry fields");
    eq(rejected.map((r) => r.why), ["not bound to app"], "a card that fails verification is reported");
    await listApps(fangorn).then(() => { throw new Error("missing fromBlock must throw"); }, () => {});

    console.log("apps.js self-check ok — latest card per app, unbound skipped, failures reported, views gated to http(s)");
}
