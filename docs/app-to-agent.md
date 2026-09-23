# From nothing to a running Fangorn app

This walks an app owner from an empty directory to a live app that people can use in a
browser and any agent can find, verify and query. By the end you have:

- **an app** claimed on Fangorn, owned by your wallet;
- **your data** committed on chain under your namespace;
- **a static site** with no server: the data as searchable views, and a page for people;
- **an agent card** bound to the app on chain, and registered as an ERC-8004 agent;
- **agents using it:** anyone running `fangorn-mcp` can `open-app` it by name.

Where the data comes from is up to you. The guide starts from a JSON array of objects,
which anything can produce: a scraper, a database export, a converted spreadsheet.

```
 your data ──► data/rows.json ──► pipeline/bake.mjs ─┬─► data/graph.json ──► fangorn commit/push ──► chain
                                                     └─► site/v1/  (the view: catalog, manifest, shard)
 app/ (page + WebMCP tools) ──► vite build ──► site/
 pipeline/agent-card.mjs ──► site/.well-known/agent-card.json ──► deploy ──► fangorn app agent
                                                                              │
 ERC-8004 identity registry ◄── registration file (card URL) ◄────────────────┤
 Fangorn AppRegistry ◄── agent_uri = card URL ◄───────────────────────────────┘
        ▲
        └── fangorn-mcp: open-app my-app → reads the binding, verifies the card, searches site/v1
```

It runs on Arbitrum Sepolia. **What was run:**

- Steps 4, 5 and 7–8 (bake, lint, page, card) and the data tools were run end to end on
  this guide's example on 2026-09-23. That covered: bake and lint, the page's tools in
  headless Chrome, and search by meaning through the data tools.
- The chain steps (1–3, 10) were run for Kingsfoil, the reference app at the end.
- Step 6 (`repo init`/`commit`/`push`) is checked against the CLI source, but has not been
  run for an app yet.

## What you need

- Node 22.
- The Fangorn CLI: `npm i -g @fangorn-network/sdk@2026.9.22-dev` (gives `fangorn`).
- A wallet on Arbitrum Sepolia with a little ETH. **It owns the app forever**, so use the
  wallet that will publish the data.
- A Pinata JWT. Registering the ERC-8004 agent (step 10) pins a file to IPFS.
- A static host that serves `/.well-known/` and custom headers. Cloudflare Pages does
  both, and is what the commands below use.

Start the project:

```sh
mkdir my-app && cd my-app && npm init -y && npm pkg set type=module
npm i @fangorn-network/westmarch @huggingface/transformers vite
mkdir -p data pipeline app
```

The Fangorn SDK and viem come with westmarch as peer dependencies. A cold install took
about 4 minutes with bun; most of it is transformers, the embedding library.

## 1. Set up the CLI

```sh
fangorn init              # writes ~/.fangorn/config.json: key, Pinata JWT, gateway
fangorn wallet            # confirm which address will sign
fangorn set-app my-app    # the app every later command uses; --app <name> overrides it once
```

> The config file wins over `ETH_PRIVATE_KEY` in the environment. If `fangorn wallet`
> shows the wrong address, that's why.

## 2. Claim the app

First, note the current block. It becomes the card's `fromBlock` (step 8), which is where
readers start scanning the chain for your app:

```sh
node -e 'const {createPublicClient,http}=require("viem");const {arbitrumSepolia}=require("viem/chains");
createPublicClient({chain:arbitrumSepolia,transport:http()}).getBlockNumber().then(String).then(console.log)'
```

Then claim the name:

```sh
fangorn app info     # "unclaimed", and the wallet you expect
fangorn app claim    # first come, first served; permanent
```

With no flags, `claim` uses placeholder terms. Publish real ones later with
`fangorn app terms <hash> <uri>`; anyone who joined under the old terms has to accept again.
`--fee <wei>` sets what joining costs other publishers.

## 3. Become a publisher in it

Owning the app makes you its first publisher. You still need global standing:

```sh
fangorn register     # DataRegistry.register(), then joins this app
fangorn app info     # DataRegistry: registered · This app: joined
```

Without the join, every push reverts with `NotRegisteredForApp`.

## 4. Your data, as rows

`data/rows.json` is an array of flat objects:

