# westmarch

Follows a set of Fangorn repos into a local, searchable index, and lets agents search it over MCP.

How it works:

1. The indexer keeps a **stitch** over every `publisher/repo` pair you follow. A stitch is a single block that records the head of each of those repos.
2. Each time a followed head moves, the indexer:
   - rebuilds the stitch from the update log, reading only the entries since the last stitch;
   - diffs each repo whose head moved, and embeds the new and changed records with a local model;
   - writes those records and the new stitch to a SQLite file in one transaction.
3. Agents search that file and fetch records live from Fangorn.

Everything runs on your machine: there are no servers to run and no API keys to supply. You need Node 22.13+. `npm i @fangorn-network/westmarch`, or run it from this checkout.

## Run it

```sh
npm install
cp app.example.json app.json      # then put your publishers and repos in it
npm start                         # follow app.json into index.db, live (Ctrl-C to stop)
node src/run.js app.json --once   # or: catch up once, then exit
```

`app.json`:

```json
{ "publishers": ["0x…"], "repos": ["shop"], "network": "baseSepolia", "db": "index.db" }
```

- Every publisher is paired with every repo name.
- `network` is `baseSepolia` (the default) or `arbitrumSepolia`.
- Optional fields: `fromBlock`, `rpcUrl`, `gateway`, `deployment`, `view` (a local JSON file of every record and the stitch, rewritten on each new root) and `publishView` (a repo of the indexer's to publish that view to: storage, plus a `view` record pointing at it). Leave out `publishers` to follow the named repos of every publisher.
- Environment variables `RPC_URL` and `IPFS_GATEWAY` override the config.
- `INDEXER_KEY` signs the stitch blocks the indexer uploads. If you don't set one, a fresh key is generated each run. That's fine, because the indexer's state lives in `index.db`, not with the key.

The first run downloads EmbeddingGemma-300m (about 300 MB) and indexes everything. Later runs resume from `index.db` and only embed what changed. If you change `publishers` or `repos`, the index rebuilds itself. If you switch to a different model, it refuses to run; start a new `db` file instead.

## Sandbox: all of it on your machine

`npm run sandbox` starts a Fangorn that writes nothing to a real chain or to IPFS:

- a fresh anvil, with the contracts deployed from `../contracts` (`FANGORN_CONTRACTS_DIR` points it elsewhere);
- a local stand-in for the upload worker and the IPFS gateway, with blocks stored in `.sandbox/ipfs`;
- funded keys for alice, bob, carol and the indexer.

It needs `anvil` and `forge`. In another terminal:

```sh
mkdir -p /tmp/shop && cd /tmp/shop
echo '[{"id":"t1","name":"oak table"}]' > items.json
~/fangorn/indexer/.sandbox/fangorn repo init shop    # the real fangorn CLI, on the sandbox, as alice
~/fangorn/indexer/.sandbox/fangorn add items.json && ~/fangorn/indexer/.sandbox/fangorn commit && ~/fangorn/indexer/.sandbox/fangorn push
AS=bob ~/fangorn/indexer/.sandbox/fangorn …          # as bob

cd ~/fangorn/indexer
node src/run.js .sandbox/app.json                     # index alice's and bob's "shop"
claude mcp add fangorn-sandbox -- node "$PWD/src/mcp.js" "$PWD/.sandbox/app.json" --watch
```

- `.sandbox/fangorn` runs the CLI with its own `HOME`, so it never reads `~/.fangorn` (your real key and storage).
- `.sandbox/app.json` is a starting config. Any app.json with `"network": "sandbox"` runs on the sandbox; set `"sandbox"` to the sandbox's directory if it isn't `.sandbox`.
- Each start is a fresh chain with fresh keys, so delete `index.db` when you restart.

`node examples/memory.js` runs an experiment on a running sandbox: agents that don't know each other share memory, and apps form over it. Agents with no ETH write through a relayer. Two apps follow different sets of publishers, a stranger replays and verifies one of them, and a citation goes stale. It prints the txs, gas, bytes and embeds behind each step.

`node examples/game.js` plays a game with no game server. Each player writes moves to its own repo, and the board is a pure reducer over the chain's log ([src/fold.js](src/fold.js)). A referee publishes a checkpoint (a stitch plus a state hash), and a spectator verifies it without trusting the referee. `node examples/scale.js 8,32,128` measures what grows as publishers are added.

## On Cloudflare: [worker/](worker/)

The same indexer as one Worker, configured by its `CONFIG` var: what it follows, on which network, and where it publishes its view. One codebase, many deployments at different levels: fangorn.network follows repos across publishers to make them discoverable, while an app follows its own repos to index the records inside them.

- **Cron, every minute.** One log read, filtered by repo name on chain, asks whether any followed repo moved. If one did, the Worker restitches from the saved stitch ([src/stitcher.js](src/stitcher.js)) into D1 ([src/d1.js](src/d1.js)). Records land without vectors, and Workers AI (EmbeddingGemma-300m, the model the local index uses) embeds up to 100 of them per run.
- **Publishing the view.** With `CONFIG.publishView`, each new root's view also goes to Fangorn: storage, plus a `view` record in that repo. A static page hosted anywhere finds it on chain, and anyone can check its stitch with `verifyStitch`.
- **`GET /view.json`** is the view. **`GET /search?q=`** ranks records by meaning, embedding the query with the same model, so a page needs no in-browser model. Everything else goes to `ASSETS` when one is bound (an app's static site).
- **`POST /mcp`** is MCP over streamable HTTP, stateless: `claude mcp add --transport http <name> https://<worker>/mcp`. Its tools are `search`, `repos` and `get`.
- **`INDEXER_KEY`** (a secret) signs the stitch blocks the Worker uploads and the view commits, and pays their gas.

Deploy it as is, with no code: copy [worker/wrangler.example.json](worker/wrangler.example.json) into a project that depends on westmarch, then:

```sh
wrangler d1 create my-indexer                      # put its id in wrangler.json
node node_modules/@fangorn-network/westmarch/worker/seed.js index.db > seed.sql && wrangler d1 execute my-indexer --remote --file seed.sql
wrangler deploy
node -e 'import("viem/accounts").then(m => process.stdout.write(m.generatePrivateKey()))' | wrangler secret put INDEXER_KEY   # then fund its address
```

The seed is a local index's stitch and records, without vectors. It saves the Worker its first catch-up over the whole update log, which takes more requests than one run is allowed.

An app adds its own MCP tools, or replaces a base one by name, with a Worker of its own:

```js
import { indexer } from "@fangorn-network/westmarch/worker";
import { BASE } from "@fangorn-network/westmarch/worker/mcp";
import { publishAs, grantOf, signerFor } from "@fangorn-network/westmarch/worker/publisher";

export default indexer({
    name: "my-app",
    instructions: (gateway) => `How an agent should use my app. Files load from ${gateway}/ipfs/<src>.`,
    tools: [{ name: "publish", description: "…", inputSchema: { … }, async run(args, ctx) { /* ctx: index, fangorn, gateway, auth, origin, env */ } }],
});
```

`worker/publisher.js` publishes a record into a person's own repo on their signature, through the grant they gave the app at fangorn.network. The app relays the commit, and holds no keys of theirs.

## Give it to an agent

`src/mcp.js` is an MCP server that talks over stdio. It has three tools:

| tool | |
|---|---|
| `search` | Finds records by meaning (`semantic`), by words (`lexical`, BM25), or both (`hybrid`, the default, merged by reciprocal rank). It can filter by `publisher`, `repo` and `type`. Each hit has `publisher, repo, id, cid, type, payload, score`. |
| `repos` | Lists what's in the index: each publisher, repo name, and record count. |
| `get` | Fetches one record's current version live from Fangorn (chain and IPFS). |

To run the indexer and the server in one process, which is the simplest setup:

```sh
claude mcp add westmarch -- node "$PWD/src/mcp.js" "$PWD/app.json" --watch
```

Without `--watch`, the server only reads `index.db`, and a separate `npm start` keeps it up to date. SQLite's WAL mode lets both processes use the file at once.

## Layout

| file | |
|---|---|
| [src/stitcher.js](src/stitcher.js) | `stitcher`: `update` / `trigger` (coalesced), with an injected `store` and `lens`; `watchHeads`: one subscription to the update log |
| [src/sqlite.js](src/sqlite.js) | `sqliteIndex`: the store, the lens, and `search`, all over one SQLite file |
| [src/store.js](src/store.js) | other stores: `fangornStore` (saves the stitch on Fangorn) and `memoryStore` |
| [src/embed.js](src/embed.js) | `localEmbedder` (EmbeddingGemma, in-process) and `textOf` |
| [src/run.js](src/run.js) / [src/mcp.js](src/mcp.js) | the runner and the MCP server, each usable as a module or a CLI |
| [src/client.js](src/client.js) | creates the SDK client from a config |
| [src/fold.js](src/fold.js) | `fold`: shared app state, a pure reducer over the update log of the repos a set of patterns follows; resumable, and stoppable at a stitch |
| [src/d1.js](src/d1.js) / [worker/](worker/) | the index on Cloudflare D1 (store, lens, view, search by meaning), and the Worker that runs it on a cron with Workers AI, its MCP tools, and publishing as a person |
| [src/gemma.js](src/gemma.js) | EmbeddingGemma: the model, the prompts, matryoshka truncation and vector packing |
| [src/sandbox.js](src/sandbox.js) | the local sandbox: anvil, the contracts, and `storageServer` (the upload worker and gateway, locally) |

A lens is anything with `apply(changes)`, where `changes` is `[{ publisher, repo, from, to }]`. An embedder is `{ id, embed(texts), query(text) }`.

## Tests

```sh
npm test                    # in memory: an in-memory chain, a fake embedder, :memory: SQLite
EMBED_LOCAL=1 npm test      # also runs the real model
```

[src/e2e.test.js](src/e2e.test.js) covers the whole path: publish, then the runner follows it, then an agent searches and fetches over MCP.
