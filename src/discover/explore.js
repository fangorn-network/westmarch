// The Fangorn explorer: every verified app, what it is about, and what the
// ERC-8004 registries say about it — read live, with no bake of its own.
//
// Everything here is already published by someone else:
//   AppRegistry `AppAgentChanged`   which apps exist and where their cards are
//   each card                       name, tools, views; checked against the chain
//   each view's catalog             rows, domains, and coverage centroids (what it is about)
//   ERC-8004 identity `Registered`  the agent minted for the app
//   ERC-8004 reputation             feedback count and average per agent
//
// Both registries are scanned from their first event in 10M-block windows, in
// parallel, so the page and the MCP tool read the same chain the same way, and
// a new app shows up on the next read.
//
// `client` is a viem PublicClient (getLogs, readContract): passed in, so this
// runs in a tab and in node, and the self-check needs no chain.
//
// ponytail: windows grow with the chain (1 + 8 at block 316M, ~0.2s). Index
// the logs somewhere if that ever gets slow.

import { parseAbi, parseAbiItem } from "viem";
import { APP_EXTENSION } from "./apps.js";
import { survey, comparable } from "./directory.js";
import { rankDomains, zFloor, lexScore } from "../core/rank.js";

export const CHAIN = {
    chainId: 421614,
    appRegistry: "0x11d228c4774af3d9cae3b4b6874a12576a1a83ec",
    identity: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
    reputation: "0x8004B663056A597Dffe9eCcC1965A193B7388713",
    // Each registry's first event (2026-10-05): nothing to read before it.
    // Scanning from 0 instead was 32 windows per registry, ~5s of a 7.7s load.
    appRegistryFrom: 311_639_205n,
    identityFrom: 241_557_787n,
    scan: (agentId) => `https://8004scan.io/agents/arbitrum-sepolia/${agentId}`,
};

const APP_AGENT_CHANGED = parseAbiItem("event AppAgentChanged(bytes32 indexed app_id, string agent_uri)");
const REGISTERED = parseAbiItem("event Registered(uint256 indexed agentId, string agentURI, address indexed owner)");
const APPS = parseAbi(["function getAppOwner(bytes32) view returns (address)"]);
const REP = parseAbi([
    "function getClients(uint256) view returns (address[])",
    "function getSummary(uint256, address[], string, string) view returns (uint64, int128, uint8)",
]);

/** A link someone else wrote, shown to a reader: https or nothing. */
const https = (u) => { try { const x = new URL(String(u)); return x.protocol === "https:" ? x.href : null; } catch { return null; } };
const slug = (name) => String(name).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "app";

/** A card is listed only if it names this chain's AppRegistry and the app that
 *  bound it — the checks `discoverApp` makes. The binding itself is the log we
 *  read it from: we scanned to `latest`, so the last write per app is current. */
export function verifyCard(card, appId, chain = CHAIN) {
    const p = card?.capabilities?.extensions?.find((e) => e.uri === APP_EXTENSION)?.params;
    if (!p) return "no fangorn app extension";
    if (String(p.appId).toLowerCase() !== appId.toLowerCase()) return "card names another app";
    if (p.chainId !== chain.chainId || String(p.appRegistry).toLowerCase() !== chain.appRegistry.toLowerCase()) return "card is for another registry";
    if (!/^\d+$/.test(String(p.fromBlock))) return "bad fromBlock";
    return null;
}

/**
 * The agent an app registered. `fangorn app agent` mints it and then binds the
 * card, from the owner's wallet, so it is the owner's latest `Registered` at or
 * before the binding.
 *
 * ponytail: paired by owner and block, not by reading the registration file
 * (IPFS gateways are too slow and flaky for a page load). An owner that
 * rebinds with --skip-register after minting another app's agent gets that
 * agent; fetch tokenURI and match its A2A endpoint if that starts happening.
 */
export function pairAgent(registered, owner, bindBlock) {
    let best = null;
    for (const r of registered) {
        if (r.owner.toLowerCase() !== owner.toLowerCase() || r.block > bindBlock) continue;
        if (!best || r.block > best.block || (r.block === best.block && r.agentId > best.agentId)) best = r;
    }
    return best?.agentId ?? null;
}

