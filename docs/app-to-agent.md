# From nothing to a running Fangorn app

This walks an app owner from an empty directory to a live app that people can use in a
browser and any agent can find, verify and query. By the end you have:

- **an app** claimed on Fangorn, owned by your wallet;
- **a schema** committed on chain: what your data's types are, which field is what, and
  which relations are allowed between them;
- **your data** committed on chain under your namespace;
- **a view** of it: your committed data embedded and sharded as static files, so people
  and agents can search it by meaning, updated with one command after each commit;
- **a static site** with no server: the view, and a page for people;
- **an agent card** bound to the app on chain, and registered as an ERC-8004 agent;
- **agents using it:** anyone running `fangorn-mcp` can `open-app` it by name.

Where the data comes from is up to you. The guide starts from a JSON array of objects,
which anything can produce: a scraper, a database export, a converted spreadsheet.

```
 your data ─► data/graph.json ─► fangorn commit/push ─┐
 schema/graph.json ─► fangorn commit/push ────────────┤  (namespace fangorn.schema)
                                                      ▼
                                                    chain ─► westmarch-view ─► site/view/
                                                             (embeds only what changed, applies the schema)
 app/ (page) ─► vite build ─► site/ ◄── the page loads site/view
 pipeline/agent-card.mjs ─► site/.well-known/agent-card.json (views: [site/view]) ─► deploy
                                                                        │
 fangorn app agent ─► ERC-8004 registration + AppRegistry agent_uri = card URL
                                                                        │
 fangorn-mcp: open-app my-app ─► reads the binding, verifies the card, searches the view
```

**Two tiers, one format.**
- **Free, local:** `westmarch-view` (step 7). It turns your commits into a view on your
  own machine or CI. It embeds on CPU, ~14 records/s, only what changed since the last
  run, and you host the files with your site.
- **Hosted:** quickbeam watches apps on chain, embeds on a GPU, and serves the view
  itself. It will also do things one app's files can't, such as state across apps. It
  writes the same files, so moving an app to it means changing the `views` URL in its
  card.

It runs on Arbitrum Sepolia.

## The short way: one config, one command

`westmarch-ship` does every step below from one `app.json`, and re-running it is how you
update: each step checks the chain (or Cloudflare) first and acts only on a difference.

```jsonc
// app.json
{
  "app": "my-app", "name": "My App", "description": "What it holds, for people and agents.",
  "tags": ["…"],
  "site": { "project": "my-app", "account": "<cloudflare account id>" },
  "types": { "my.thing.v1": { "description": "…",
      "role_map": { "identity": "id", "title": "name", "temporal": "date", "media": "url",
                    "tags": ["category"], "text": ["summary"] },
      "presentation": { "facets": ["category"] } } },
  "relations": [],
  "sources": [{ "namespace": "things", "command": ["python", "-m", "my_source"] }],
  "fangorn": "fangorn",                      // the CLI that signs
  "paid": { "price": "0.01", "network": "arbitrum-sepolia", "description": "the full record" }
}
```

```sh
npx westmarch-ship app.json            # claim, join, schema, crawl + publish, view, site, card, deploy, agent
npx westmarch-ship app.json --dry-run  # every step, printed, none done
npx westmarch-ship app.json --no-crawl # rebuild view, site and card from what is on chain
npx westmarch-ship app.json --replace  # each source's crawl becomes its namespace's whole state
```

What it does, in order (the long way, below, is the same steps by hand):