```json
[
 { "id": "oak", "name": "Oak", "species": "Quercus robur", "family": "Fagaceae", "region": "Europe",
   "description": "Long-lived deciduous tree with lobed leaves and acorns; hard durable timber …" },
 { "id": "baobab", "name": "Baobab", "species": "Adansonia digitata", "family": "Malvaceae", "region": "Africa",
   "description": "Massive trunk stores water through the dry season; fruit pulp is rich in vitamin C." }
]
```

What makes rows work well:

- **A stable id.** The same thing keeps the same id across re-publishes.
- **Text that says what the row is, in words.** This is what gets embedded, so it's what
  "search by meaning" matches. A title alone is weak; a sentence or a paragraph is good.
- **Fields worth filtering or counting on**, such as a category, a region, or a date. Agents
  use these with `where` and `count`.

## 5. Bake: the commit and the view

One script turns the rows into both outputs: the graph you commit (step 6) and the view
readers load.

```js
// pipeline/bake.mjs — data/rows.json → data/graph.json (the commit) + site/v1 (the view)
import { readFileSync, writeFileSync } from "node:fs";
import { bakeView } from "@fangorn-network/westmarch/view";

const rows = JSON.parse(readFileSync("data/rows.json", "utf8"));

// The commit: every row as a vertex. `tag` is a free-form schema id.
writeFileSync("data/graph.json", JSON.stringify({
    vertices: rows.map((r) => ({ id: r.id, tag: "my-app.tree.v1", payload: r })),
}));

// The view: which field is what, then embed and write the files readers load.
await bakeView(rows, {
    out: "site/v1",
    name: "trees",
    description: "Tree species: what they are, where they grow, and what they are good for.",
    type: "Tree",
    presentation: { externalUrl: { Tree: "https://en.wikipedia.org/wiki/{species}" } },
    roleMap: { identity: "id", title: "name", subtitle: "species", tags: ["family", "region"], text: ["description"] },
    owner: process.env.OWNER,   // your wallet, stamped on each row
    onProgress: (n, of) => n % 100 === 0 || n === of ? console.log(`embedded ${n}/${of}`) : null,
});
```

```sh
OWNER=$(fangorn wallet | awk '/^Address/ {print $2}') node pipeline/bake.mjs
```

**`roleMap`** tells every reader which field is what, so no app code has to know your
schema:

| role | means | used for |
|---|---|---|
| `identity` | the id field (required) | `get`, links, updates |
| `text` | the field(s) to embed (required) | search by meaning |
| `title`, `subtitle` | what a hit is called | result lists |
| `tags` | categories | filters, `count` |
| `temporal`, `spatial`, `measures`, `relations`, `media` | dates, places, numbers, links to other rows, playable media | sorting, facets, previews |

**The view** is three kinds of static file:

```
site/v1/cdn/catalog                               what the view holds, plus a coverage sketch
site/v1/cdn/domains/trees/manifest                role_map, model, and the shard's sha256
site/v1/cdn/domains/trees/shards/shard-0000-<sha>.ndjson.gz   the rows, with vectors
```

- Readers check the shard against the manifest's sha256, so any host or CDN can serve it.
- The **coverage sketch** is 32 centroids of the view's vectors. It lets an agent choose
  which of an app's views to read for a question without downloading any of them.
- The shard is named by its digest. A re-bake writes a new name and removes the old file.
- One view is fine up to roughly 100k rows. Past that, bake several (`site/v1`,
  `site/v2`, split by topic), which also makes that choosing step worth more.

The first bake downloads the embedding model (131 MB) once. After that, the example's 20
rows baked in about 2 seconds.

Check the view the way a reader will see it:

```sh
(cd site && python3 -m http.server 8765 &)
node node_modules/@fangorn-network/westmarch/consume/lint.js http://127.0.0.1:8765/v1
# trees — 20 rows — nothing to fix
```

`lint.js` reports three levels:
- **blocking:** readers can't find you (no coverage, wrong model);
- **findable, but not readable** (no text role);
- **readable, but a dead end** (nowhere for a hit to link to).

## 6. Commit and push

```sh
fangorn repo init my-app                                  # the namespace; tracked in .fangorn/repo.json
fangorn commit data/graph.json -m "first bake" --replace  # local; builds and uploads the commit
fangorn push                                              # the on-chain transaction
```

