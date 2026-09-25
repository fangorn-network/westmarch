---
name: fangorn-app
description: Build, publish and register a Fangorn app with @fangorn-network/westmarch — from a JSON array of records to a live static site any person can search by meaning and any agent can discover, verify and drive. Use this whenever someone wants to put a dataset, catalog, corpus or collection "on Fangorn", make it searchable without running a server, expose it to agents (WebMCP page tools, fangorn-mcp data tools, an agent card, ERC-8004/A2A), declare a fangorn.schema role_map, run westmarch-view, bake or lint a view, or asks how their data can be found by fangorn-mcp.
---

# Building a Fangorn app with westmarch

A Fangorn app is a static site plus a few on-chain facts. The data is committed to
the app owner's namespace on Arbitrum Sepolia; `westmarch-view` embeds those commits
into content-addressed shards the site hosts; a page reads the shards and searches
them in the reader's tab; an agent card bound on chain tells every agent where the
page, the tools and the views are. Nothing runs on a server the owner has to keep up.

```
records ─► data/graph.json ─► fangorn commit/push ─┐
schema/graph.json ─► fangorn commit/push ──────────┤ (namespace fangorn.schema)
                                                   ▼
                                                 chain ─► westmarch-view ─► site/view/
app/ (page) ─► vite build ─► site/ ◄── the page loads site/view
pipeline/agent-card.mjs ─► site/.well-known/agent-card.json ─► deploy ─► fangorn app agent
```

The full walkthrough with every file's source is the guide. Read the sections named
below when you reach them; do not read it whole up front.

- in the repo: `${CLAUDE_PLUGIN_ROOT}/../docs/app-to-agent.md`
- once the package is installed in the project: `node_modules/@fangorn-network/westmarch/docs/app-to-agent.md`

## Before writing anything, settle six things

1. **Where the records are.** A path or URL to the actual data, in hand. The person should be presented
   with an input box along with this option so they can type a location before moving on to other options. Do not scaffold,
   invent a shape, or write placeholder rows in its place. The user may point you to data
   that has already been embedded as well. Generating a starter set is a
   separate choice they make explicitly, and it still burns a permanent app name.
2. **What the person would like the app name to be.** The application name is permanent once claimed.
   Do not assume that the name matches that of the data being supplied.
3. **What is a record.** A vertex is `{ id, tag, payload }`. The id must be stable
   across commits (the same thing keeps the same id, or every update looks like a
   delete plus an insert). The payload needs prose that says what the record *is* —
   that text is what gets embedded, so a title alone searches badly. Version the tag
   (`my-app.thing.v1`) so a later shape can be a new type.
4. **Which tier.** `westmarch-view` is free and local: it embeds on CPU at 14–65
   records/s depending on the machine (26,575 records took 415 s on a desktop), only
   what changed since the last run, and you host the files.
   Hosted quickbeam watches the chain and embeds on a GPU. Both write the same files,
   so an app moves between them by changing one URL in its card. Start local.
5. **Whether the rows belong on chain at all.** For a few thousand records, commit
   them and let `westmarch-view` do the rest — that is the path below. For a corpus
   that is already public and large (Kingsfoil: 60,760 trials), the pattern is to bake
   the shards yourself and commit one vertex per view carrying that shard's sha256, so
   the chain anchors a digest instead of 235 MB of public-domain rows. If the person
   has the `kingsfoil` repo, `pipeline/bake.mjs` and `chain/graph-commit.mjs` are that
   pattern; otherwise the layout is in *The view on disk* below.
6. **Where the site will live.** The card's `url` is permanent once bound (step 11), so
   ask before building. The default is Cloudflare Pages at `<name>.pages.dev`; otherwise
   the person enters a domain they own. `fangorn.network` is not available to app
   builders — never offer or assume a hostname under it.

## What the person must have

- Node 22 and the Fangorn CLI: `npm i -g @fangorn-network/sdk@2026.9.22-dev`, or whatever
  newer version westmarch's `package.json` lists as its `@fangorn-network/sdk` peer.
- A wallet on Arbitrum Sepolia with a little ETH. **It owns the app forever**, so it
  must be the wallet that will publish the data. Never generate a key for a real app;
  throwaway keys are only for read-only paths.
- A Pinata JWT, because registering the ERC-8004 agent pins a file to IPFS.
- A static host that serves `/.well-known/` and custom headers, at `<name>.pages.dev`
  or on a domain they own. Cloudflare Pages does both.

Project layout the guide assumes:

```sh
mkdir my-app && cd my-app && npm init -y && npm pkg set type=module
npm i @fangorn-network/westmarch @huggingface/transformers vite
mkdir -p data schema pipeline app
```

