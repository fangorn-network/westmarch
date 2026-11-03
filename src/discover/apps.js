// The index of apps, read off the chain.
//
// An app is a publisher's repo whose `@card` record points at an agent card that points back.
// So the directory is `repos()` (one scan of the update log), each repo's `@card` (one read
// per repo, cached by head), and `discoverCard` on each card found, which checks the binding.
// No registry, no relay, nobody's server in the loop.
//
// `fangorn` is an SDK client, passed in rather than imported, so this module stays usable
// where the SDK is not installed, and testable without a chain.
//
// ponytail: one flat list, no ranking, every card fetched. Past a few hundred apps, rank by
// the cards' own coverage instead.

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

/** The SDK's FANGORN_REPO_EXTENSION. Copied so this file needs no SDK;
 *  src/agent/agent-card.js's self-check fails if the two drift. */
export const APP_EXTENSION = "https://fangorn.network/a2a/repo/v1";

/** The app's agent skill, `{url, sha256}`, when its card names one well-formed; else null. */
export const skillOf = (ext) => {
    const k = ext?.params?.skill;
    return k && safeView(k.url) && /^[0-9a-f]{64}$/.test(k.sha256 ?? "") ? { url: k.url, sha256: k.sha256 } : null;
};

// The app's Claude Code plugin, for what a skill can't do (hooks). Both fields reach a shell command
// in the reader's agent, so they are held to a GitHub owner/repo (or https URL) and a plain name.
export const PLUGIN_MARKETPLACE = /^([\w.-]+\/[\w.-]+|https:\/\/[\w.\/-]+)$/, PLUGIN_NAME = /^[a-z0-9][a-z0-9-]*$/;
export const pluginOf = (ext) => {
    const p = ext?.params?.plugin;
    return p && PLUGIN_MARKETPLACE.test(p.marketplace ?? "") && PLUGIN_NAME.test(p.name ?? "") ? { marketplace: p.marketplace, name: p.name } : null;
};

/** A verified card (`discoverCard`'s result) → an app entry. `views` etc. are westmarch's params; the SDK ignores them. */
export function toApp({ card, publisher, repo }, cardUrl) {
    const p = card.capabilities.extensions.find((e) => e.uri === APP_EXTENSION)?.params ?? {};
    const views = (Array.isArray(p.views) ? p.views : []).map(safeView).filter(Boolean);
    const paid = p.paid && /^https?:\/\//.test(p.paid.url ?? "") && p.paid.url.includes("{id}") ? { url: p.paid.url } : null;
    return {
        id: `${publisher}:${repo}`, publisher, repo, card: cardUrl,
        fromBlock: /^\d+$/.test(String(p.fromBlock)) ? BigInt(p.fromBlock) : null,
        repos: Array.isArray(p.repos) ? p.repos.filter((r) => typeof r === "string") : [],
        views, paid, skill: skillOf({ params: p }), plugin: pluginOf({ params: p }),
        mcp: safeView(p.mcp),
        tools: (card.skills ?? []).map((k) => k.id),
        name: card.name ?? repo,
        desc: card.description ?? "",
        url: safeView(card.url),
    };
}

// Blocks this close to the head can still reorg: read again every time, never stored.
const SETTLED = 64n;

/**
 * Logs from `start` to `head`, oldest first, reading only the blocks `store`
 * has not seen. A scan from the registry's deployment grows with the chain;
 * this one grows with the time since the last call. `store` is `{ get, set }`
 * of `{ to, logs }` by `key`; `read(from, to)` returns logs with `blockNumber`.
 */
export async function cachedLogs(store, key, start, head, read) {
    const hit = store.get(key) ?? { to: start - 1n, logs: [] };
    const fresh = hit.to < head ? await read(hit.to + 1n, head) : [];
    const settled = head - SETTLED;
    if (settled > hit.to) store.set(key, { to: settled, logs: [...hit.logs, ...fresh.filter((l) => l.blockNumber <= settled)] });
    return [...hit.logs, ...fresh];
}

/**
 * Every app with a bound, verifiable card. The ones that fail are reported with the reason,
 * not dropped: a card that is down and a card that lies look the same from outside, and an
 * agent should see both. `store` ({ get, set }) caches each repo's card URL by head.
 */