`--replace` makes the file the namespace's whole state, so rows you removed are removed.
Without it, the commit adds to what's already there. `fangorn status` compares your local
tip with the one on chain.

The commit is the record; the view is how people and agents read it. They come from the
same rows in the same script, so they don't drift.

## 7. The page

A page for people, with the same search exposed to agents in the browser as WebMCP tools.

```js
// app/agent.js — the page's tools for agents in a browser. `ctx` holds the loaded rows.
import { search, getRow } from "@fangorn-network/westmarch/tools";

const ok = (o) => ({ content: [{ type: "text", text: JSON.stringify(o) }] });

export function registerAgent(ctx) {
    const mc = document.modelContext;
    if (!mc?.registerTool) return;   // most browsers have no WebMCP yet
    mc.registerTool({
        name: "search-trees",
        description: "Search tree species by meaning: a question in plain words. Call this first.",
        inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } }, required: ["query"] },
        execute: async ({ query, limit = 10 }) =>
            ok(search(ctx.rows, query, ctx.roles, { qv: await ctx.queryVector(query), limit })),
    });
    mc.registerTool({
        name: "get-tree",
        description: "One tree species in full, by the id search returns.",
        inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        execute: async ({ id }) => ok(getRow(ctx.rows, id, ctx.roles) ?? { error: `no tree ${id}` }),
    });
}
```

```js
// app/main.js
import { configure, loadShard } from "@fangorn-network/westmarch/shard";
import { rolesFrom, textOf } from "@fangorn-network/westmarch/roles";
import { search } from "@fangorn-network/westmarch/tools";
import { embedQuery } from "@fangorn-network/westmarch/embed";
import { registerAgent } from "./agent.js";

const ctx = { rows: [], roles: rolesFrom([]), queryVector: (q) => embedQuery(q).catch(() => null) };
configure({ onManifests: (ms) => { ctx.roles = rolesFrom(ms); }, rowText: (f) => textOf(f, ctx.roles) });
ctx.rows = await loadShard(new URL("v1", location.href).href);   // checked against the manifest's sha256
registerAgent(ctx);   // only now: a tool called before its data loads answers wrong, silently

// The human side: the same search, as a list.
const input = document.querySelector("input"), list = document.querySelector("ul");
input.placeholder = `Search ${ctx.rows.length} trees…`;
input.oninput = async () => {
    const q = input.value;
    const hits = search(ctx.rows, q, ctx.roles, { qv: await ctx.queryVector(q), limit: 10 });
    if (q !== input.value) return;   // a newer keystroke won
    list.replaceChildren(...hits.map((h) => {
        const li = document.createElement("li"), a = document.createElement("a");
        a.textContent = h.title; if (h.url) a.href = h.url;
        li.append(a, ` — ${h.subtitle ?? ""}`);
        return li;
    }));
};
```

```html
<!-- app/index.html -->
<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>My App</title>
<h1>My App</h1>
<input type="search" autofocus placeholder="Loading…">
<ul></ul>
<script type="module" src="./main.js"></script>
```

```js
// app/vite.config.js
export default {
    base: "./",
    // westmarch's embedder finds its worker by `new URL(…, import.meta.url)`;
    // pre-bundling loses that and search silently drops to word matching.
    optimizeDeps: { exclude: ["@fangorn-network/westmarch"] },
    build: { outDir: "../site", emptyOutDir: false },   // keep site/v1
};
```

```sh
(cd app && npx vite build)
```

Search runs in the reader's own tab: the shard and the model are downloaded, and the query
never leaves the browser. `@fangorn-network/westmarch/tools` also has `describe`, `browse`,
`facet` and `neighbors`, if the page needs more than search.

## 8. The agent card

A WebMCP tool only exists inside a loaded tab, so the card is the only machine-readable
record that the app, its tools and its views exist. The tool list isn't written by hand:
`captureTools` runs your register function against a recording stub, so the card lists
exactly what the page registers. No `execute` runs.