1. **claim** the app on the first run, and record the claim block (the card's `fromBlock`);
2. **join** it as a publisher, if the wallet has not;
3. **commit the schema** (`types`, `relations`) to `fangorn.schema`, if the chain's differs;
4. **run each source**: a command that publishes into `--namespace` when given `--publish`.
   Every quickbeam scraper Source does. A source with `"each": "rows.json"` is a template,
   one source per row (`{field}`, `{field|slug}`, `{args...}`), so adding a town, a feed or
   an account is adding a row;
5. **westmarch-view**: the app's commits → `.ship/site/view`, embedding only what changed.
   A removal rewrites the domain, so a retracted record's bytes stop being served;
6. **the site**: the stock page (search, plus a feed of what is coming up and what just
   happened, by the `temporal` role and the first `facets` field), the agent card and
   `_headers`. With `paid`, also `_worker.js`, which sells each record over x402; only
   records whose sha256 a live row carries are for sale;
7. **deploy** to Cloudflare Pages (`wrangler`; the project is created if missing);
8. **register** the ERC-8004 agent and bind the card, if the chain points elsewhere.

State lives in `.ship/` next to `app.json`. In CI, cache `.ship/cache` and `.ship/stage`
and commit `.ship/state.json`; Quorum's `.github/workflows/ship.yml` is a working example
(daily cron, and on every push to its config).

**What was run:** all of it, for Quorum (`https://quorum-bua.pages.dev`, agent `421614:245`):
five towns' meetings crawled, published, embedded and deployed by `westmarch-ship`, then
searched and bought (x402, settled on Arbitrum Sepolia) from `fangorn-mcp` in a fresh
session. Kingsfoil, the reference at the end, predates `ship` and was built by hand.

## Grading a change before it ships

New records are facts, and they always ship. What can make an app worse is its
**recipe**: how sources shape records, which fields `app.json`'s role maps embed, how a
view splits them. So a recipe change is graded against the recipe it replaces, over the
same records, before it merges.

```sh
npx westmarch-ship app.json --local /tmp/base-view     # a view from what the sources staged; no chain, no deploy
# …change app.json or a source…
npx westmarch-ship app.json --local /tmp/cand-view
npx westmarch-eval /tmp/cand-view --base /tmp/base-view # exit 1 = worse
```

`--local` builds every record every time (a changed `text` role must reach them all) and
remembers vectors in `.ship/vectors.ndjson` by the exact text embedded, so the second
build embeds only what the change touched.

What is asked lives in `eval/golden.jsonl`, one check per line, as data rather than code:

```jsonc
{"id":"plover","q":"Plover village board","expect":{"where":{"city":"Plover"}},"min":0.8}         // share of the top 5 that fits
{"id":"wells","kind":"count","where":{"county":"Portage"},"expect":{"match":{"heading":"well"}}}   // can a filter reach them at all
{"id":"addresses","kind":"records","expect":{"match":{"text":"/\\b\\d{2,6} [A-Z]\\w+ St\\b/"}},"max_pct":0.5,"hard":true}
```

Which questions go in is the owner's bet: who would pay for this, for which answers.
Write it down in `eval/goals.md` (the customer, their questions, the coverage they need, a
date, and what would count as failure), tag each check with the `goal` it serves, and the
report scores each goal on its own. A `coverage` check (`{"kind":"coverage","field":"city",
"values":[…]}`) measures how much of the list a goal needs is present at all; with a base,
any fall fails, because a recipe that loses a town has dropped its records.

`expect` is a predicate over a row: `where` (the whole-value match agents filter with),
`match` (a field, or several joined by `|`, to a regex; case-insensitive unless written
`/re/flags`), `not`. Relevance is a predicate and not a list of record ids, because ids
are content hashes and a recipe change that re-parses records changes every one.
Without labels, it also searches 200 sampled rows by their own titles (`known@1`, `known@10`).

Worse is: mean precision or `known@10` down more than 0.05, any question the base
answered now answered by nothing, a `hard` record check rising, or any floor or ceiling
missed. Quorum's `.github/workflows/eval.yml` runs this on every pull request, from the
records and vectors its `ship.yml` leaves in the cache, with no secrets; make it a
required check on `main`, and put `eval/`, `.github/` and `app.json` under `CODEOWNERS`,
or a PR can change the gate along with what it gates.

What is not graded yet: a change to how a source *parses*. `--local` reads what the
sources last staged; it does not replay their parsing over the raw documents.

## The long way, by hand

What `ship` does, one step at a time: for understanding it, or for doing one step differently.

### What you need

- Node 22.
- The Fangorn CLI: `npm i -g @fangorn-network/sdk@2026.9.22-dev` (gives `fangorn`).
- A wallet on Arbitrum Sepolia with a little ETH. **It owns the app forever**, so use the
  wallet that will publish the data.
- A Pinata JWT. Registering the ERC-8004 agent (step 11) pins a file to IPFS.
- A static host that serves `/.well-known/` and custom headers. Cloudflare Pages does
  both, and is what the commands below use.

Start the project:

```sh
mkdir my-app && cd my-app && npm init -y && npm pkg set type=module
npm i @fangorn-network/westmarch @huggingface/transformers vite
mkdir -p data schema pipeline app
```

The Fangorn SDK and viem come with westmarch as peer dependencies. transformers embeds:
your records in `westmarch-view`, and the reader's query in their browser.

## 1. Set up the CLI

```sh
fangorn init              # writes ~/.fangorn/config.json: key, Pinata JWT, gateway
fangorn wallet            # confirm which address will sign
fangorn set-app my-app    # the app every later command uses; --app <name> overrides it once
```

> The config file wins over `ETH_PRIVATE_KEY` in the environment. If `fangorn wallet`
> shows the wrong address, that's why.

## 2. Claim the app

First, note the current block. It becomes the card's `fromBlock` (step 9), which is where
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

## 4. Your data, as a graph

A commit is a graph: vertices, each with an `id`, a `tag` (its type) and a `payload` (the
record), and optional edges between them. Start from rows, `data/rows.json`:

```json
[
 { "id": "oak", "name": "Oak", "species": "Quercus robur", "family": "Fagaceae", "region": "Europe",
   "description": "Long-lived deciduous tree with lobed leaves and acorns; hard durable timber …" },
 { "id": "baobab", "name": "Baobab", "species": "Adansonia digitata", "family": "Malvaceae", "region": "Africa",
   "description": "Massive trunk stores water through the dry season; fruit pulp is rich in vitamin C." }
]
```

```js
// pipeline/graph.mjs — data/rows.json → data/graph.json
import { readFileSync, writeFileSync } from "node:fs";
const rows = JSON.parse(readFileSync("data/rows.json", "utf8"));
writeFileSync("data/graph.json", JSON.stringify({
    vertices: rows.map((r) => ({ id: r.id, tag: "my-app.tree.v1", payload: r })),
    // edges: [{ rel: "grows_in", from: "oak", to: "europe" }]   // between vertex ids, if you have them
}));
```

What makes records work well:

- **A stable id.** The same thing keeps the same id across commits.
- **Text that says what the record is, in words.** This is what gets embedded, so it's
  what "search by meaning" matches. A title alone is weak; a sentence or a paragraph is good.
- **Fields worth filtering or counting on**, such as a category, a region, or a date. Agents
  use these with `where` and `count`.
- **One tag per kind of thing.** Version it (`.v1`) so a later shape can be a new type.

## 5. Declare the schema

The schema says what your data is. You commit it to a reserved namespace,
`fangorn.schema`, in your app:
- **Types:** each is a vertex tagged `fangorn.type.v1`.
- **Relations:** the relations allowed between types are edges between those vertices.

`westmarch-view` (and hosted quickbeam) read it for every record they embed, so it decides:
- **what gets embedded:** the `text` role, plus title, subtitle and tags;
- **what readers see:** titles, links, labels;
- **what agents can do:** filters, counts, and choosing among views by their description.

`schema/graph.json`:

```json
{
 "vertices": [
  { "id": "tree", "tag": "fangorn.type.v1", "payload": {
      "tag": "my-app.tree.v1",
      "description": "Tree species: what they are, where they grow, and what they are good for.",
      "role_map": { "identity": "id", "title": "name", "subtitle": "species",
                    "tags": ["family", "region"], "text": ["description"] },
      "presentation": { "externalUrl": { "my-app.tree.v1": "https://en.wikipedia.org/wiki/{species}" } } } }
 ],
 "edges": []
}
```

```sh
cd schema && fangorn repo init fangorn.schema \
  && fangorn commit graph.json -m "schema v1" --replace && fangorn push && cd ..
```

`fangorn repo init` tracks one namespace per directory (in `.fangorn/`), which is why the
schema is committed from its own `schema/` folder.

**`role_map`** says which field is what:

| role | means | used for |
|---|---|---|
| `identity` | the id field | `get`, links, updates |
| `text` | the field(s) whose words get embedded | search by meaning |
| `title`, `subtitle` | what a record is called | result lists, and embedded too |
| `tags` | categories | filters, `count`, and embedded too |
| `temporal`, `spatial`, `measures`, `relations`, `media` | dates, places, numbers, links to other records, playable media | sorting, facets, previews |

**Rules:**
- **Declared means declared.** A role you leave out stays empty; it isn't guessed.
- **Undeclared types are still guessed:** a type the schema doesn't mention gets a role
  map inferred from its fields. That works for display and often fails for search: a
  field called `desc` or `nct` isn't recognized, and a `price` can end up as the date.
  Declare every type you publish.
- **Only the app owner's schema counts.** Any publisher can write a namespace called
  `fangorn.schema`; only the owner's is read.
- **You can change it at any time** with another commit. A view takes the new role map and
  description on its next `westmarch-view` run. **Records already embedded keep the text they were embedded
  with** until they're re-embedded, so change the `text` role early.
- **Relations** (edges between type vertices, e.g. `{ "rel": "grows_in", "from": "tree",
  "to": "region" }`) declare which edges the app allows. Nothing enforces them yet; they
  are what publisher graphs will be validated against.

## 6. Commit and push the data

```sh
node pipeline/graph.mjs
fangorn repo init my-app                                  # the data namespace, tracked in ./.fangorn
fangorn commit data/graph.json -m "first data" --replace  # local; builds and uploads the commit
fangorn push                                              # the on-chain transaction
```

`--replace` makes the file the namespace's whole state, so records you removed are
removed. Without it, the commit adds to what's already there. `fangorn status` compares
your local tip with the one on chain.

## 7. Publish the view

```sh
npx westmarch-view --app my-app --namespace my-app --out site/view --from-block 311700000
# my-app: 1 publisher(s) since block 311700000
# …-my-app: +20 embedded, -0 removed, 20 live
```

It reads the chain and writes files; it needs no key. For every publisher of each
`--namespace` in the app, it:
- reads their records;
- embeds the ones the view doesn't hold yet, with your schema's roles;
- marks the ones that were removed as deleted;
- writes a new shard;
- refits the coverage sketch once the view has doubled.

The view's own files are its state, so a second run with nothing new on chain changes
nothing, and it runs the same on a laptop, in CI, or from an agent. The first run
downloads the embedding model (131 MB, kept in `~/.cache/fangorn-mcp/models`, shared with
`fangorn-mcp`). Use `--from-block` with the block you noted in step 2.

```
site/view/cdn/catalog                                   every publisher's domain, with descriptions and coverage
site/view/cdn/domains/<app>-<publisher>-<ns>/manifest   role map, embedder, shards with their sha256, tombstones
site/view/cdn/domains/<app>-<publisher>-<ns>/shards/shard-NNNN-<sha>.ndjson.gz
```

Check it the way a reader will:

```sh
(cd site && python3 -m http.server 8765 &)
node node_modules/@fangorn-network/westmarch/consume/lint.js http://127.0.0.1:8765/view
# …-my-app — 20 rows — nothing to fix
```

`lint.js` reports three levels:
- **blocking:** readers can't find you (no coverage, wrong model);
- **findable, but not readable** (no text role);
- **readable, but a dead end** (nowhere for a hit to link to).

The fix for most findings is in the schema (step 5).

A view remembers which embedder made it, and `westmarch-view` refuses to add to a view
another one built. Vectors from two encoders don't compare. Pass `--rebake` to start
a view over.

## 8. The page

A page for people, with the same search exposed to agents in the browser as WebMCP tools.
It reads the view: shards are checked against their manifests' sha256, the query is
embedded in the reader's tab, and nothing about the query leaves it.

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

export const VIEW = new URL("view", location.href).href;   // step 7

const ctx = { rows: [], roles: rolesFrom([]), queryVector: (q) => embedQuery(q).catch(() => null) };
configure({ onManifests: (ms) => { ctx.roles = rolesFrom(ms); }, rowText: (f) => textOf(f, ctx.roles) });
ctx.rows = await loadShard(VIEW);   // checked against the manifests' sha256
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
    build: { outDir: "../site", emptyOutDir: false },   // keep site/view
};
```

```sh
(cd app && npx vite build)
```

`@fangorn-network/westmarch/tools` also has `describe`, `browse`, `facet` and `neighbors`,
if the page needs more than search. `watchShard(fn)` tells the page when the view gains
shards, if it should update without a reload.

## 9. The agent card

A WebMCP tool only exists inside a loaded tab, so the card is the only machine-readable
record that the app, its tools and its view exist. The tool list isn't written by hand:
`captureTools` runs your register function against a recording stub, so the card lists
exactly what the page registers. No `execute` runs.

```js
// pipeline/agent-card.mjs — site/ → site/.well-known/agent-card.json + site/_headers
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { agentCard, captureTools } from "@fangorn-network/westmarch/agent-card";
import { registerAgent } from "../app/agent.js";