## Chain writes and deploys are the person's call

Several steps cost money or cannot be undone: `fangorn app claim` (first come, first
served, permanent), `fangorn register` (pays the registration fee), every `fangorn repo
init` and `fangorn push` (gas), `wrangler pages project create` and `pages deploy`, and
`fangorn app agent` (pins to IPFS, mints an agent).
Show the exact command and what it does, then run it only when they say so. Everything
else — building the graph, the schema, the page, the card, the local view, the lint —
is free and reversible, so just do it.

## The build, step by step

Each step names the guide section that holds its code and the check that proves it worked.

**1. CLI setup** (guide §1)

```sh
fangorn init          # ~/.fangorn/config.json: key, Pinata JWT, gateway
fangorn wallet        # confirm which address will sign
fangorn set-app my-app
```

The config file beats `ETH_PRIVATE_KEY` in the environment. If `fangorn wallet` shows
the wrong address, that is why.

The gateway must belong to the **same Pinata account as the JWT**. Uploads go to the
JWT's account, and a dedicated gateway is restricted to its own account's pins, so a
gateway from another account 403s on everything you just wrote and the first `commit`
fails. Check before any chain write — the configured host must be listed:

```sh
curl -s https://api.pinata.cloud/v3/ipfs/gateways -H "Authorization: Bearer $JWT"   # rows[].domain
```

Instead of `set-app`, `--app my-app` on every command leaves the person's stored app
alone, which matters if they already publish another one from this wallet.

**2. Note the block, then claim** (guide §2)

Record the current block number *before* claiming; it becomes the card's `fromBlock`,
where readers start scanning the chain for this app. Then `fangorn app info` (expect
"unclaimed") and `fangorn app claim`. Placeholder terms are fine at first; real ones
come later with `fangorn app terms <hash> <uri>`.

**3. Become a publisher** (guide §3)

`fangorn register` does the global registration and joins this app. Both are needed:
a push from a wallet that registered but did not join reverts `NotRegisteredForApp`.
Check with `fangorn app info`.

**4. Data as a graph** (guide §4)

Write `pipeline/graph.mjs` that turns the source rows into
`{ vertices: [{ id, tag, payload }], edges?: [{ rel, from, to }] }` at `data/graph.json`.
One tag per kind of thing. Keep fields worth filtering on (category, region, date) as
their own keys; agents use them with `where` and `count`.

The vertex `id` exists only in this file — the chain addresses vertices by CID, and edges
are resolved to CIDs at commit time. What readers key rows by is the **payload's** `id`:
`loadShard` builds `{ id: <CID>, ...payload }`, so a payload `id` replaces the CID as the
row id that `search` returns and `get` looks up. It must therefore be unique across
**every type** in the namespace. Source ids often are not (a genre and a tag both called
`electronic`); make the payload `id` the namespaced key (`audius:genre:electronic`), keep
the source's own id under another name, and declare `identity: "id"` in the schema.

**5. Declare the schema** (guide §5)

`schema/graph.json` holds one `fangorn.type.v1` vertex per data type, whose payload
carries `tag`, `description`, `role_map` and `presentation`. The role map decides what
gets embedded (`text`, plus `title`, `subtitle`, `tags`), what readers see, and what
agents can filter and count on. Declare every type you publish: an undeclared type gets
its roles guessed from field names, which works for display and often fails for search.

Commit it to the reserved namespace from its own directory, because the CLI tracks one
namespace per directory in `.fangorn/repo.json` and finds that file by searching upward:

```sh
cd schema && fangorn repo init fangorn.schema \
  && fangorn commit graph.json -m "schema v1" --replace && fangorn push && cd ..
```

`repo init` is itself a chain write: it commits an empty root and pushes it to
allocate the namespace, so count it in the gas the person approves. The `commit` after
it reads that root back through the gateway, which is where a gateway/JWT mismatch
(step 1) first shows. When chaining these through a pipe (to strip spinner output),
`set -o pipefail`, or a failed `commit` still runs the `push`.

Only the app owner's `fangorn.schema` is read. Records keep the text they were
embedded with until re-embedded, so get the `text` role right before the first bake.

**6. Commit and push the data** (guide §6)

```sh
node pipeline/graph.mjs
fangorn repo init my-app
fangorn commit data/graph.json -m "first data" --replace
fangorn push
```

`--replace` makes the file the namespace's whole state, so removed records are removed.
`fangorn status` compares the local tip with the chain.

`commit` is local until `push`. To throw away an unpushed commit (a payload mistake found
before pushing), set `head` in `.fangorn/repo.json` back to the on-chain tip that
`fangorn status` shows and commit again; the abandoned commit's uploads stay pinned
but nothing references them.

