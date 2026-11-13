---
name: fangorn-app
description: Build an app on Fangorn with @fangorn-network/sdk — data as typed records in repos, published by the app or by its users with their own signatures; a Cloudflare Worker that follows those repos across every publisher, searches them by meaning and serves them to agents over MCP; and an agent card that lists the app in Fangorn's registry. Use when someone wants to put data, a catalog, a game, a feed or a community "on Fangorn", build an app or MCP server over Fangorn repos, let users publish without holding keys or gas, or get a repo found by agents.
---

# Building an app on Fangorn

**What an app is.** Records in repos, and something that reads them.

- A **repo** is `publisher/name`: one address's set of records. Only that address can change it; every change
  is a signed commit anchored on chain (Base Sepolia, DataRegistry `0x0F3eb0E62CF610dbaC6B3aD4Bf4cE38Ab50EBCC5`).
- An app usually picks one repo **name** (say `arcade`) and reads that repo across **every** publisher. A new
  publisher joins by publishing; nobody registers them.
- Reading needs no server and no key. A Worker comes in when you want search, an MCP server, or to publish
  for your users.

Build on `@fangorn-network/westmarch`: the indexer (`src/`) and a configurable Cloudflare Worker (`worker/`).
The reference app is the internet slop warehouse (the `internet-slop-warehouse` repo), a Worker that wraps
westmarch's with its own MCP tools. Copy from it rather than inventing.

## 0. Start from what the person wants found

Ask what people (and agents) will look for, and what one record is. Write three or four real queries down;
they decide the record shape, and they're how you check the result at the end.

## 1. Model the data as records

A record is `{ id, type, payload }`. `id` is unique in the repo (lowercase-dashed is easiest). `payload` is JSON.

- **Search matches every payload leaf as `path: value`.** Labels are the search: a good `title`,
  `description` and `tags` matter more than anything else. Put what a searcher would say in the payload.
- **Files** go to storage and the record holds the CID: `src`. Hosted storage takes JSON, so wrap text
  (`{ html }`, `{ js }`); raw bytes are fine for images, audio, models. Files are served at
  `https://ipfs-test.fangorn.network/ipfs/<cid>` with open CORS.
- **Pin what you build on**: `{ publisher, repo, id, cid }`. The `cid` is the exact version, so a later edit
  upstream never changes yours (`parent` for a remix, `uses` for parts).
- Keep each type's shape stable; readers depend on it. Add fields, don't rename them.

## 2. Publish

```js
import { Fangorn, BaseSepoliaConfig } from "@fangorn-network/sdk";   // ^0.1.5
const fangorn = Fangorn.create({ privateKey, config: BaseSepoliaConfig, storage: { signedUrl: {} } });
await fangorn.initRepo("arcade");                                    // once; a no-op after
const src = await fangorn.getStorage().putFile(new TextEncoder().encode(JSON.stringify({ html })), "coin-rush.json"); // a file → its CID
const { txHash, recordCids } = await fangorn.uploadBatch("arcade", [{ id: "coin-rush", type: "game", payload: { title, description, tags, src } }]);
const back = await fangorn.engine.readRecord(fangorn.getAddress(), "arcade", "coin-rush"); // check it landed
```

- `uploadBatch` is one commit, one transaction, for many records. The key's address needs a little Base
  Sepolia ETH; or sign with `signPush(repo, commitCid)` and let anyone `relayPush` it, paying the gas.
- **Always read back** after publishing (`readRecord`, compare `cid` with `recordCids[id]`): a reverted
  transaction must not pass silently.
- The `fangorn` CLI (`fangorn repo init`, `add`, `commit`, `push`) does the same from a shell.

## 3. Follow and search (the app's Worker)

To list or search one repo name across every publisher, keep a **stitch**: one block recording the head of
every repo you follow, updated from the chain's update log.

