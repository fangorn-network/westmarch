# Querying Fangorn apps with `fangorn-mcp`

`fangorn-mcp` is one MCP server for every Fangorn app. It reads the list of apps
from the chain, checks each app's agent card, and gives your agent tools to search
the app's data. Each app answers from its own MCP server (its Worker at `/mcp`),
so nothing is downloaded and no browser runs. It needs no account, API key or wallet.

You need **Node 20 or later**.

## One app, no install

Every app serves its own MCP endpoint at `<app url>/mcp` (its agent card names
it as `mcp`). Add it as a remote server, for example in Claude Code:

```sh
claude mcp add --transport http my-app https://my-app.example/mcp
```

`fangorn-mcp`, below, is for every app at once.

## Install

### Claude Code

```sh
  claude mcp add fangorn -- \
    npx -y -p @fangorn-network/westmarch -p @huggingface/transformers fangorn-mcp
```

For the apps still on Arbitrum Sepolia instead of Base Sepolia, add `-e FANGORN_NETWORK=arbitrumSepolia`
before `--`. One server reads one network.

Then run `/mcp` in Claude Code and check that `fangorn` shows as connected.

- `@huggingface/transformers` lets `find-apps` rank apps by meaning. It is about 500 MB.
  Leave out `-p @huggingface/transformers` for a lighter install; `find-apps` then
  matches words instead. Searching inside an app is the app's own server's job.

### Any other MCP client

```json
{
  "mcpServers": {
    "fangorn": {
      "command": "npx",
      "args": ["-y", "-p", "@fangorn-network/westmarch", "-p", "@huggingface/transformers", "fangorn-mcp"],
      "env": { "FANGORN_NETWORK": "baseSepolia" }
    }
  }
}
```

The first start downloads the packages, so it can take a minute. Later starts use npm's cache.

## Use it

Ask your agent for Fangorn apps, or call the tools yourself:

1. **`list-apps`** lists the apps whose cards pass the check, with a description for
   each one. **`find-apps`** ranks them for a question.
2. **`open-app`** with `{ "app": "kingsfoil" }` adds that app's tools as `<app>__<tool>`.
   For example, it adds `kingsfoil__search` and `kingsfoil__get`. The tools are those
   of the MCP endpoint the app's card names (`mcp`), and every call goes to it. An app
   whose card names none cannot be opened.
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

## Settings

| Env var / flag | Default | What it does |
|---|---|---|
| `FANGORN_NETWORK` | `baseSepolia` | The network whose apps to list and open: `baseSepolia` or `arbitrumSepolia`. |
| `FANGORN_LOG_WINDOW` | the network's | Blocks read per chain request. Only for a private RPC that takes wider ranges than the public one. |
| `--from-block <n>` | registry deploy block | Block to start the app scan from, for other deployments. |
| `FANGORN_MCP_TRACE=1` | off | Print step timings to stderr. |

## Run from source

Use this to test local changes:

```sh
git clone git@github.com:fangorn-network/westmarch.git
cd westmarch
npm install
claude mcp add fangorn -- node "$PWD/src/agent/mcp.js"
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

- **`list-apps` hangs for minutes:** `@fangorn-network/sdk` is older than `2026.10.20-dev`,
  which reads each network's log window from its config.
- **`list-apps` is empty but the app is live:** it is on the other network; set `FANGORN_NETWORK`.
- **`... is not a function` right after an upgrade:** the server is still running the
  old code. Reconnect it.
- **`embedder unavailable, searching by words`:** add `-p @huggingface/transformers`.
- **`... has no MCP server`:** the app's card names no `mcp` endpoint, so there is
  nothing to call. The app has to deploy its Worker.
- **`unverified: N` in `list-apps`:** those apps' cards did not match their on-chain
  binding, so they are hidden.