/** Retried: dropping a verified app over a blip hides it from everyone who
 *  loads the page in that second. Seen 2026-09-28: headless Chrome in WSL got
 *  intermittent net::ERR_SSL_PROTOCOL_ERROR from one pages.dev host (curl never
 *  did); three tries do not always get past that one. */
async function json(url, timeoutMs = 8000, tries = 3) {
    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
    } catch (e) {
        if (tries <= 1) throw e;
        await new Promise((ok) => setTimeout(ok, 600 * (4 - tries)));   // 600ms, then 1.2s
        return json(url, timeoutMs, tries - 1);
    }
}

async function reputation(client, agentId, chain) {
    try {
        const clients = await client.readContract({ address: chain.reputation, abi: REP, functionName: "getClients", args: [agentId] });
        if (!clients.length) return { feedback: 0, average: null };
        const [count, value, decimals] = await client.readContract({ address: chain.reputation, abi: REP, functionName: "getSummary", args: [agentId, clients, "", ""] });
        return { feedback: Number(count), average: Number(value) / 10 ** decimals, clients: clients.length };
    } catch (e) {
        return { error: e?.shortMessage ?? e?.message ?? String(e) };
    }
}

// The public Arbitrum Sepolia RPC refuses an address+event getLogs spanning more
// than 10M blocks (from 2026-10; one call from 0 worked before).
const LOG_WINDOW = 10_000_000n;

async function getLogsSince(client, start, filter) {
    const head = await client.getBlockNumber();
    const windows = [];
    for (let from = start; from <= head; from += LOG_WINDOW) {
        const to = from + LOG_WINDOW - 1n < head ? from + LOG_WINDOW - 1n : head;
        windows.push(client.getLogs({ ...filter, fromBlock: from, toBlock: to }));
    }
    return (await Promise.all(windows)).flat();   // in window order: oldest first still holds
}

/**
 * Every verified app, with its 8004 agent, reputation, and catalog.
 * Unverified apps are dropped, not listed; `dropped` says why, for debugging.
 *
 * `onUpdate({ apps, pending })`, if given, is called once the bindings are read
 * and again as each app lands or drops, so a page can show apps as they arrive.
 * `pending` counts the bound apps not yet settled.
 */
