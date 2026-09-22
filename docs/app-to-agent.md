# From app to agent: registering and discovering a runtime-free backend

This walks one static site from nothing to "any agent can find it and use it":

1. The site exposes WebMCP tools and an A2A agent card.
2. You claim a Fangorn app and point it at that card.
3. You register the card as an ERC-8004 agent, which makes it publicly searchable.
4. Someone who has never heard of it discovers it, verifies it, and drives it.

It runs on Arbitrum Sepolia. Every command and snippet here was run against the live
chain; [Kingsfoil](#reference-kingsfoil) is the worked example, and its real values are
at the end.

```
 ERC-8004 identity registry ──(A2A endpoint)──┐
   (searchable on 8004scan)                   ▼
                                  https://your.site/.well-known/agent-card.json
 Fangorn AppRegistry ──(agent_uri)────────────▲   │
   AppAgentChanged log = the app directory        │ card names appId, fromBlock,
                                                  │ namespaces, views, WebMCP tools
                                                  ▼
                               https://your.site  ← a browser (or headless Chrome)
                               document.modelContext tools, static shards, no server
```

## What you need

- Node 22, and the SDK/CLI: `npm i -g @fangorn-network/sdk@2026.9.22-dev` (gives `fangorn`)
- A wallet on Arbitrum Sepolia with a little ETH. **It owns the app forever**; use the
  wallet that will publish the data.
- A Pinata JWT. ERC-8004 registration pins a registration file to IPFS.
- A static host that serves `/.well-known/` and custom headers (Cloudflare Pages does both).
- `@fangorn/westmarch` for the card generator and the discovery helpers.

Configure the CLI once:

```sh
fangorn init          # writes ~/.fangorn/config.json: key, Pinata JWT, gateway
fangorn wallet        # confirm which address will sign
```

> The config file wins over `ETH_PRIVATE_KEY` in the environment. If `fangorn wallet`
> shows the wrong address, that's why.

## 1. Expose tools with WebMCP

The site's agent surface is a function that registers tools on `document.modelContext`.
Guard it, since most browsers don't have WebMCP yet:

```js
// app/agent.js
import { search, getRow } from "@fangorn/westmarch/tools";

const ok = (o) => ({ content: [{ type: "text", text: JSON.stringify(o) }] });

export function registerAgent(ctx) {
    const mc = document.modelContext;
    if (!mc?.registerTool) return 0;
    mc.registerTool({
        name: "search-rows",
        description: "Search the corpus by meaning. Call this first.",
        inputSchema: { type: "object", properties: { query: { type: "string" } } },
        execute: async ({ query }) => ok(search(ctx.rows(), query, ctx.roles(), { qv: await ctx.queryVector(query) })),
    });
    // …more tools
}
```

`@fangorn/westmarch/tools` holds verbs that work on any corpus (describe, search, browse,
facet, get, neighbours). Add a domain verb only when the generic ones can't express it.

## 2. Generate the agent card

A WebMCP tool only exists inside a loaded tab, so the card is the only machine-readable
record that the tools exist. Don't write the tool list by hand. `captureTools` runs your
register function against a recording stub, so the card lists exactly what the browser
registers. No `execute` runs during capture.

```js
// pipeline/agent-card.mjs — run at build time, after the site is built
import { writeFileSync, mkdirSync } from "node:fs";
import { agentCard, captureTools } from "@fangorn/westmarch/agent-card";
import { registerAgent } from "../app/agent.js";

const tools = await captureTools(() => registerAgent({}));
const card = agentCard({
    name: "My App",
    description: "What a stranger gets from this, in two sentences.",
    url: "https://my-app.pages.dev",          // the page the tools live on
    version: "2026-09-22",
    tools,
    tags: ["my-app"],
    fangorn: {
        app: "my-app",                          // the name you will claim in step 4
        fromBlock: 311671082,                   // see below
        namespaces: ["my-app"],                 // where your data is published
        views: ["https://my-app.pages.dev/v1"], // baked quickbeam views, if any
    },
});

mkdirSync("site/.well-known", { recursive: true });
writeFileSync("site/.well-known/agent-card.json", JSON.stringify(card, null, 1));
// Discovery runs in other sites' tabs: without CORS the browser won't hand over the card.
writeFileSync("site/_headers", "/.well-known/agent-card.json\n  Access-Control-Allow-Origin: *\n");
```

The `fangorn` block becomes an A2A extension (`https://fangorn.network/a2a/app/v1`) holding
the chain, the registry addresses (taken from the SDK, so they can't drift), your appId,
`fromBlock`, `namespaces` and `views`. `agentCard` validates these fields the same way
readers will, so a bad card fails your build, not someone else's discovery.

**`fromBlock`** is where readers start scanning for your data. Set it to the current block
**before** you claim the app:

```sh
node -e 'const {createPublicClient,http}=require("viem");const {arbitrumSepolia}=require("viem/chains");
createPublicClient({chain:arbitrumSepolia,transport:http()}).getBlockNumber().then(String).then(console.log)'
```

Too early is only slow: readers query logs 1000 blocks per call. Leave it at 0 and a reader
makes hundreds of thousands of calls.

**Hard-code these values once the app is claimed.** A rebuild that drops the extension
publishes a card that every reader rejects.

## 3. Deploy and check the card

```sh
npx wrangler pages deploy site --project-name my-app
curl -sD - https://my-app.pages.dev/.well-known/agent-card.json -o /dev/null | grep -iE "^HTTP|content-type|access-control"
# HTTP/2 200 · content-type: application/json · access-control-allow-origin: *
```

The card has to be live before step 5, because the CLI fetches it.

## 4. Claim the app

```sh
fangorn --app my-app app info     # "unclaimed", and the wallet you expect
fangorn --app my-app app claim    # first come, first served; permanent
```

With no flags, `claim` uses placeholder terms. Publish real ones later with
`fangorn app terms <hash> <uri>`; anyone who joined under the old terms has to accept again.
`--fee <wei>` sets a join fee.

## 5. Register the agent and bind the card

```sh
fangorn --app my-app app agent https://my-app.pages.dev/.well-known/agent-card.json
# Agent ID:  421614:226
# Card:      https://my-app.pages.dev/.well-known/agent-card.json
# Tx:        0x…
```

This command does two things:

1. **ERC-8004.** It builds a registration file from the card (name, description, A2A
   endpoint = the card URL, trust = reputation, x402 only if a skill is tagged `x402`),
   pins it to Pinata, and mints an agent in the identity registry at
   `0x8004A818BFB912233c491871b3d84c89A494BD9e`. That's the same address as on Ethereum
   and Base Sepolia. [8004scan](https://8004scan.io) indexes it within minutes.
2. **Fangorn.** It calls `setAppAgentUri(cardUrl)`, which emits `AppAgentChanged`. That log
   is the app directory: westmarch's `listApps` reads it.

`--skip-register` does only the second step, e.g. to move a card that's already registered
to a new URL.

## 6. Publish data into the app

The owner is the app's first publisher, but still needs global standing:

```sh
fangorn --app my-app register
fangorn --app my-app repo init my-app
fangorn --app my-app commit graph.json -m "first bake" --replace
fangorn --app my-app push
```

`graph.json` is `{ vertices: [{id, tag, payload}], edges?: [{rel, from, to}] }`.
`westmarch/publish/graph.js` builds one from a file tree.

## 7. Discover it

Every route below ends in `discoverApp(cardUrl)`, which accepts a card only if:

- the card carries the Fangorn extension for **this** chain and **this** AppRegistry, and
- `appAgentUri(card.appId)` on chain is **exactly** the card URL.

The registry and the index are where you look. The on-chain binding is what you trust.

`example/discover.mjs` runs all three routes:

```sh
node example/discover.mjs card   https://kingsfoil.pages.dev/.well-known/agent-card.json
node example/discover.mjs chain  311637349          # every app bound since this block
node example/discover.mjs search Kingsfoil          # the public ERC-8004 index
```

```
Kingsfoil  https://kingsfoil.pages.dev/.well-known/agent-card.json
  app 0x3069…c8ca  data from block 311671082  namespaces kingsfoil
  open https://kingsfoil.pages.dev — WebMCP tools: list-areas, search-trials, get-trial, …
```

**From a card URL** (someone handed it to you):

```js
import { Fangorn, FangornConfig } from "@fangorn-network/sdk";
import { generatePrivateKey } from "viem/accounts";
// Fangorn.create needs a signer; a throwaway key is fine for reading.
const fangorn = Fangorn.create({ privateKey: generatePrivateKey(), config: FangornConfig });
const { card, appId, fromBlock, namespaces } = await fangorn.discoverApp(cardUrl);
```

**From the chain** (every Fangorn app; no index, no server):

```js
import { listApps } from "@fangorn/westmarch/apps";
const { apps, rejected } = await listApps(fangorn, { fromBlock: 311637349n });
// apps: [{ name, appId, card, url, views, namespaces, fromBlock }]
// rejected: [{ card, why }]: unreachable or not bound, reported rather than dropped
```

`sourcesFromChain` in `@fangorn/westmarch/directory` turns that into `findCorpora` sources,
so an agent can rank every app's corpora against a question without downloading a shard.
In the example page, `?fromBlock=311637349` does the same thing in a browser.

**From ERC-8004** (general-purpose agents that know nothing about Fangorn):

```js
const api = "https://8004scan.io/api/v1/agents";
const { items } = await (await fetch(`${api}?chain_id=421614&search=Kingsfoil`)).json();
const detail = await (await fetch(`${api}/421614/${items[0].token_id}`)).json();
const found = await fangorn.discoverApp(detail.services.a2a.endpoint);
```

Without the index, read it straight from the registry: `tokenURI(agentId)` returns the
registration file's `ipfs://` URI, and its `A2A` endpoint is the card.

### Use it

- **An agent:** open `card.url` in Chrome 150+ with `--enable-features=WebMCP` (headless
  works) and call the tools the card lists as `webmcp` skills. Queries run in that tab, and
  nothing reaches a server.
- **Without a browser:** the views are plain HTTP (`<view>/cdn/catalog`, then the shards it
  names). Point `westmarch/consume/shard.js` at `views[i]`.
- **The committed data itself:**

```js
fangorn.setAppId(appId);
const timelines = await fangorn.appNamespaces({ namespace: namespaces[0], fromBlock });
const { contents } = await fangorn.readNamespace(timelines[0].owner, namespaces[0]);
```

## What the binding proves, and what it doesn't

- **Proves:** whoever owns the app on chain chose this card URL. Anyone can serve a card
  claiming any appId, and `discoverApp` rejects it unless the app points back at that exact
  URL. This is tested (`src/discover-app.test.ts`, `src/app-agent.e2e.test.ts`).
- **Doesn't prove:** that the page behind `card.url` behaves as described, or that the card
  wasn't changed after binding. The card is live HTTP, not content-addressed, and the
  binding is to the URL. That's deliberate: the card is mostly endpoints, which change, and
  pinning each version would cost a transaction for nothing. The data's integrity comes
  from the commits, not from the card.

## Gotchas

| symptom | cause |
|---|---|
| `not bound to app … on-chain agent_uri is …` | URLs must match exactly. A trailing slash, `http` vs `https`, or a different path counts as a different card. |
| card rejected after a rebuild | the build dropped the `fangorn` block or changed `fromBlock`/`url`; hard-code them |
| discovery works in Node, fails in a browser | no `Access-Control-Allow-Origin` on the card |
| `listApps` takes forever | `fromBlock` is too early; the scan is 1000 blocks per RPC call |
| a log scan misses a transaction you just sent | fixed in the SDK (uncached head block); upgrade to ≥ 2026.9.22-dev |
| IPFS reads return "switching to a service worker gateway" | ipfs.io stopped serving raw content; use a Pinata gateway |
| `app agent` signs as the wrong wallet | `~/.fangorn/config.json` beats `ETH_PRIVATE_KEY` |
| the page isn't listed as a "Web" service on 8004scan | agent0-sdk has no web endpoint type; agents find the page through the card's `url` |

## Reference: Kingsfoil

| | |
|---|---|
| site | https://kingsfoil.pages.dev |
| card | https://kingsfoil.pages.dev/.well-known/agent-card.json |
| app | `kingsfoil` = `0x3069aaab9c73b01fb147a97106c7e595534850af5cab0e0ff7f2a55554d5c8ca` |
| owner | `0x7a7849231cF7Ab1EA003BcF0063CB89704D7Cce9` |
| fromBlock | 311671082 |
| claim tx | `0x881a88e4775c6360f799503b098f00ef470806278f7b282045d6cc881df3cf72` |
| ERC-8004 | agent `421614:226`, registration `ipfs://bafkreigmy2ubgzrsp55fnf77fykabapuv4y42nk6peq4ko3oi3w2x7u7ay` |
| bind tx | `0xc7d8726d31bb9698ba2bfae3bc107a6111062d4b7e26526301a984638ab94c9f` |
| card script | `kingsfoil/pipeline/agent-card.mjs` |

Deployment (Arbitrum Sepolia, 421614): AppRegistry `0x11d228c4774af3d9cae3b4b6874a12576a1a83ec`,
DataRegistry `0x775026e905d7b58b34d16bcbd385fa630ee36c26`, earliest AppRegistry event at block
311637349.
