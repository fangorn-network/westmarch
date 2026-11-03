// The Fangorn explorer: every verified app, what it is about, and what the
// ERC-8004 registries say about it — read live, with no bake of its own.
//
// Everything here is already published by someone else:
//   the update log + each repo's @card   which apps exist and where their cards are (apps.js)
//   each card                            name, tools, views; checked by discoverCard
//   each view's catalog                  rows, domains, and coverage centroids (what it is about)
//   ERC-8004 identity `Registered`       the agent minted for the app
//   ERC-8004 reputation                  feedback count and average per agent
//
// `fangorn` is an SDK client and `client` a viem PublicClient: passed in, so the self-check
// needs no chain. Pass `store` and only what changed since the last read is read again.

import { parseAbi, parseAbiItem } from "viem";
// The config module alone (viem only), not the SDK's root: this runs in a tab too.
import { BaseSepoliaConfig } from "@fangorn-network/sdk/lib/config.js";
import { cachedLogs, listApps } from "./apps.js";
import { survey, comparable } from "./directory.js";
import { rankDomains, zFloor, lexScore } from "../core/rank.js";

// The ERC-8004 registries per chain id (agent0-sdk's defaults), where `fangorn card` registers.
const ERC8004 = {
    84532: { identity: "0x8004A818BFB912233c491871b3d84c89A494BD9e", reputation: "0x8004B663056A597Dffe9eCcC1965A193B7388713",
             scan: "base-sepolia" },
};

/** What explore reads on one of the SDK's networks (`SupportedNetworks.baseSepolia`, …). */
export function chainOf(net = BaseSepoliaConfig) {
    const e = ERC8004[net.caip2];
    if (!e) throw new Error(`explore: no ERC-8004 registries known for chain ${net.caip2}`);
    return {
        chainId: net.caip2, identity: e.identity, reputation: e.reputation,
        // ponytail: identity read from the DataRegistry's deployment, since an app's agent is
        // registered after its repo exists. An agent minted earlier is missed; scan earlier if that happens.
        identityFrom: e.identityFrom ?? net.fromBlock,
        window: e.window ?? net.logWindow ?? 1000n,
        scan: (agentId) => `https://8004scan.io/agents/${e.scan}/${agentId}`,
    };
}

export const CHAIN = chainOf();

const REGISTERED = parseAbiItem("event Registered(uint256 indexed agentId, string agentURI, address indexed owner)");
const REP = parseAbi([
    "function getClients(uint256) view returns (address[])",
    "function getSummary(uint256, address[], string, string) view returns (uint64, int128, uint8)",
]);

/** A link someone else wrote, shown to a reader: https or nothing. */
const https = (u) => { try { const x = new URL(String(u)); return x.protocol === "https:" ? x.href : null; } catch { return null; } };
const slug = (name) => String(name).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "app";

/**
 * The agent an app registered: its publisher's latest `Registered` at or before `block`.
 *
 * ponytail: paired by owner, not by reading the registration file (IPFS gateways are too
 * slow and flaky for a page load). A publisher with two apps gets its latest agent for both;
 * fetch tokenURI and match the card if that starts happening.
 */
export function pairAgent(registered, owner, block) {
    let best = null;
    for (const r of registered) {
        if (r.owner.toLowerCase() !== owner.toLowerCase() || r.block > block) continue;
        if (!best || r.block > best.block || (r.block === best.block && r.agentId > best.agentId)) best = r;
    }
    return best?.agentId ?? null;
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

// `window`: the most blocks one getLogs may span on the client's RPC (chainOf says, per chain).
async function getLogsSince(client, start, filter, window, store) {
    const head = await client.getBlockNumber();
    const read = async (start, head) => {
        const windows = [];
        for (let from = start; from <= head; from += window) {
            const to = from + window - 1n < head ? from + window - 1n : head;
            windows.push(client.getLogs({ ...filter, fromBlock: from, toBlock: to }));
        }
        return (await Promise.all(windows)).flat().map(({ args, blockNumber }) => ({ args, blockNumber }));
    };
    return store ? cachedLogs(store, `${filter.address}:${filter.event.name}:${start}`, start, head, read) : read(start, head);
}

/**
 * Every verified app, with its 8004 agent, reputation, and catalog. Apps whose cards don't
 * verify are dropped; `dropped` says why. `onUpdate({ apps, pending })` is called as each
 * app lands, so a page can show them as they arrive.
 */
export async function readDirectory(fangorn, client, { chain = CHAIN, onUpdate = () => {}, store } = {}) {
    const [{ apps: verified, rejected }, regLogs, head] = await Promise.all([
        listApps(fangorn, { store }),
        getLogsSince(client, chain.identityFrom ?? 0n, { address: chain.identity, event: REGISTERED }, chain.window ?? 1000n, store),
        client.getBlockNumber(),
    ]);
    const registered = regLogs.map((l) => ({ agentId: l.args.agentId, owner: l.args.owner, block: l.blockNumber }));
    const dropped = rejected.map((r) => ({ card: r.card, why: r.why }));

    // One pipeline per app, so the quick ones need not wait on a big catalog.
    const apps = [];
    let pending = verified.length;
    const settle = () => { pending--; apps.sort((a, b) => a.name.localeCompare(b.name)); onUpdate({ apps: [...apps], pending }); };
    onUpdate({ apps: [], pending });
    await Promise.all(verified.map(async (a) => {
        const agentId = pairAgent(registered, a.publisher, head);
        const [rep, { corpora, unreachable }] = await Promise.all([
            agentId == null ? null : reputation(client, agentId, chain),
            survey(a.views.filter((v) => /^https:\/\//.test(v))),
        ]);
        apps.push({
            app: slug(a.name), name: a.name, description: a.desc,
            site: https(a.url), card: a.card, id: a.id, owner: a.publisher, repo: a.repo,
            fromBlock: a.fromBlock == null ? null : Number(a.fromBlock),
            tools: a.tools,
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

    const fangorn = {
        repos: async () => [{ owner: O, repo: "tunes", root: "0x1" }],
        cardOf: async () => "https://t.test/card",
        discoverCard: async (url) => ({ card: { name: "Tunes", description: "music", url: "https://t.test/", capabilities: { extensions: [
            { uri: "https://fangorn.network/a2a/repo/v1", params: { publisher: O, repo: "tunes", fromBlock: "7", views: [] } }] } }, publisher: O, repo: "tunes" }),
    };
    const client = { getBlockNumber: async () => 30n, getLogs: async () => [{ args: { agentId: 3n, owner: O }, blockNumber: 20n }],
                     readContract: async () => [] };
    const dir = await readDirectory(fangorn, client, { chain: { ...CHAIN, identityFrom: 0n, window: 100n } });
    eq(dir.apps.map((a) => [a.name, a.owner, a.repo, a.agent?.id, a.fromBlock]), [["Tunes", O, "tunes", 3, 7]], "an app is a carded repo, paired with its publisher's agent");

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
    console.log("explore.js self-check ok — apps from carded repos, agents paired by owner, apps ranked by coverage or words");
}