```js
// pipeline/agent-card.mjs — site/ → site/.well-known/agent-card.json + site/_headers
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { agentCard, captureTools } from "@fangorn-network/westmarch/agent-card";
import { registerAgent } from "../app/agent.js";

const SITE = "https://my-app.pages.dev";
const VIEWS = ["v1"];   // every directory bakeView wrote

const card = agentCard({
    name: "My App",
    description: "Tree species: what they are, where they grow, and what they are good for. Search by meaning.",
    url: `${SITE}/`,                               // the page that registers the tools
    version: "1",
    tools: await captureTools(() => registerAgent({})),
    tags: ["trees"],
    fangorn: {
        app: "my-app",                             // the name you claimed
        fromBlock: 311700000,                      // the block you noted before claiming
        namespaces: ["my-app"],                    // what `fangorn repo init` created
        views: VIEWS.map((v) => `${SITE}/${v}`),
    },
});
mkdirSync("site/.well-known", { recursive: true });
writeFileSync("site/.well-known/agent-card.json", JSON.stringify(card, null, 1));

// The card is read from other origins, so it needs CORS. Shards and bundles are
// named by their digest, so they never change: tell caches so.
const immutable = "  Cache-Control: public, max-age=31536000, immutable\n";
writeFileSync("site/_headers",
    "/.well-known/agent-card.json\n  Access-Control-Allow-Origin: *\n"
    + `/assets/*\n${immutable}`
    + VIEWS.map((v) => readdirSync(`site/${v}/cdn/domains`).map((d) => `/${v}/cdn/domains/${d}/shards/*\n${immutable}`).join("")).join(""));
```

```sh
node pipeline/agent-card.mjs    # card: 2 tools → site/.well-known/agent-card.json
```

- **The `fangorn` block** becomes an A2A extension (`https://fangorn.network/a2a/app/v1`).
  It holds the chain, the registry addresses (taken from the SDK, so they can't drift), your
  appId, `fromBlock`, `namespaces` and `views`. `agentCard` validates them the same way
  readers will, so a bad card fails your build, not someone else's discovery.
- **`views` is what agents search:** `fangorn-mcp` reads them directly, with no browser.
- **`url` is the page that registers the tools,** not just any page on the site.
- **`fromBlock`** only affects speed: readers query logs 1000 blocks per call, so an early
  block is slow, and 0 means hundreds of thousands of calls.
- **Keep these values fixed.** A rebuild that drops the extension or changes `url`
  publishes a card every reader rejects.

## 9. Deploy and check

```sh
npx wrangler pages deploy site --project-name my-app
curl -sD - https://my-app.pages.dev/.well-known/agent-card.json -o /dev/null | grep -iE "^HTTP|access-control"
# HTTP/2 200 · access-control-allow-origin: *
curl -sI https://my-app.pages.dev/v1/cdn/domains/trees/shards/$(ls site/v1/cdn/domains/trees/shards) | grep -i cache-control
# cache-control: public, max-age=31536000, immutable
node node_modules/@fangorn-network/westmarch/consume/lint.js https://my-app.pages.dev/v1
```

Open `https://my-app.pages.dev/` and search: that's the app for people. The card must be
live before step 10, because the CLI fetches it.

## 10. Register the agent and bind the card

```sh
fangorn app agent https://my-app.pages.dev/.well-known/agent-card.json
# Agent ID:  421614:…
# Card:      https://my-app.pages.dev/.well-known/agent-card.json
# Tx:        0x…
```

This does two things:

1. **ERC-8004.** It builds a registration file from the card (name, description, A2A
   endpoint = the card URL, trust = reputation, x402 only if a skill is tagged `x402`),
   pins it to Pinata, and mints an agent in the identity registry at
   `0x8004A818BFB912233c491871b3d84c89A494BD9e`. That's the same address as on Ethereum
   and Base Sepolia. [8004scan](https://8004scan.io) indexes it within minutes.
2. **Fangorn.** It calls `setAppAgentUri(cardUrl)`, which emits `AppAgentChanged`. That log
   is the app directory: `list-apps` and `listApps` read it.

`--skip-register` does only the second step, e.g. to move an already-registered card to a
new URL.

## 11. Use it as an agent would

Register `fangorn-mcp` once (see [Using Fangorn apps from an agent](#using-fangorn-apps-from-an-agent)),
then in any agent:

```
open-app my-app               → verified: true, data_tools: true
my-app__describe              → the view "trees": 20 rows, its description
my-app__search "trees that survive fire"   → redwood, oak, …  (ranked by meaning)
my-app__get "baobab"          → the whole row
```

`open-app` reads your app's binding from the registry, fetches the card, and checks that
the binding points back at exactly that URL. Only then does it add the tools.

## 12. Update it

Data changes are the same loop, and need no new binding:

```sh
node pipeline/bake.mjs                                # new graph.json, new view (new shard name)
fangorn commit data/graph.json -m "…" --replace && fangorn push
(cd app && npx vite build) && node pipeline/agent-card.mjs
npx wrangler pages deploy site --project-name my-app
```

The card URL stays the same, so the on-chain binding stays valid. Run `fangorn app agent`
again only if the card moves.

---

## Using Fangorn apps from an agent

`fangorn-mcp` is one MCP server for every Fangorn app: a new app needs no new
registration. You can install it as a single file (Linux x64/arm64): no node, no install,
and search by meaning included.

```sh
curl -fLo fangorn-mcp https://github.com/fangorn-network/westmarch/releases/latest/download/fangorn-mcp-linux-x64
chmod +x fangorn-mcp
claude mcp add fangorn -- "$PWD/fangorn-mcp"
```

Or through npm, wherever node is:

```sh
claude mcp add fangorn -- npx -y -p @fangorn-network/westmarch -p @huggingface/transformers fangorn-mcp
```

Without `-p @huggingface/transformers`, the install is ~500 MB lighter and `search` ranks by
words, not meaning. For any MCP client:

```json
{ "mcpServers": { "fangorn": { "command": "/path/to/fangorn-mcp" } } }
```

`bun build-bin.js` in westmarch builds the file (bun ≥ 1.2).

It starts with three tools:
- **`list-apps`** reads the apps off the chain and keeps the ones whose cards verify.
- **`open-app <name>`** reads that app's binding from the registry (one call), verifies its
  card, and adds the app's tools as `<name>__<tool>`.
- **`call-app-tool`** reaches the same tools, for clients that don't refresh their tool list.

**Two kinds of tools.**
- **Data tools:** an app whose card names `views` gets these at once, with no browser:
  `describe`, `search`, `get`, `similar`, `count`, `browse`. westmarch runs them over the
  app's shards, checked against their manifests' sha256. `search` reads the 3 views whose
  coverage sketch best matches the query and names the next candidates.
- **Page tools:** `open-app` with `page: true` also opens `card.url` in a browser for the
  page's own WebMCP tools. An app with no views gets only these.

**How fast** (Kingsfoil: 23 views, 60,760 trials):

| | time |
|---|---|
| `open-app` | 0.4–2 s |
| `describe` | under 5 ms |
| first `search`, caches warm | 0.4–1.8 s |
| later searches | ~0.2–0.5 s |
| first `search` from an empty machine (single file) | ~3.5 s, by words while the model downloads |
| page tools (browser) | 5–15 s to open, ~2 GB of memory |

On a new machine, the embedding model (131 MB, kept in `~/.cache/fangorn-mcp/models`)
downloads in the background. Until it lands, `search` ranks by words and says so in
`ranked_by`; then it switches to meaning. Shards are downloaded once and kept by content
hash.

**Where the browser comes from (page tools only).** Anything that speaks the Chrome DevTools
Protocol and has WebMCP will do: a headless Chromium service, a hosted browser, or the local
Chrome.

| setting | browser |
|---|---|
| `FANGORN_MCP_CDP=http://host:9222` (or `--cdp`) | a running browser's DevTools address |
| `FANGORN_MCP_CDP=ws://host:9222/devtools/browser/…` | a browser WebSocket endpoint, which is what hosted services hand out |
| neither | the local Chrome 150+ (`CHROME=/path` if it isn't `google-chrome`), headless (`--headed` to watch) |

A remote browser is never closed; only the tabs the server opened are. A local Chrome is
shared by every session on the machine and closes when the last one exits. Its profile is
`~/.cache/westmarch-mcp/`. `--from-block <n>` points the server at another deployment.

## Discovering apps in code

Every route ends in `discoverApp(cardUrl)`, which accepts a card only if:

- the card carries the Fangorn extension for **this** chain and **this** AppRegistry, and
- `appAgentUri(card.appId)` on chain is **exactly** the card URL.

The registry and the index are where you look. The on-chain binding is what you trust.
`example/discover.mjs` runs all three routes:

```sh
node example/discover.mjs card   https://kingsfoil.pages.dev/.well-known/agent-card.json
node example/discover.mjs chain  311637349          # every app bound since this block
node example/discover.mjs search Kingsfoil          # the public ERC-8004 index
```

**From a card URL:**

```js
import { Fangorn, FangornConfig } from "@fangorn-network/sdk";
import { generatePrivateKey } from "viem/accounts";
// Fangorn.create needs a signer; a throwaway key is fine for reading.
const fangorn = Fangorn.create({ privateKey: generatePrivateKey(), config: FangornConfig });
const { card, appId, fromBlock, namespaces } = await fangorn.discoverApp(cardUrl);
```

**From the chain** (every Fangorn app; no index, no server):

```js
import { listApps } from "@fangorn-network/westmarch/apps";
const { apps, rejected } = await listApps(fangorn, { fromBlock: 311637349n });
// apps: [{ name, appId, card, url, views, namespaces, fromBlock }]
// rejected: [{ card, why }]: unreachable or not bound, reported rather than dropped
```

**From ERC-8004** (for general-purpose agents that know nothing about Fangorn):

```js
const api = "https://8004scan.io/api/v1/agents";
const { items } = await (await fetch(`${api}?chain_id=421614&search=Kingsfoil`)).json();
const detail = await (await fetch(`${api}/421614/${items[0].token_id}`)).json();
const found = await fangorn.discoverApp(detail.services.a2a.endpoint);
```

**The committed data itself:**

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
  from the commits and the shard digests, not from the card.

## Gotchas

| symptom | cause |
|---|---|
| push reverts `NotRegisteredForApp` | registered globally but not joined; `fangorn register` does both |
| `not bound to app … on-chain agent_uri is …` | URLs must match exactly. A trailing slash, `http` vs `https`, or a different path counts as a different card. |
| card rejected after a rebuild | the build dropped the `fangorn` block or changed `fromBlock`/`url`; keep them fixed |
| discovery works in Node, fails in a browser | no `Access-Control-Allow-Origin` on the card |
| `listApps` takes forever | `fromBlock` is too early; the scan is 1000 blocks per RPC call |
| `app agent`: "ERC-8004 registration pins the registration file to IPFS" | no Pinata JWT in `fangorn init` |
| `app agent` signs as the wrong wallet | `~/.fangorn/config.json` beats `ETH_PRIVATE_KEY` |
| search on the page matches words, never meaning | the bundler pre-bundled westmarch; `optimizeDeps.exclude` it |
| an agent's first call returns empty, later calls work | the tools registered before their data loaded (step 7) |
| an agent opens the page and finds no tools | `card.url` is not the page that registers them |
| `search` routes to the wrong views | thin coverage sketch or vague view descriptions; `bakeView` fits 32 centroids, and a description should say what's in the view |
| every visit re-downloads shards | no `immutable` header on the shards (step 8) |
| lint: "nowhere to go" | no `presentation.externalUrl`, so a hit links nowhere |
| `fangorn-mcp`: "this browser has no WebMCP" | page tools only: the browser lacks `document.modelContext`; it needs Chrome 150+ with `--enable-features=WebMCP` |
| `fangorn-mcp`: "no browser: cannot launch google-chrome" | page tools only: no local Chrome; set `FANGORN_MCP_CDP` |
| a log scan misses a transaction you just sent | fixed in the SDK (uncached head block); upgrade to ≥ 2026.9.22-dev |
| IPFS reads return "switching to a service worker gateway" | ipfs.io stopped serving raw content; use a Pinata gateway |
| the page isn't listed as a "Web" service on 8004scan | agent0-sdk has no web endpoint type; agents find the page through the card's `url` |

## Reference: Kingsfoil

Kingsfoil has 60,760 clinical trials in 23 views, baked by its own pipeline
(`kingsfoil/pipeline/bake.mjs`) rather than `bakeView`, because it predates it.

| | |
|---|---|
| site | https://kingsfoil.pages.dev |
| tools page (`card.url`) | https://kingsfoil.pages.dev/provider.html (the root is the patient view, with no tools) |
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