const SITE = "https://my-app.pages.dev";
const VIEW = `${SITE}/view`;   // step 7; a hosted quickbeam view's URL goes here instead

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
        namespaces: ["my-app"],                    // your data namespace(s)
        views: [VIEW],
    },
});
mkdirSync("site/.well-known", { recursive: true });
writeFileSync("site/.well-known/agent-card.json", JSON.stringify(card, null, 1));

// The card is read from other origins, so it needs CORS, and so does the view, for
// agents and pages elsewhere. Bundles and shards are named by their digest, so they
// never change: tell caches so. Shards only in the reader's own browser (`private`): a
// retracted record's bytes must stop being served by shared caches once the deploy drops
// its shard. (Pages allows one * per rule, hence a rule per domain.)
const immutable = "  Cache-Control: public, max-age=31536000, immutable\n";
const mine = "  Cache-Control: private, max-age=31536000, immutable\n";
writeFileSync("site/_headers",
    "/.well-known/agent-card.json\n  Access-Control-Allow-Origin: *\n"
    + "/view/*\n  Access-Control-Allow-Origin: *\n"
    + `/assets/*\n${immutable}`
    + readdirSync("site/view/cdn/domains").map((d) => `/view/cdn/domains/${d}/shards/*\n${mine}`).join(""));