export async function readDirectory(client, { chain = CHAIN, onUpdate = () => {} } = {}) {
    const [bindLogs, regLogs] = await Promise.all([
        getLogsSince(client, chain.appRegistryFrom ?? 0n, { address: chain.appRegistry, event: APP_AGENT_CHANGED }),
        getLogsSince(client, chain.identityFrom ?? 0n, { address: chain.identity, event: REGISTERED }),
    ]);
    const registered = regLogs.map((l) => ({ agentId: l.args.agentId, owner: l.args.owner, block: l.blockNumber }));
    const latest = new Map();   // logs come oldest first: the last write wins
    for (const l of bindLogs) latest.set(l.args.app_id, { uri: l.args.agent_uri, block: l.blockNumber });
    const bound = [...latest].filter(([, { uri }]) => uri);   // an empty uri is unbound on purpose

    // One pipeline per app, so the quick ones need not wait on Quorum's 1.7 MB
    // catalog. Only a card failure drops an app; an owner or catalog that fails
    // leaves it listed with less to say about it.
    const apps = [], dropped = [];
    let pending = bound.length;
    const settle = () => { pending--; apps.sort((a, b) => a.name.localeCompare(b.name)); onUpdate({ apps: [...apps], pending }); };
    onUpdate({ apps: [], pending });
    await Promise.all(bound.map(async ([appId, { uri, block }]) => {
        let card;
        try {
            if (!/^https:\/\//.test(uri)) throw new Error("card is not https");
            card = await json(uri);
            const why = verifyCard(card, appId, chain);
            if (why) throw new Error(why);
        } catch (e) { dropped.push({ card: uri, why: e?.message ?? String(e) }); return settle(); }

        const p = card.capabilities.extensions.find((e) => e.uri === APP_EXTENSION).params;
        const [[owner, agentId, rep], { corpora, unreachable }] = await Promise.all([
            client.readContract({ address: chain.appRegistry, abi: APPS, functionName: "getAppOwner", args: [appId] }).catch(() => null)
                .then(async (owner) => {
                    const agentId = owner && pairAgent(registered, owner, block);
                    return [owner, agentId, agentId == null ? null : await reputation(client, agentId, chain)];
                }),
            survey((p.views ?? []).filter((v) => /^https:\/\//.test(v))),
        ]);
        const name = typeof card.name === "string" && card.name.trim() ? card.name.trim() : `App ${appId.slice(0, 10)}`;
        apps.push({
            app: slug(name), name, description: typeof card.description === "string" ? card.description : "",
            site: https(card.url), card: uri, appId, owner,
            boundAt: Number(block), fromBlock: Number(p.fromBlock),
            tools: (card.skills ?? []).map((s) => s.id),
            agent: agentId == null ? null : { id: Number(agentId), scan: chain.scan(agentId) },
            reputation: rep,
            // null, not 0, when no catalog answered: "0 records" would claim it was counted.
            rows: corpora.length ? corpora.reduce((n, c) => n + (c.rows || 0), 0) : null,
            unreachable: unreachable.length,
            domains: corpora.map((c) => ({ name: c.domain, description: c.description, rows: c.rows, coverage: c.coverage, model: c.model })),
        });
        settle();
    }));
    return { apps, dropped };
}

/** A calibration knob, not a law: nomic-embed-text-v1.5 at 256d, 5 apps
 *  (2026-09-28). Every on-topic top app scored >= 0.545 ("a cozy game" ->
 *  Sidequest), every off-topic top <= 0.52 ("bitcoin" -> Audius). Re-measure
 *  with the explorer's check when the model or the network changes much. */
export const MIN_AFFINITY = 0.53;

// ponytail: a short English list, enough for questions put to a directory.
const FILLER = new Set("the and for are was were has have had not but with from that this these those what which where when who whom whose why how can could would should will shall may might must about into onto over under than then there their them they you your our any all some more most much many app apps find show tell learn know want need good best reputable".split(" "));

/**
 * Rank a directory against a question. An app scores as its best domain's
 * coverage affinity (what its data is about, not what its blurb says). With no
 * `qv` (no embedder yet), name and description are matched by words.
 *
 * `relevant`: mean + 1σ of this query's scores, and at least MIN_AFFINITY.
 * Unlike findCorpora the top app is NOT always relevant: "which app has stock
 * prices" must be able to answer "none", or the explorer vouches for a
 * government-records app on a finance question.
 */
export function rankApps(apps, query, { qv = null, model = null } = {}) {
    const q = String(query ?? "").trim().toLowerCase();
    if (!q) return apps.map((a) => ({ ...a, score: null, relevant: null, ranked_by: null }));
    // Filler dropped, or "where can I learn about X" matches every blurb with "about" in it.
    const content = q.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2 && !FILLER.has(w)).join(" ");
    const words = (a) => (content ? lexScore({ text: `${a.name} ${a.description} ${a.domains.map((d) => d.description ?? "").join(" ")}` }, content) : 0);
    let scored;
    if (qv) {
        scored = apps.map((a) => {
            const doms = rankDomains(a.domains.filter((d) => comparable(d, model)), qv);
            const best = doms.find((d) => d.affinity != null);
            // No coverage (its catalog did not answer, or predates coverage):
            // its own blurb, by words, rather than silently ranking it last.
            if (!best) return { ...a, score: null, matched: null, ranked_by: "words", wordHit: words(a) > 0 };
            return { ...a, score: best.affinity, matched: best.name, ranked_by: "meaning" };
        });
    } else {
        scored = apps.map((a) => ({ ...a, score: words(a), ranked_by: "words" }));
    }
    scored.sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity));
    const s = scored.filter((a) => a.ranked_by === "meaning").map((a) => a.score);
    const floor = qv ? Math.max(zFloor(s), MIN_AFFINITY) : 1e-9;
    return scored.map(({ wordHit, ...a }) => ({ ...a, relevant: wordHit ?? (a.score != null && a.score >= floor) }));
}

/** What a caller sees: the ranking minus the centroids. Quorum alone has 29
 *  domains, so an app reports how many, and which one matched. */
