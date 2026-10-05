# Querying Fangorn apps with `fangorn-mcp`

`fangorn-mcp` is one MCP server for every Fangorn app. It reads the list of apps
from the chain, checks each app's agent card, and gives your agent tools to search
the app's data. It needs no account, API key or wallet. You only need a wallet if
you buy paid records.

You need **Node 20 or later**. Chrome is optional (see [Page tools](#page-tools)).

## Install

### Claude Code

```sh
  claude mcp add fangorn -e FANGORN_LOG_WINDOW=100000 -- \
    npx -y -p @fangorn-network/westmarch -p @huggingface/transformers fangorn-mcp
```   

Then run `/mcp` in Claude Code and check that `fangorn` shows as connected.

- `@huggingface/transformers` lets `search` rank results by meaning. It is about 500 MB.
  Leave out `-p @huggingface/transformers` for a lighter install; `search` then
  matches words instead.
- `FANGORN_LOG_WINDOW=100000` makes `list-apps` take about 2 seconds. Without it,
  `list-apps` takes more than 2 minutes, because it reads the chain 1,000 blocks at a time.

### Any other MCP client

```json
{
  "mcpServers": {
    "fangorn": {
      "command": "npx",
      "args": ["-y", "-p", "@fangorn-network/westmarch", "-p", "@huggingface/transformers", "fangorn-mcp"],
      "env": { "FANGORN_LOG_WINDOW": "100000" }
    }
  }
}
```

The first start downloads the packages, so it can take a minute. Later starts use npm's cache.

## Use it

Ask your agent for Fangorn apps, or call the tools yourself:

1. **`list-apps`** lists the apps whose cards pass the check, with a description and
   tool list for each one.
2. **`open-app`** with `{ "app": "kingsfoil" }` adds that app's tools as `<app>__<tool>`.
   For example, it adds `kingsfoil__search` and `kingsfoil__get`.
3. You can then call those tools. Most apps have these:
   - `describe`: what the app holds
   - `search`: find records matching a query
   - `get`: fetch one record
   - `similar`: records like a given one
   - `count`: count the values of a field
   - `browse`: list records without a query

   If your client does not pick up new tools, call **`call-app-tool`** with the app, the
   tool and its arguments.

Here is an example of what you can ask:

> List the Fangorn apps, open nimbus, and find tornado warnings in Oklahoma this week.

## Page tools

Some apps also have tools that run inside their web page. To get them, call
`open-app` with `"page": true`. This starts headless Chrome, which uses about 2 GB of memory.

- Chrome must be installed as `google-chrome`, or you can set `CHROME=/path/to/chrome`.
- To use a browser that is already running, pass `--cdp ws://host:9222` or set `FANGORN_MCP_CDP`.

You don't need page tools to query an app's data.

## Settings

| Env var / flag | Default | What it does |
|---|---|---|
| `FANGORN_LOG_WINDOW` | `1000` | Blocks read per chain request in `list-apps`. Set it to `100000`. |
| `FANGORN_MCP_WALLET_KEY` | none | Private key that pays for paid records (`<app>__buy`, x402). Use a separate wallet with only a little in it. |
| `FANGORN_MCP_MAX_PRICE` | `0.10` | Most `buy` will pay for one record, in USDC. |
| `FANGORN_MCP_CDP` / `--cdp` | local Chrome | Browser used for page tools. |
| `CHROME` | `google-chrome` | Chrome binary used for page tools. |
| `--headed` | off | Show the Chrome window instead of running headless. |
| `--from-block <n>` | registry deploy block | Block to start the app scan from, for other deployments. |
| `FANGORN_MCP_TRACE=1` | off | Print step timings to stderr. |

## Run from source

Use this to test local changes:

```sh
git clone git@github.com:fangorn-network/westmarch.git
cd westmarch
npm install
claude mcp add fangorn -e FANGORN_LOG_WINDOW=100000 -- node "$PWD/src/agent/mcp.js"
```

No build step is needed. The server runs `src/agent/mcp.js` directly. After you pull
changes or upgrade `@fangorn-network/sdk`, reconnect the server (`/mcp` → reconnect).
A server that was already running keeps the old code.

## Single-file binary (maintainers)

`build-bin.js` builds one executable that includes the search model, so users don't
need Node. It is **not published yet**: there is no GitHub release and no
`@fangorn-network/fangorn-mcp` on npm. Until one exists, use the npm install above.

To build it, you need bun 1.2 or later (1.1 miscompiles top-level await) and `npm install` first:

```sh
bun build-bin.js                 # this machine → dist/fangorn-mcp-<os>-<cpu>
bun build-bin.js all --npm 0.0.6 # linux-x64, linux-arm64, darwin-arm64 + npm packages in npm/
```

To publish, run the platform packages first and then the launcher:

```sh
for d in npm/fangorn-mcp-*/ npm/fangorn-mcp/; do (cd $d && npm publish --access public); done
```

After that, users can install with `claude mcp add fangorn -- npx -y @fangorn-network/fangorn-mcp`.

## Troubleshooting

- **`list-apps` hangs for minutes:** `FANGORN_LOG_WINDOW` is not set.
- **`... is not a function` right after an upgrade:** the server is still running the
  old code. Reconnect it.
- **`embedder unavailable, searching by words`:** add `-p @huggingface/transformers`.
- **`no browser: cannot launch google-chrome`:** only page tools need Chrome. Install it,
  or set `CHROME` or `FANGORN_MCP_CDP`.
- **`unverified: N` in `list-apps`:** those apps' cards did not match their on-chain
  binding, so they are hidden.