```js
const next = await fangorn.restitch(["arcade"], prev);       // folds only the log since `prev`
for (const { publisher, repo, head } of await fangorn.stitchHeads(next)) { /* moved? */ }
const { puts, deletes } = await fangorn.engine.repoDiff(oldHead, newHead); // what changed in one repo
```

Take this from westmarch: `src/stitcher.js` (the follow loop), `src/d1.js` (records in D1, embedded with
Workers AI EmbeddingGemma-300m, search by cosine), `worker/index.js` (a cron every minute, `/view.json`,
`/search`, `/mcp`, the static site via ASSETS). Deploy it as is, configured by `CONFIG`, or wrap it:
`export default indexer({ name, instructions, tools })` from `@fangorn-network/westmarch/worker`. Patterns: `"arcade"` (every publisher's), `"0x…/arcade"` (one), `"*"`.

The Worker's MCP server is a stateless JSON-RPC handler on `POST /mcp` (`worker/mcp.js`): `search`, `repos`,
`get`, plus the app's own `tools` (a `publish` if users publish), each `{ name, description, inputSchema, run(args, ctx) }`. Its `instructions` should teach an agent how to build on the data.

## 4. Let people publish as themselves

Users never give you a key. They connect once at fangorn.network, and you get a token that can only ask
Fangorn to sign updates to the repos they allowed:

1. Link them to `https://fangorn.network/#/connect?app=<your origin>&name=<shown name>&repos=arcade&mcp=<your /mcp>`.
   They sign in with email and allow your app; the page shows a `claude mcp add … --header "Authorization: Bearer fgn_…"`
   command (or the bare token without `mcp`).
2. Your Worker builds the commit on their head and asks Fangorn to sign it: `GET https://fangorn.network/api/grant`
   (whose token it is) and `POST https://fangorn.network/api/sign { message }`.
3. Check the signature recovers to them, `relayPush` it (your key pays the gas), read it back.

`@fangorn-network/westmarch/worker/publisher` (`publishAs(…, repo, record)`, `grantOf`, `signerFor`) is all of it. Nothing to configure at Fangorn,
per app. Limits: 100 signatures a day per grant; only the repos the person allowed.

## 5. Get listed

Fangorn's registry (`fangorn.network/mcp`, the `fangorn-index` plugin) lists every repo by name already.
To be found by what it's about, bind an **agent card** (A2A) to the repo:

```js
import { FANGORN_REPO_EXTENSION } from "@fangorn-network/sdk";
const { caip2, dataRegistryContractAddress } = fangorn.getConfig();
const card = { name, description, url: appUrl, skills: [{ id, name, description, tags }],
  capabilities: { extensions: [{ uri: FANGORN_REPO_EXTENSION, params: { chainId: caip2, dataRegistry: dataRegistryContractAddress, publisher: fangorn.getAddress(), repo: "arcade" } }] } };
```

Serve it (your Worker's `/.well-known/agent-card.json`, or put it in storage and use its gateway URL), then
`fangorn.setCard("arcade", cardUrl)` — or `fangorn.registerAgent(cardUrl, { repo: "arcade", mcp })` to also mint
an ERC-8004 agent. The registry only keeps a card that names this publisher, repo and registry; it shows up
within a minute or two (`find` / `repo` with the fangorn MCP). Name your MCP endpoint and site in the card.

## Rules

- **Chain writes and deploys are the person's call.** Show what will be published (it is public and
  permanent; history stays even after a delete), and do it on their yes.
- **Never print secrets.** Private keys, app secrets and `.env` files stay out of output, logs and commits.
  Mask before showing anything that might hold one.
- Test without a chain: `memoryNetwork()` from `@fangorn-network/sdk/lib/test/testbed.js` gives clients on an
  in-memory registry (`restitch`, `uploadBatch`, `readRecord` all work). Then Base Sepolia.
- **Done means checked:** run the queries from step 0 against the live app, and `find` it in the registry.