export async function listApps(fangorn, { fromBlock, store } = {}) {
    const repos = await fangorn.repos(fromBlock == null ? {} : { fromBlock: BigInt(fromBlock) });
    const apps = [], rejected = [];
    await Promise.all(repos.map(async ({ owner, repo, root }) => {
        const key = `card:${owner.toLowerCase()}/${repo}@${root}`;
        let url = store?.get(key);
        if (url === undefined) {
            try { url = (await fangorn.cardOf(owner, repo)) ?? null; } catch { return; }   // unreadable now: not cached, tried next time
            store?.set(key, url);
        }
        if (!url) return;
        try { apps.push(toApp(await fangorn.discoverCard(url), url)); }
        catch (e) { rejected.push({ publisher: owner, repo, card: url, why: e?.message ?? String(e) }); }
    }));
    apps.sort((a, b) => a.name.localeCompare(b.name));
    return { apps, rejected };
}

// ── self-check: `node src/discover/apps.js` ──────────────────────────────────────
if (typeof process !== "undefined" && import.meta.url === `file://${process.argv[1]}` && process.argv[1].endsWith("/apps.js")) {
    const j = (x) => JSON.stringify(x, (_, v) => (typeof v === "bigint" ? `${v}n` : v));
    const eq = (a, b, m) => { if (j(a) !== j(b)) throw new Error(`${m}: ${j(a)} != ${j(b)}`); };
    const P = "0x" + "11".repeat(20), Q = "0x" + "22".repeat(20);
    const card = (publisher, repo, name, views) => ({ name, description: `${name}!`, url: "https://x.test/", capabilities: { extensions: [
        { uri: "https://other/ext", params: { views: ["https://evil.test/"] } },
        { uri: APP_EXTENSION, params: { publisher, repo, fromBlock: "7", repos: ["n"], views } },
    ] } });
    const cards = {
        "https://a.test/card": card(P, "beta", "Beta", ["https://a.test/q/v1/stream", "javascript:alert(1)"]),
        "https://b.test/card": card(Q, "alpha", "Alpha", []),
    };
    const bound = { [`${P}/beta`]: "https://a.test/card", [`${Q}/alpha`]: "https://b.test/card", [`${Q}/liar`]: "https://liar.test/card" };
    let cardReads = 0;
    const fangorn = {
        repos: async () => [{ owner: P, repo: "beta", root: "0x1" }, { owner: Q, repo: "alpha", root: "0x2" },
                            { owner: Q, repo: "plain", root: "0x3" }, { owner: Q, repo: "liar", root: "0x4" }],
        cardOf: async (o, r) => (cardReads++, bound[`${o}/${r}`]),
        discoverCard: async (url) => {
            if (url === "https://liar.test/card") throw new Error("not bound");
            const c = cards[url], p = c.capabilities.extensions[1].params;
            return { card: c, publisher: p.publisher, repo: p.repo };
        },
    };
    const m = new Map(), store = { get: (k) => m.get(k), set: (k, v) => m.set(k, v) };
    const { apps, rejected } = await listApps(fangorn, { store });
    eq(apps.map((a) => a.name), ["Alpha", "Beta"], "one entry per carded repo, sorted, repos with no card skipped");
    const beta = apps[1];
    eq(beta.views, ["https://a.test/q/v1"], "views from the fangorn extension only, trimmed, non-http dropped");
    eq([beta.id, beta.card, beta.url, beta.fromBlock, beta.repos, beta.desc], [`${P}:beta`, "https://a.test/card", "https://x.test", 7n, ["n"], "Beta!"], "entry fields");
    eq(rejected.map((r) => r.why), ["not bound"], "a card that fails verification is reported");
    eq(cardReads, 4, "one @card read per repo");
    await listApps(fangorn, { store });
    eq(cardReads, 4, "an unchanged head is not read again");

    const asked = [];
    const chain = [{ blockNumber: 10n, n: 1 }, { blockNumber: 150n, n: 2 }, { blockNumber: 190n, n: 3 }];
    const read = async (from, to) => (asked.push([from, to]), chain.filter((l) => l.blockNumber >= from && l.blockNumber <= to));
    const lm = new Map(), ls = { get: (k) => lm.get(k), set: (k, v) => lm.set(k, v) };
    eq((await cachedLogs(ls, "k", 5n, 200n, read)).map((l) => l.n), [1, 2, 3], "first call reads it all");
    eq(lm.get("k").to, 136n, "stores only what is settled");
    eq((await cachedLogs(ls, "k", 5n, 210n, read)).map((l) => l.n), [1, 2, 3], "second call: same logs, no duplicates");
    eq(asked, [[5n, 200n], [137n, 210n]], "second call reads only from the settled point");

    console.log("apps.js self-check ok — an app is a repo whose card verifies, cards read once per head, failures reported, views gated to http(s)");
}
