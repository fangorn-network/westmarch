#!/usr/bin/env node
// Find a Fangorn app three ways, and verify it each time.
//
//   node example/discover.mjs card   <cardUrl>          you were handed the card
//   node example/discover.mjs chain  <fromBlock>        every app bound on chain
//   node example/discover.mjs search <name>             the public ERC-8004 index
//
// All three end in `discoverApp`, which checks that the card names an app AND
// that the app's on-chain agent_uri names the card. The registry and the index
// are where you LOOK; the binding is what you TRUST.
import { Fangorn, FangornConfig } from "@fangorn-network/sdk";
import { generatePrivateKey } from "viem/accounts";
import { listApps } from "@fangorn/westmarch/apps";

const [mode, arg] = process.argv.slice(2);
// ponytail: throwaway key. Everything here only reads.
const fangorn = Fangorn.create({ privateKey: generatePrivateKey(), config: FangornConfig });

const show = ({ card, appId, fromBlock, namespaces }, cardUrl) => {
    const tools = card.skills?.filter((s) => s.tags?.includes("webmcp")).map((s) => s.id) ?? [];
    console.log(`${card.name}  ${cardUrl}`);
    console.log(`  app ${appId}  data from block ${fromBlock}  namespaces ${namespaces.join(", ") || "-"}`);
    console.log(`  open ${card.url} — WebMCP tools: ${tools.join(", ") || "none"}`);
};

if (mode === "card" && arg) {
    show(await fangorn.discoverApp(arg), arg);
} else if (mode === "chain" && arg) {
    const { apps, rejected } = await listApps(fangorn, { fromBlock: BigInt(arg) });
    for (const a of apps) console.log(`${a.name}  ${a.card}  ${a.views.length} views`);
    for (const r of rejected) console.log(`✗ ${r.card} — ${r.why}`);
} else if (mode === "search" && arg) {
    // 8004scan indexes the canonical ERC-8004 registry on Arbitrum Sepolia.
    const api = "https://8004scan.io/api/v1/agents";
    const q = await (await fetch(`${api}?chain_id=${FangornConfig.caip2}&search=${encodeURIComponent(arg)}&limit=10`)).json();
    for (const hit of q.items ?? []) {
        const detail = await (await fetch(`${api}/${hit.chain_id}/${hit.token_id}`)).json();
        const cardUrl = detail.services?.a2a?.endpoint;
        if (!cardUrl) { console.log(`- ${hit.name} (#${hit.token_id}): no A2A card`); continue; }
        try { show(await fangorn.discoverApp(cardUrl), cardUrl); }
        catch (e) { console.log(`- ${hit.name} (#${hit.token_id}): an agent, not a Fangorn app — ${e.message}`); }
    }
} else {
    console.error("usage: discover.mjs card <cardUrl> | chain <fromBlock> | search <name>");
    process.exit(1);
}