```

```sh
node pipeline/agent-card.mjs
```

- **The `fangorn` block** becomes an A2A extension (`https://fangorn.network/a2a/app/v1`).
  It holds the chain, the registry addresses (taken from the SDK, so they can't drift), your
  appId, `fromBlock`, `namespaces` and `views`. `agentCard` validates them the same way
  readers will, so a bad card fails your build, not someone else's discovery.
- **`views` is what agents search:** `fangorn-mcp` reads it directly, with no browser.
- **`url` is the page that registers the tools,** not just any page on the site.
- **`fromBlock`** only affects speed: readers query logs 1000 blocks per call, so an early
  block is slow, and 0 means hundreds of thousands of calls.
- **Keep these values fixed.** A rebuild that drops the extension or changes `url`
  publishes a card every reader rejects.

## 10. Deploy and check

```sh
npx wrangler pages deploy site --project-name my-app
curl -sD - https://my-app.pages.dev/.well-known/agent-card.json -o /dev/null | grep -iE "^HTTP|access-control"
# HTTP/2 200 · access-control-allow-origin: *
```

Open `https://my-app.pages.dev/` and search: that's the app for people. The card must be
live before step 11, because the CLI fetches it.

## 11. Register the agent and bind the card

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

## 12. Use it as an agent would

Register `fangorn-mcp` once (see [Using Fangorn apps from an agent](#using-fangorn-apps-from-an-agent)),
then in any agent:

```
open-app my-app               → verified: true, data_tools: true
my-app__describe              → the view's domains, with the schema's description
my-app__search "trees that survive fire"   → cork oak, oak, redwood  (ranked by meaning)
my-app__get "baobab"          → the whole record
```

`open-app` reads your app's binding from the registry, fetches the card, and checks that
the binding points back at exactly that URL. Only then does it add the tools.

## 13. Update it

New or changed data is a commit, then the view, then a deploy:

```sh
node pipeline/graph.mjs && fangorn commit data/graph.json -m "…" --replace && fangorn push
npx westmarch-view --app my-app --namespace my-app --out site/view --from-block 311700000
node pipeline/agent-card.mjs && npx wrangler pages deploy site --project-name my-app
```

Only what changed is embedded and uploaded. The page and agents see it on their next
load, since the view URL, the card and the on-chain binding all stay the same. Run
`fangorn app agent` again only if the card moves. Anything that can run those three lines
can keep an app current: a cron job, a CI workflow, or an agent that just published.

---

## Using Fangorn apps from an agent

`fangorn-mcp` is one MCP server for every Fangorn app: a new app needs no new
registration. Install it through npm (node ≥ 20):

```sh
claude mcp add fangorn -e FANGORN_LOG_WINDOW=100000 -- \
  npx -y -p @fangorn-network/westmarch -p @huggingface/transformers fangorn-mcp
```

Without `-p @huggingface/transformers`, the install is ~500 MB lighter and `search` ranks by
words, not meaning. Without `FANGORN_LOG_WINDOW`, `list-apps` scans the chain 1,000 blocks
per call and takes minutes.

[docs/mcp.md](mcp.md) has the full setup: other MCP clients, every setting, running from
source, and troubleshooting. A single-file binary (`bun build-bin.js`) exists but is not
published yet.

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
| an agent's first call returns empty, later calls work | the tools registered before their data loaded (step 8) |
| an agent opens the page and finds no tools | `card.url` is not the page that registers them |
| `search` ignores what records say, or titles are ids | the type isn't declared in the schema, so its roles were guessed; declare it (step 5) |
| a schema change didn't change search results | records keep the text they were embedded with; only newly embedded records use the new `text` role |
| the view is empty after a push | `westmarch-view` wasn't rerun, `--from-block` is after your commits, or the push hasn't landed (`fangorn status`) |
| `westmarch-view`: "vectors from two encoders are not comparable" | the view was built by another embedder (e.g. quickbeam); `--rebake`, or keep publishing it with that tool |
| `westmarch-view` runs for minutes before doing anything | `--from-block` is far too early; the log scan is 1000 blocks per call |
| lint: "nowhere to go" | no `presentation.externalUrl` in the schema, so a hit links nowhere |
| `fangorn-mcp`: "this browser has no WebMCP" | page tools only: the browser lacks `document.modelContext`; it needs Chrome 150+ with `--enable-features=WebMCP` |
| `fangorn-mcp`: "no browser: cannot launch google-chrome" | page tools only: no local Chrome; set `FANGORN_MCP_CDP` |
| a log scan misses a transaction you just sent | fixed in the SDK (uncached head block); upgrade to ≥ 2026.9.22-dev |
| IPFS reads return "switching to a service worker gateway" | ipfs.io stopped serving raw content; use a Pinata gateway |
| the page isn't listed as a "Web" service on 8004scan | agent0-sdk has no web endpoint type; agents find the page through the card's `url` |

## Reference: Kingsfoil

Kingsfoil has 60,760 clinical trials in 23 views. It predates the schema and quickbeam
path: it embeds and bakes its own views (`kingsfoil/pipeline/bake.mjs`) and serves them
from its own site. That works, but every update is a manual rebake and redeploy.

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