export const brief = ({ domains, ...a }) => ({ ...a, domains: domains.length });

// ── self-check: `node src/discover/explore.js` ──────────────────────────────────
if (typeof process !== "undefined" && import.meta.url === `file://${process.argv[1]}` && process.argv[1].endsWith("/explore.js")) {
    const j = (x) => JSON.stringify(x, (_, v) => (typeof v === "bigint" ? `${v}n` : v));
    const eq = (a, b, m) => { if (j(a) !== j(b)) throw new Error(`${m}: ${j(a)} != ${j(b)}`); };
    const O = "0x00000000000000000000000000000000000000aa", P = "0x00000000000000000000000000000000000000bb";
    const reg = [
        { agentId: 1n, owner: O, block: 10n }, { agentId: 2n, owner: P, block: 11n },
        { agentId: 3n, owner: O, block: 20n }, { agentId: 4n, owner: O, block: 99n },
    ];
    eq(pairAgent(reg, O, 21n), 3n, "owner's latest agent at or before the binding");
    eq(pairAgent(reg, P.toUpperCase().replace("0X", "0x"), 50n), 2n, "owner compared case-insensitively");
    eq(pairAgent(reg, O, 5n), null, "no agent before the binding");

    const A = "0x" + "a".repeat(64);
    const card = (params) => ({ capabilities: { extensions: [{ uri: APP_EXTENSION, params }] } });
    const good = { appId: A, chainId: CHAIN.chainId, appRegistry: CHAIN.appRegistry.toUpperCase().replace("0X", "0x"), fromBlock: "7" };
    eq(verifyCard(card(good), A), null, "a good card verifies");
    eq(verifyCard(card({ ...good, appId: "0x" + "b".repeat(64) }), A), "card names another app", "wrong app");
    eq(verifyCard(card({ ...good, chainId: 1 }), A), "card is for another registry", "wrong chain");
    eq(verifyCard({}, A), "no fangorn app extension", "no extension");

    const cov = (v) => ({ vectors: [v] });
    const apps = [
        { name: "Tunes", description: "music tracks", domains: [{ name: "tracks", coverage: cov([1, 0, 0]) }] },
        { name: "Sky", description: "weather alerts", domains: [{ name: "alerts", coverage: cov([0, 1, 0]) }, { name: "old", coverage: null }] },
        { name: "Law", description: "meetings", domains: [{ name: "minutes", coverage: cov([0, 0, 1]) }] },
        { name: "Empty", description: "", domains: [] },
    ];
    const r = rankApps(apps, "rain", { qv: [0.1, 1, 0] });
    eq(r.map((a) => a.name), ["Sky", "Tunes", "Law", "Empty"], "ranked by best domain affinity, unscored last");
    eq([r[0].relevant, r[0].matched, r[3].relevant], [true, "alerts", false], "top is relevant, unscored is not");
    const blind = rankApps([{ ...apps[1], domains: [] }, apps[0], apps[2]], "weather alerts", { qv: [0.1, 1, 0] });
    eq(blind.map((a) => [a.name, a.relevant, a.ranked_by]).at(-1), ["Sky", true, "words"], "an app with no coverage still matches on its own words");
    eq(rankApps([{ ...apps[1], description: "all about the sky", domains: [] }], "where can I learn about music", { qv: [1, 0, 0] })[0].relevant, false, "filler words never match");
    eq(rankApps(apps, "stock prices", { qv: [-1, -1, -1] }).filter((a) => a.relevant).length, 0, "a question no app covers matches none");
    eq(rankApps(apps, "music").map((a) => [a.name, a.relevant]).slice(0, 2), [["Tunes", true], ["Sky", false]], "word fallback");
    eq(rankApps(apps, "").map((a) => a.score), [null, null, null, null], "no query: listed, not ranked");
    eq([https("javascript:alert(1)"), https("http://x.test"), https("https://x.test/a")], [null, null, "https://x.test/a"], "only https links reach a reader");
    eq(brief({ name: "x", domains: [{ name: "d", coverage: 1 }] }), { name: "x", domains: 1 }, "brief drops centroids");
    console.log("explore.js self-check ok — cards verified, agents paired by owner and block, apps ranked by coverage or words");
}
