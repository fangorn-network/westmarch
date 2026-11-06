# From nothing to a running Fangorn app

This walks an app owner from an empty directory to a live app that people can use in a
browser and any agent can find, verify and query. By the end you have:

- **an app**: a repo under your wallet, `<your address>:<app>`; repo names are per publisher, so there is nothing to claim;
- **a schema** in `app.json`: what your data's types are, which field is what, and
  which relations are allowed between them;
- **your data** committed on chain into that repo;
- **a view** of it: your committed data embedded and sharded as static files, so people
  and agents can search it by meaning, updated with one command after each commit;
- **a site**: the view, a page for people, and an MCP endpoint for agents (one Cloudflare
  Worker, deployed by `westmarch-ship`);
- **an agent card** bound to the app on chain (the repo's `@card` record), and registered as an ERC-8004 agent;
- **agents finding it:** the Fangorn explorer indexes every publisher, so `fangorn-mcp`'s
  `search` finds your records and names you as their publisher.

Where the data comes from is up to you. The guide starts from a JSON array of objects,
which anything can produce: a scraper, a database export, a converted spreadsheet.

```
 sources ─► fangorn commit/push ─► chain (<you>:<app>)
                                      │
 app.json (types) ─► the Worker's CONFIG
                                      ▼
 the Worker's cron ─► embeds what changed ─► view in R2 ─► page, /mcp, data tools
                                      │
 westmarch-ship ─► card at <site>/.well-known/agent-card.json
              └─► fangorn card <url> --repo <app> ─► the repo's @card = card URL, + ERC-8004 agent
                                      │
 the explorer (indexes every publisher) ◄── fangorn-mcp: search, publishers, get, buy
```

Everything runs on Base Sepolia: `"network": "baseSepolia"` in `app.json`.

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
  "sources": [{ "namespace": "things", "command": ["python", "-m", "my_source"] }],   // your wallet's repos only
  "live": ["readings"],                      // optional: namespaces other wallets push to; "0x<wallet>/readings" for one wallet's
  "network": "baseSepolia",                  // required
  "fangorn": "fangorn",                      // the CLI that signs
  "paid": { "price": "0.01", "description": "the full record" }   // optional: USDC on the app's network, x402 v2
}
```

```sh
npx westmarch-ship app.json            # repo, crawl + publish, site, card, deploy, agent
npx westmarch-ship app.json --dry-run  # every step, printed, none done
npx westmarch-ship app.json --no-crawl # rebuild view, site and card from what is on chain
npx westmarch-ship app.json --replace  # each source's crawl becomes its namespace's whole state
npx westmarch-ship app.json --index    # build the deployed app's view once, on this machine
```

The app is one Cloudflare Worker: a cron that indexes the chain into R2 (embedding with
Workers AI), the view, `/mcp`, and the page. What `ship` does, in order:

1. **create the app's repo** (`fangorn repo init <app>`) on the first run, and record that block as the card's `fromBlock` when the app already presents repos (otherwise, at `--register` or for an app presenting every repo, the deployment's start);
2. **run each source**: a command that publishes into `--namespace` when given `--publish`.
   A source with `"each": "rows.json"` is a template,
   one source per row (`{field}`, `{field|slug}`, `{args...}`), so adding a town, a feed or
   an account is adding a row;
3. **the site** in `.ship/site`: the stock page (search, plus a feed of what is coming up and
   what just happened, by the `temporal` role and the first `facets` field; for rows that are
   not meetings, an explore page: `site.examples` as searches to try, the latest records by
   `temporal`, and each declared facet's values to browse), the agent card,
   `/openapi.json` and `/.well-known/x402` when anything is for sale, and `_headers`;
4. **deploy the Worker** (`wrangler deploy`): its R2 bucket (created if missing), Workers AI,
   the cron (`site.cron`, default every 5 minutes) and its CONFIG, which carries the schema. With `paid`, it sells each
   record over x402; only records whose sha256 a live row carries are for sale. If the app
   has no view yet, ship builds the first one here (`--index`) rather than wait for the cron;
5. **bind the card** (`fangorn card <url> --repo <app>`): the repo's `@card` record names the
   card URL, and an ERC-8004 agent is minted from the card. Only when `@card` points
   elsewhere; an agent is minted once, later runs only rebind.

State lives in `.ship/` next to `app.json`. In CI, cache `.ship/cache` and `.ship/stage`
and commit `.ship/state.json`.

## A private app: the data is the product

`"private": { "pass": { "price": "5", "days": 30 }, "call": "0.01" }` in `app.json`, settled like
`paid` (`network`, `payTo`, `asset`, `facilitator`). What changes:

- **Real money.** Settlement is set apart from the app's chain: `"network": "base"` in `private`
  (or `paid`) charges USDC on Base while the app and its agent stay on Base Sepolia, where the
  Fangorn contracts are. Set `payTo` to a wallet you control and have backed up; it defaults to
  the owner key ship signs with. On a mainnet the page's button opens Privy's card funding
  (enable it in the Privy dashboard) instead of the faucet. Try a low price first.

- **Storage.** Each source stages its records (it needs `--output-dir`); ship seals every row whole,
  `{sealed: base64(nonce ‖ AES-256-GCM(rowKey, row))}` with rowKey = HMAC-SHA256(PAID_SECRET,
  "fangorn.row.v1"), and commits that. The nonce is derived from the row, so an unchanged row keeps
  its CID and is not re-embedded. PAID_SECRET is `$PAID_SECRET` or made once in `.ship/secret`:
  **back it up**, it is the only way to open the rows.
- **Index.** The Worker (which ship gives the secret on every deploy) opens rows in its cron and
  builds the view in R2 as for any app. `--index` does the same once on your machine
  (`wrangler dev` against the app's own R2 and Workers AI), for the first view or a catalog too
  big for one cron run.

### The indexer's limits

The Worker's cron is bounded so one large repo can't take down the app (or every app on the
account). `site.limits` in `app.json` overrides any of these:

| limit | default | why |
|---|---|---|
| `embedPerRun` | 2000 | rows one run embeds, across every repo; the rest wait for the next run |
| `embedPerDay` | 10000 | rows a UTC day embeds (~3,400 Workers AI neurons). The free allowance is 10,000 neurons a day for the **whole account**, and search's own queries use it too |
| `checkpoint` | 256 | rows between saves, so a run killed for memory or CPU redoes at most this many |
| `concurrency` | 2 | repos read at once; each read holds the whole repo in memory |
| `strikes` | 2 | runs that die inside one repo at one head before the cron skips it until its head moves |

A repo too big for a Worker (reading it holds every record: ~50k records is past 128 MB) gets
skipped after `strikes` dead runs, and its last view stays. `westmarch-ship app.json --index`
runs the same Worker on your machine, without the memory cap, and reads it. The daily budget
still applies there.
- **Serving.** `/view/*` (but `cdn/catalog`) and every MCP tool but `describe` need access: a pass
  (`POST /pass`, x402 v2, a bearer token good for `days`) or one x402 payment per tool call over
  x402's MCP transport (`_meta["x402/payment"]`). A call that fails or misses is not charged.
  An agent pays with any x402 client pointed at the app's `/mcp`.
- **Discovery.** The card's Fangorn extension carries `access` (pass URL and prices), and its
  skills are tagged `x402`, so the ERC-8004 registration says `x402Support: true`.
  `/openapi.json` and `/.well-known/x402` list `POST /pass` for x402scan; the facilitator's Bazaar
  lists `/pass` and each tool (as `type: "mcp"`, resource `<app>/mcp`) after its first sale, so make
  one paid call yourself (paying from `payTo` is accepted). Check with
  `curl "https://facilitator.payai.network/discovery/resources?payTo=<payTo>"`. Mainnet agents find
  the app here, since its ERC-8004 registration is on Base Sepolia.
- **The page.** Without a pass it shows what is inside (the free catalog and `describe`: how many
  records, when they were updated), a "Get a pass" button (Privy sign-in, then x402; on a testnet
  it links the faucet when the balance is short), and the lines to add the app to an agent
  (`#/agents`). The pass is kept on the device and sent with every read, and the agent line
  carries it too. Add the app's origin to Privy's allowed origins.

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
The same predicate as `of` scopes a check to some rows: on a `records` or `coverage` check
it narrows what is counted, and on a search check it narrows what is searched, to match a
surface that filters (a page tab for people, a type an agent tool reads), so one type of
record growing cannot crowd the questions another surface answers.
Without labels, it also searches 200 sampled rows by their own titles (`known@1`, `known@10`).

Worse is: mean precision or `known@10` down more than 0.05, any question the base
answered now answered by nothing, a `hard` record check rising, or any floor or ceiling
missed. Run it in CI on every pull request, from the records and vectors a scheduled
`westmarch-ship` leaves in its cache, with no secrets; make it a required check on `main`, and put `eval/`, `.github/` and `app.json` under `CODEOWNERS`,
or a PR can change the gate along with what it gates.

What is not graded yet: a change to how a source *parses*. `--local` reads what the
sources last staged; it does not replay their parsing over the raw documents.

## How agents find your data

Through the **Fangorn explorer** (`https://explorer.fangorn.network`), the app that indexes
every publisher. Once your records are pushed, its next index run (every few minutes) picks
them up, and anyone running `fangorn-mcp` finds them with `search`, sees your repos under
`publishers`, and buys what you sell with `buy`. You register nothing for this: being a
publisher is enough. [docs/mcp.md](mcp.md) has the setup.

Your app's own Worker still serves its page and its own MCP endpoint at `/mcp`, with your
schema and your tools, for agents that come to your app directly.

## Discovering apps in code

An app is a publisher's repo whose `@card` record points at an agent card that points back.
`discoverCard(cardUrl)` accepts a card only if:

- the card carries the Fangorn repo extension for **this** chain and **this** DataRegistry,
  naming a publisher and a repo, and
- that repo's `@card` on chain is **exactly** the card URL.

**From a card URL:**

```js
import { Fangorn } from "@fangorn-network/sdk";
import { generatePrivateKey } from "viem/accounts";
// Fangorn.create needs a signer; a throwaway key is fine for reading.
const fangorn = Fangorn.create({ privateKey: generatePrivateKey() });
const { card, publisher, repo } = await fangorn.discoverCard(cardUrl);
```

**From ERC-8004** (for general-purpose agents that know nothing about Fangorn):

```js
const api = "https://8004scan.io/api/v1/agents";
const { items } = await (await fetch(`${api}?chain_id=84532&search=My%20App`)).json();
const detail = await (await fetch(`${api}/84532/${items[0].token_id}`)).json();
const found = await fangorn.discoverCard(detail.services.a2a.endpoint);
```

**The committed data itself:**

```js
const { contents } = await fangorn.readRepo(publisher, repo);
```

## What the binding proves, and what it doesn't

- **Proves:** the repo's publisher chose this card URL. Anyone can serve a card naming any
  repo, and `discoverCard` rejects it unless the repo's `@card` points back at that exact
  URL. This is tested in the SDK (`src/discover-card.test.ts`, `src/e2e/cards.e2e.test.ts`).
- **Doesn't prove:** that the page behind `card.url` behaves as described, or that the card
  wasn't changed after binding. The card is live HTTP, not content-addressed, and the
  binding is to the URL. That's deliberate: the card is mostly endpoints, which change, and
  pinning each version would cost a transaction for nothing. The data's integrity comes
  from the commits and the shard digests, not from the card.

## Gotchas

| symptom | cause |
|---|---|
| card rejected as not bound | URLs must match exactly. A trailing slash, `http` vs `https`, or a different path counts as a different card. |
| card rejected after a rebuild | the build dropped the `fangorn` block or changed `fromBlock`/`url`; keep them fixed |
| discovery works in Node, fails in a browser | no `Access-Control-Allow-Origin` on the card |
| `fangorn card`: "ERC-8004 registration pins the registration file to IPFS" | no Pinata JWT in `fangorn init` |
| `fangorn card` signs as the wrong wallet | `~/.fangorn/config.json` beats `ETH_PRIVATE_KEY` |
| `fangorn card`: "replacement transaction underpriced" | a nonce race after the mint; the agent exists, so rerun with `--skip-register` |
| the 8004 registration says `x402Support: false` | no card skill is tagged `x402`; rebuild the card, then `fangorn card <card> --repo <app> --update <agentId>` |
| a private app's page says the data is still being indexed | the cron hasn't run yet; `westmarch-ship app.json --index` |
| search on the page matches words, never meaning | the bundler pre-bundled westmarch; `optimizeDeps.exclude` it |
| an agent's first call returns empty, later calls work | the tools registered before their data loaded |
| an agent opens the page and finds no tools | `card.url` is not the page that registers them |
| `search` ignores what records say, or titles are ids | the type isn't declared in the schema, so its roles were guessed; declare it in `app.json` |
| a schema change didn't change search results | records keep the text they were embedded with; only newly embedded records use the new `text` role |
| the view is empty after a push | the Worker's cron hasn't run yet (`westmarch-ship app.json --index`), or the push hasn't landed (`fangorn status`) |
| a repo stays out of the view; the Worker log says "skipped; N runs died indexing it" | it is too big for a Worker's 128 MB (reading a repo holds it whole: ~4 KB a record, 50k records is ~200 MB); `westmarch-ship app.json --index` reads it on your machine |
| the view fills a few thousand rows a day | the indexer's embedding budget (`site.limits`, default 2,000 a run and 10,000 a day); raise `embedPerDay` if the account's Workers AI allowance has room |
| search matches words only; the page says the embedder is unavailable | the account's Workers AI allowance (10,000 neurons a day, shared by every app on it) is spent; it resets at 00:00 UTC |
| `westmarch-view`: "vectors from two encoders are not comparable" | the view was built by another embedder; `--rebake`, or keep publishing it with that tool |
| lint: "nowhere to go" | no `presentation.externalUrl` in the schema, so a hit links nowhere |
| `fangorn-mcp`: "this browser has no WebMCP" | page tools only: the browser lacks `document.modelContext`; it needs Chrome 150+ with `--enable-features=WebMCP` |
| `fangorn-mcp`: "no browser: cannot launch google-chrome" | page tools only: no local Chrome; set `FANGORN_MCP_CDP` |
| IPFS reads return "switching to a service worker gateway" | ipfs.io stopped serving raw content; use a Pinata gateway |
| the page isn't listed as a "Web" service on 8004scan | agent0-sdk has no web endpoint type; agents find the page through the card's `url` |