**7. Publish the view** (guide §7)

```sh
npx westmarch-view --app my-app --namespace my-app --out site/view --from-block <block from step 2>
```

It reads the chain and writes files, needs no key, embeds only records the view does
not hold yet, tombstones removed ones, and refits coverage once the view has doubled.
The first run downloads the 131 MB model into `~/.cache/fangorn-mcp/models`. A second
run with nothing new on chain changes nothing. It refuses to append to a view another
encoder built; `--rebake` starts over.

Check it the way a reader will:

```sh
(cd site && python3 -m http.server 8765 &)
node node_modules/@fangorn-network/westmarch/consume/lint.js http://127.0.0.1:8765/view
```

Lint has three levels: readers cannot find you (no coverage, foreign model), they find
you and cannot read you (no text role), or they read you and cannot go anywhere (no
`presentation.externalUrl`). Nearly every fix is in the schema.

**8. The page** (guide §8 — read it for `app/main.js`, `app/agent.js`, `index.html`, `vite.config.js`)

The page wires four things from westmarch and nothing else:

```js
import { configure, loadShard } from "@fangorn-network/westmarch/shard";
import { rolesFrom, textOf } from "@fangorn-network/westmarch/roles";
import { search, getRow } from "@fangorn-network/westmarch/tools";
import { embedQuery } from "@fangorn-network/westmarch/embed";
```

The ordering that is silent when wrong: `rowText` runs per row while the shard is
parsing, so the roles it depends on must exist before the first row. Hand
`configure({ onManifests })` the manifests and derive roles there; the format puts every
manifest on the wire before any shard. Register the WebMCP tools only after
`loadShard` resolves — a tool called before its data loads answers "nothing" and no
error says why.

`vite.config.js` needs two lines that are easy to lose: `optimizeDeps.exclude:
["@fangorn-network/westmarch"]` (pre-bundling breaks the embed worker's `new URL(…,
import.meta.url)` and search silently drops to word matching) and `build.emptyOutDir:
false` (so building the app does not delete `site/view`). Add `build.target: "es2022"`:
the page uses top-level `await`.

The build also emits onnxruntime's `ort-wasm-simd-threaded.asyncify-*.wasm`, about
27 MB — over Cloudflare Pages' 25 MiB per-file limit, so the deploy fails. The page
never fetches it: transformers.js points `wasmPaths` at jsDelivr unless told otherwise.
Delete it as part of the build, and confirm in a browser that search still reports
meaning rather than words:

```sh
npm pkg set scripts.build="cd app && vite build && rm -f ../site/assets/*.wasm"
```

Check `find site -size +25M` is empty before deploying; a view shard can cross the
limit too (one shard held 26.6k rows in 12.5 MB, so the ceiling is roughly 50k rows).

**9. The agent card** (guide §9)

`pipeline/agent-card.mjs` captures the page's tools by running its register function
against a recording stub, so the card lists exactly what the page registers:

```js
import { agentCard, captureTools } from "@fangorn-network/westmarch/agent-card";
const card = agentCard({
    name, description, url: `${SITE}/`,          // url = the page that REGISTERS the tools
    version, tools: await captureTools(() => registerAgent({})),
    fangorn: { app: "my-app", fromBlock, namespaces: ["my-app"], views: [`${SITE}/view`] },
});
```

Write it to `site/.well-known/agent-card.json` and write `site/_headers` with
`Access-Control-Allow-Origin: *` on the card and on `/view/*` — discovery runs from
other origins, and a card the browser will not hand over is a card nobody can verify.
`agentCard` validates the Fangorn block the way readers will, so a bad card fails the
build instead of the first reader.

**Before step 9: create the Pages project and read back its hostname.** The card's `url`
is permanent once bound, and `<name>.pages.dev` is global — a taken name is silently
given a suffix (`my-app-4xk.pages.dev`). Create the project first, from an **empty
directory**, and write the card against the hostname it prints:

```sh
cd "$(mktemp -d)" && CLOUDFLARE_ACCOUNT_ID=<id> npx wrangler pages project create my-app --production-branch main --force
```

- `--force`, once: wrangler ≥ 4.138 otherwise delegates Pages to Workers. Run inside the
  app it autoconfigures a Worker — writes `wrangler.jsonc`, a root `vite.config.js` with
  `@cloudflare/vite-plugin`, `deploy`/`preview` scripts and two devDependencies — then
  fails; from an empty directory it just fails. Once the project exists, later
  `pages deploy` calls go straight to Pages; do not pass `--force` again. If the
  autoconfig already ran, delete what it added.
- `CLOUDFLARE_ACCOUNT_ID`: with more than one account on the login, non-interactive
  wrangler refuses to pick. `npx wrangler whoami` lists them; ask which one.

**10. Deploy and check** (guide §10)

```sh
CLOUDFLARE_ACCOUNT_ID=<id> npx wrangler pages deploy site --project-name my-app --branch main
curl -sD - https://my-app.pages.dev/.well-known/agent-card.json -o /dev/null | grep -iE "^HTTP|access-control"
```

Expect `200` and `access-control-allow-origin: *`. The card must be live before step 11.
A fresh `pages.dev` hostname answers `522` for the first minute or so; retry rather than
debug. Check with `curl`: Cloudflare 403s Python's `urllib` user agent.

**11. Register the agent and bind the card** (guide §11)

```sh
fangorn app agent https://my-app.pages.dev/.well-known/agent-card.json
```

This mints an ERC-8004 agent from the card and calls `setAppAgentUri`, whose event is
the app directory `fangorn-mcp` reads. `discoverApp` accepts a card only if the app on
chain points back at *exactly* that URL — a trailing slash or `http` for `https` is a
different card. `--skip-register` only rebinds, for moving an already-registered card.

**12. Use it as an agent would** (guide §12 and *Using Fangorn apps from an agent*)

With `fangorn-mcp` registered in any MCP client: `open-app my-app` should report
`verified: true, data_tools: true`, then `my-app__describe`, `my-app__search`,
`my-app__get`. Data tools read the views directly with no browser; `page: true` adds
the page's own WebMCP tools through a browser.

**13. Updating** (guide §13) is three lines and nothing else changes:

```sh
node pipeline/graph.mjs && fangorn commit data/graph.json -m "…" --replace && fangorn push
npx westmarch-view --app my-app --namespace my-app --out site/view --from-block <block>
node pipeline/agent-card.mjs && npx wrangler pages deploy site --project-name my-app
```

Only what changed is embedded and uploaded. Rerun `fangorn app agent` only if the card
URL moves.

## The API, as it actually returns

These shapes have each cost someone a silent bug; code against them, not against
what a name suggests.

| call | takes | returns |
|---|---|---|
| `configure({ resolveView, rowText, onManifests })` | `rowText(fields, view)`, `onManifests(manifests, view)` | — |
| `loadShard(base, onRows?)` | view base URL | rows `{ id, owner, ...fields, text, vector, norm }`, cached per view |
| `rolesFrom(manifests, sample?)` | manifests from `onManifests` or `domainManifests()` | roles; `roles.declared` says whether it was read or sniffed |
| `search(rows, query, roles, { qv, limit, where, fields })` | `qv` from `embedQuery`, or `null` for word matching | a **flat array** of briefs with `score` and `mode` — not `{ hits }` |
| `getRow(rows, id, roles)` | id, the declared identity field, or a title | the whole row minus the vector, or `null` |
| `neighbors(rows, id, roles, { limit })` | a row id | `{ seed, near }` |
| `facet(rows, field, { limit, where })` | a field name | `{ field, distinct, missing, top: [{ value, count }] }` |
| `browse(rows, roles, { type, where, sort, limit, offset })` | — | `{ total, offset, returned, collections, rows }` |
| `embedQuery(text)` | a query | a promise of a 256-d vector; rejects if the model cannot load, so fall back to `qv: null` |
| `warmEmbedder()` | — | **`undefined`**, not a promise. It only starts the download; `.then` on it throws |
| `taste(likes, dislikes)` | rows `{ id, title, vector }`, not bare vectors | a taste, or `null` |
| `recommend(rows, taste, { limit, exclude })` | — | `[{ row, score }]` — the score key is `score`, not `s` |

`where` matches case-insensitively on whole values, so an agent echoing a faceted value
back with the wrong case still hits, and `comedy` never counts every `dark comedy`.

## What can never change once it is on chain

| pin | why |
|---|---|
| the app name | claimed once, permanent; its hash is the appId in every card and log |
| namespace names | `fangorn.schema` is reserved; each data namespace is a timeline readers follow by name |
| the card's `url` and `fromBlock` | a rebuild that changes either publishes a card every reader rejects |
| a record's `id` | the same thing under a new id is a delete and an insert, re-embedded at full cost |
| for an app selling files through `publish/graph.js` and `envelope.js`: `ns`, `file`, `passages`, `pointerFields` | folded into every resourceId and vertex ever minted; the headers of those two files say why |

## The view on disk

Whether `westmarch-view` or a bake script writes it, a reader fetches exactly this:

```
<view>/cdn/catalog                          embedding_model + every domain's description, count, coverage
<view>/cdn/domains/<domain>/manifest        role_map, presentation, embedder, shards [{file, count, bytes, sha256}], tombstones
<view>/cdn/domains/<domain>/shards/shard-NNNN-<sha12>.ndjson.gz
```

A shard row is `{ track_id, owner, fields, v }` with `v` as base64 int8 (`packVec`
from `consume/embed.js`). The manifest hashes each shard *as served*, gzipped, and
`shard.js` refuses a mismatch — that is what lets the files sit behind any CDN. Serve
`.ndjson.gz` as `application/gzip` with no `Content-Encoding`, or readers cannot verify.
`coverage` is spherical k-means over the domain's own vectors (`coverage()` in
`publish/reactions.js`); without it a corpus scores `null` in every directory and is
never opened.

## Symptoms and causes

| symptom | cause |
|---|---|
| push reverts `NotRegisteredForApp` | registered globally but not joined; `fangorn register` does both |
| `not bound to app … on-chain agent_uri is …` | the card URL differs by a slash, scheme or path |
| the view is empty after a push | `westmarch-view` not rerun, `--from-block` after the commits, or the push has not landed (`fangorn status`) |
| `westmarch-view` runs for minutes before doing anything | `--from-block` far too early; the scan is 1000 blocks per RPC call |
| search matches words, never meaning | the bundler pre-bundled westmarch; exclude it in `optimizeDeps` |
| an agent's first call returns empty, later calls work | tools registered before the data loaded |
| `search` ignores what records say, or titles are ids | the type is not in the schema, so roles were guessed |
| a schema change did not change search | records keep the text they were embedded with; only new records use the new `text` role |
| lint: "nowhere to go" | no `presentation.externalUrl` for that entity type |
| `app agent`: registration needs IPFS | no Pinata JWT in `fangorn init` |
| `app agent` signs as the wrong wallet | `~/.fangorn/config.json` beats `ETH_PRIVATE_KEY` |
| IPFS reads say "switching to a service worker gateway" | ipfs.io no longer serves raw content; set a Pinata gateway in `fangorn init` |
| `fangorn-mcp`: "this browser has no WebMCP" | page tools need Chrome 150+ with `--enable-features=WebMCP`; data tools never need a browser |
| `commit` right after `repo init`: "owner of this gateway does not have this content pinned" (ERR_ID:00006) | the configured gateway belongs to a different Pinata account than the JWT (step 1) |
| `get` returns the wrong record, or two types share search ids | payload `id` is not unique across types; it replaces the CID as the row id (step 4) |
| `wrangler pages …` writes `wrangler.jsonc` / "Could not detect a directory containing static files" | wrangler ≥ 4.138 delegated Pages to Workers; create the project once with `--force` from an empty dir |
| wrangler: "More than one account available" | set `CLOUDFLARE_ACCOUNT_ID` |
| Pages deploy rejects a file over 25 MiB | onnxruntime's `.wasm` in `site/assets`; delete it after `vite build` (step 8) |
| deployed site answers `522` | a new `pages.dev` hostname still propagating; wait a minute |
| `app agent`: "verification timed out. Content may propagate with delay" | harmless if an Agent ID and Tx follow; the registration file is pinned — fetch it through your gateway to confirm |

## Before saying it is done

- `fangorn status` shows the local tip on chain.
- `lint.js` against the **deployed** origin reports "nothing to fix" for every domain.
  What matters is what a stranger can fetch, not what was built.
- The card answers `200` with CORS from another origin.
- `fangorn-mcp open-app <name>` returns `verified: true`, and `describe` lists the
  namespaces with the schema's description, not a guess.
- A search phrased by *meaning* (not a title) returns the right records with
  `ranked_by: "meaning"`.

## Keeping it current, and improving it safely

For an app whose data keeps arriving (meetings, alerts, filings), offer this once it is
verified: it is what lets an agent keep the app running and improve it without a person
checking every run. It needs the app on `westmarch-ship` (`app.json`, guide *The short
way*); an app built by hand moves there first. Read the guide's *Grading a change before
it ships* before starting.

1. **The bet, in the person's words.** Before any question: who would pay for this app,
   for which answers, and how they would know it failed. Write it to `eval/goals.md`, one
   section per goal: the customer, the questions they ask, the coverage they need (which
   towns, which permits), a date, and what would kill it ("no paid record of this kind by
   then"). It is their guess about what will be profitable; do not make it for them, and
   push back on "everything, for everyone", which gives the loop nothing to aim at.
   **Then the questions.** Write `eval/golden.jsonl` from that bet: 10–20 questions its
   customer would ask, each with a predicate over the fields that makes a hit a hit, and a
   `goal` naming the bet it serves; `count` checks for the filters agents will use; a
   `coverage` check for the list the bet needs covered. If records can name private
   people, add `records` checks for what must never show (names, addresses) with
   `"hard": true`. Relevance is never a list of record ids.
2. **Grade what is there.** `npx westmarch-ship app.json --local /tmp/view`, then
   `npx westmarch-eval /tmp/view`. Set each `min` and `max_pct` from this first run, just
   past what it scored. Show the person any question that scores 0: either the question or
   the recipe is wrong, and that is their call.
3. **The repo.** With the person's go-ahead (it is public and outward-facing): `gh repo
   create`, push, then copy from Quorum: `.github/workflows/ship.yml` (the cron that ships
   data, with its secrets list), `.github/workflows/eval.yml` (the PR gate, no secrets),
   `.github/CODEOWNERS` (`eval/`, `.github/`, `app.json`) and
   `.github/ISSUE_TEMPLATE/observation.yml`. Set the secrets with `gh secret set`, never by
   echoing them. Protect `main`: the `eval` check required, code-owner review required.
4. **Check the loop once.** Let `ship` run (`gh workflow run ship`), then open a PR that
   changes only the README. `eval` must pass with `unchanged`.

What the parts may do: `ship` holds the wallet key and publishes data, whatever it is.
`eval` holds nothing and decides whether a recipe change may merge. An agent that
proposes improvements opens PRs and nothing else. It never pushes to `main`, never merges,
and never edits `eval/` in the same PR as the recipe.

## After initial implementation is complete, deployed, and verified

The base app is just a simple search. Once everything has been deployed and verified, prompt the user for extra functionality
to be present in the UI. For each extra requirement, there must be a corresponding webmcp tool that allows agents to seamlessly
interact with the application.

Start only after every item in *Before saying it is done* has passed against the
deployed site. A feature built on a broken base makes both failures harder to find.

### 1. Ask, offering what the view can actually back

Use `AskUserQuestion` with `multiSelect: true`, so the person can type their own idea
under "Other". Build each option from **this** app's schema: name its real fields and
types, not generic features. Every option must map to something `westmarch/tools` already
does over the loaded rows:

| feature a person sees | westmarch call | notes |
|---|---|---|
| filter by a category, e.g. genre chips or a region dropdown | `search(…, { where })`, `facet` | only fields declared in `tags`/`presentation.facets`; `facet` supplies the values |
| browse without a query, sorted by a date or count | `browse(rows, roles, { type, where, sort, desc, limit, offset })` | `sort` takes a field name; numeric strings sort as numbers |
| a record's detail panel | `getRow` | returns every field, so decide which to show |
| "more like this" | `neighbors(rows, id, roles, { limit })` | vector-only, needs no query |
| counts and charts ("how many per genre") | `facet(rows, field, { where })` | |
| records that belong to one entity ("this artist's tracks") | `browse` with `where: { <foreign-key field>: id }` | only if the row carries the key (e.g. `artistId`) |
| recommendations from likes and dislikes | `taste` + `recommend` | keep taste in memory or in `localStorage`, never on chain |

Say so plainly, and do not promise these:
- **Edges are not in the view.** `westmarch-view` ships flat records; the committed
  edges stay on chain. A graph feature works only through a field on the row (row 6
  of the table above). Otherwise it needs a data change (step 2c).
- **Anything that needs a server or a secret** (accounts, writes, paid APIs, private
  data) does not fit a static app. Offer the closest static version, or stop.
- **Features that fetch from a third party** (artwork, audio streams, maps) add a
  runtime dependency and privacy exposure the base app lacks. Name the host, and get a
  yes before building one.

### 2. Classify every accepted feature before writing code

The class decides cost, what must be rerun, and whether the person approves first.

| class | example | what changes | rerun | approval |
|---|---|---|---|---|
| **a. page only** | chips, sort, detail panel, more-like-this | `app/` | build, card, deploy | deploy |
| **b. schema only** | a new facet, `externalUrl`, `presentation.types` labels, a `measures` field | `schema/graph.json` | schema commit + push, `westmarch-view` (applies the spec with no re-embed), build, card, deploy | push + deploy |
| **c. data** | a new field on records, new records | `pipeline/graph.mjs` | data commit + push, `westmarch-view`, build, card, deploy | push + deploy, stating the re-embed cost |
| **d. out of scope** | login, payments, writes | — | — | tell them why |

For class c, spell out the cost first. A record's identity in the view is its vertex
CID, and the CID is the hash of the payload. Adding one field to every record therefore
makes every record new: all of them are re-embedded at full cost (14–65 records/s),
the old ones are tombstoned, and the shard is rewritten. Class b changes to the
`text`, `title`, `subtitle` or `tags` roles do **not** re-embed existing records, so
search keeps the old text until the records change. Say that too, or the person will
expect search to change.

### 3. One action per feature, shared by the UI and its tool

Parity breaks when the page and the tool hold two copies of the logic. Give every
feature exactly one pure function in `app/agent.js`, `(ctx, args) → JSON-able result`.
`registerAgent` wraps it as a tool, and the UI handler calls the same function:

```js
// app/agent.js
export const actions = {
    browseTracks: (ctx, { genre, sort = "playCount", limit = 20, offset = 0 }) =>
        browse(ctx.rows, ctx.roles, { type: tagOf("track"), where: genre ? { genre } : undefined, sort, limit, offset }),
};
// in registerAgent:
mc.registerTool({ name: "browse-audius-tracks", description: "…", inputSchema: { … },
    execute: async (args) => ok(actions.browseTracks(ctx, args)) });
// app/main.js: the UI calls actions.browseTracks(ctx, { genre: chip.value }) — never browse() directly
```

Rules for every tool. Each one has cost someone a silent bug:
- **Name `<verb>-<app-noun>`** (`browse-audius-tracks`). `fangorn-mcp` already gives every
  app `describe`, `search`, `get`, `similar`, `count` and `browse`, and a page tool with
  one of those names is renamed `page-<name>`.
- **The description says when to call it**, and which other tool's output feeds its
  inputs ("ids come from search-audius").
- **The input schema is strict.** Use `required`, an `enum` for every closed set (types,
  sort fields), and `limit` with a sane default and a cap. Build enums from constants,
  not from `ctx`: `captureTools` runs `registerAgent({})` with an empty context, so a
  schema derived from `ctx.rows` crashes the card build or comes out empty.
- **Only `execute` reads `ctx`**, and tools register after `loadShard` resolves. That
  already holds if new tools go inside the existing `registerAgent`. A feature that
  loads more data (a second view) must finish before `registerAgent` runs.
- **Return data, not prose**, and use `{ error: "…" }` for a miss rather than throwing.
  Every id a tool returns must be accepted by the `get` tool.
- **`where` values match whole values, case-insensitively.** An enum or a `facet` result
  hands agents exact values.
- **Existing tools are a public interface.** Agents and cards in the wild use them, so
  add optional parameters and never rename, remove or retype one.
- **Stateful features (a player, a cart, a selection) keep their state in one object
  on `ctx`**, created lazily inside the action (`ctx.player ??= createPlayer()`), so the
  tool check's bare context still gets one. The UI subscribes to that object's changes
  rather than to its own clicks, because a tool call changes the page too, and the person
  must see what an agent did.
- **Media a tool starts can be blocked by autoplay policy.** `play()` from a tool call is
  not a user gesture, so the browser rejects it with `NotAllowedError` until the person
  has interacted with the page. Return that as an `error` that tells the agent to ask
  the person to press play, with the item loaded. Do not report it as playing, and do not
  mark the item unavailable. Any other rejection means the item really is unavailable.

The UI side, in the same change: every control has a label, works by keyboard, keeps
the 16px phone gutter, and keeps working when `document.modelContext` is absent (most
browsers). The UI must never depend on WebMCP. A list that repaints on a timer or on
player ticks steals keyboard focus, so repaint it only when what it shows changes, and
restore focus to the same control (`data-id` + `CSS.escape`) after a repaint.

### 4. Verify locally, for both people and agents

1. `npm run build`, then serve `site/` on a free port (`ss -ltn | grep <port>` first,
   because a port that is already taken serves someone else's 404s and lint reports
   "no catalog").
2. **Every tool, by an agent's call.** `pipeline/check-tools.mjs` loads the served view,
   captures `registerAgent`'s tools with a stub `modelContext`, and runs one sample
   call per tool. It fails a tool with no sample, an `error` key, or an empty result.
   Add a sample for each new tool in the same change:

   ```js
   // pipeline/check-tools.mjs — CALLS='{"<tool>":{…args}}' node pipeline/check-tools.mjs http://127.0.0.1:<port>/view
   import { homedir } from "node:os";
   const { env } = await import("@huggingface/transformers");
   env.cacheDir = `${homedir()}/.cache/fangorn-mcp/models`;
   const { configure, loadShard } = await import("@fangorn-network/westmarch/shard");
   const { rolesFrom, textOf } = await import("@fangorn-network/westmarch/roles");
   const { embedQueryDirect } = await import("@fangorn-network/westmarch/embed");
   const { registerAgent } = await import("../app/agent.js");
   const CALLS = JSON.parse(process.env.CALLS ?? "{}");
   const ctx = { rows: [], roles: rolesFrom([]), queryVector: (q) => embedQueryDirect(q).catch(() => null) };
   configure({ onManifests: (ms) => { ctx.roles = rolesFrom(ms); }, rowText: (f) => textOf(f, ctx.roles) });
   ctx.rows = await loadShard(process.argv[2]);
   const tools = {};
   globalThis.document = { modelContext: { registerTool: (t) => { tools[t.name] = t; } } };
   registerAgent(ctx);
   let bad = 0;
   for (const [name, t] of Object.entries(tools)) {
       const args = CALLS[name];
       if (!args) { console.log(`✗ ${name}: no sample call`); bad++; continue; }
       const out = JSON.parse((await t.execute(args)).content[0].text);
       const empty = out == null || out.error || (Array.isArray(out) && !out.length);
       console.log(`${empty ? "✗" : "✓"} ${name} → ${JSON.stringify(out).slice(0, 160)}`);
       bad += !!empty;
   }
   process.exit(bad ? 1 : 0);
   ```

   Also call each new tool with a value that must miss, and check it returns `{ error }`
   or `[]`, never a crash.

   An action that touches a browser API (`Audio`, `localStorage`, `navigator.clipboard`)
   needs that API stubbed at the top of the harness, before `registerAgent` runs, e.g.
   `globalThis.Audio ??= class { paused = true; currentTime = 0; duration = NaN;
   addEventListener() {} async play() { this.paused = false; } pause() { this.paused = true; }
   removeAttribute() {} load() {} }`. Stubs prove the action's logic, not the API. Test the
   API's failure modes (e.g. `play()` rejecting with `NotAllowedError`) with a stub that
   throws them, then test the real thing in step 3.
3. **Each UI feature in a real browser**, driven the way a person uses it. Use a real
   click, not `element.click()` from script: script clicks carry no user activation, so
   media and clipboard features fail in a way no person ever sees. The UI and its tool
   must agree: the same inputs give the same records in the same order. Check a phone
   width too. A maximized window ignores resizes, so load the page in a 360px
   same-origin `<iframe>` and check that `scrollWidth <= clientWidth`. **Rebuild after
   every source edit before testing**, or you test the previous build. Also check that
   search still reports meaning, not words, and that the console is clean.
4. Lint the local view if the schema or data changed.

### 5. Ship without disturbing what is bound on chain

The binding is to the card's URL, and readers reject a card whose Fangorn block moved.
Before deploying, diff the new card against the live one. Only `skills` (and `version`,
if you bumped it) may differ:

```sh
curl -s https://<site>/.well-known/agent-card.json > /tmp/live-card.json && npm run card
node -e 'const a=require("/tmp/live-card.json"),b=require("./site/.well-known/agent-card.json");
for (const k of new Set([...Object.keys(a),...Object.keys(b)])) if (!["skills","version"].includes(k) && JSON.stringify(a[k])!==JSON.stringify(b[k])) { console.log("CHANGED", k); process.exitCode=1 }'
```

- **Never change** `url`, `fromBlock`, `name` (`fangorn-mcp` derives the app's tool prefix
  from it; `Audius Search` → `audius-search__…`), `namespaces`, `views` or the extension.
- **Do not rerun `fangorn app agent`.** It always mints a *new* agent (the CLI has no update
  path), so rerunning leaves two agents for one app. The ERC-8004 registration file is a
  snapshot of the card at mint time: name, description, card URL, `a2aSkills` (the union
  of the skills' **tags**, not tool names), and `x402Support` (whether any skill is tagged
  `x402`). New tools that reuse the existing tags leave it accurate. A new tool that adds a
  tag makes `a2aSkills` stale, and a first `x402` tag makes `x402Support` wrong. Tell the
  person before shipping either one; updating the existing agent's file means a
  `setAgentURI` from the owner wallet (agent0-sdk), which the CLI does not do.
- `find site -size +25M` is still empty. Then deploy, with the person's go-ahead.

Then repeat *Before saying it is done* against the deployed site, and add:
- the live card's `skills` lists every new tool, with the tag `webmcp`;
- `open-app <name>` still returns `verified: true`. Its data tools do not include page
  tools; those show only with `page: true` in a WebMCP browser (Chrome 150+ with
  `--enable-features=WebMCP`). Test there if one is available, and say so if not;
- the deployed page's new features work in a browser, not just locally.

### 6. Report

Give the person one table: feature → UI control → tool name → its sample call → how
each was verified (harness, browser, deployed). Name anything left unverified (for
example, "page tools not exercised in a WebMCP browser") rather than implying it
passed. List any chain writes made and the re-embed cost paid.