# Finding data on Fangorn with `fangorn-mcp`

`fangorn-mcp` is one MCP server for all of Fangorn. It reads the view of the **Fangorn
explorer** (`https://explorer.fangorn.network`), the app that indexes every publisher's
records, so your agent can search what any publisher has published, see who publishes
what, read a record, and buy one that is sold. **Search runs on your machine**: the server
downloads the explorer's view and searches it locally, so no query is ever sent to Fangorn
or anyone else. It never reads the chain to find anything. It needs no account or API key,
and a wallet only to buy.

You need **Node 20 or later**.

## One app, no install

Every app built with westmarch also serves its own MCP endpoint at `<app url>/mcp`. Add it
as a remote server, for example in Claude Code:

```sh
claude mcp add --transport http my-app https://my-app.example/mcp
```

The explorer is such an app: `https://explorer.fangorn.network/mcp` works the same way, but
it searches on the explorer's side, so the explorer sees your queries. `fangorn-mcp`, below,
searches locally, and adds publisher listing, buying and publishing.

## Install

### Claude Code plugin

```sh
claude plugin marketplace add fangorn-network/westmarch && claude plugin install fangorn-index@fangorn
```

This adds the `fangorn` server and the `fangorn-index` skill. The server reads its settings
(below) from the environment Claude Code starts in, so set them in your shell, not in a
config file.

### Claude Code, by hand

```sh
claude mcp add fangorn -- npx -y -p @fangorn-network/westmarch fangorn-mcp
```

Then run `/mcp` in Claude Code and check that `fangorn` shows as connected.

### Any other MCP client

```json
{
  "mcpServers": {
    "fangorn": {
      "command": "npx",
      "args": ["-y", "-p", "@fangorn-network/westmarch", "fangorn-mcp"]
    }
  }
}
```

The first start downloads the package, about 20 seconds. Searching by meaning needs the
embedding model: add `-p @huggingface/transformers` before `fangorn-mcp` (about 500 MB, once;
the first start then takes longer than Claude Code waits, so reconnect once it lands). Without
it, search matches words. The first search downloads the explorer's view. If `fangorn` shows as failed the
first time, reconnect it once the download finishes (`/mcp` → reconnect). Later starts use
npm's cache and are ready in under a second.

## Use it

| tool | what it does |
|---|---|
| `search {query, publisher?, limit?}` | records by meaning across every publisher, or one. Each hit names its `publisher`, and carries `sale` ({publisher, repo, id, price}) when it is sold. |
| `publishers {query?}` | each publisher's repos, what they hold and how many records, the busiest first |
| `get {id}` | one record in full |
| `buy {publisher, repo, id}` | checks the sealed data can be read, then pays for the record over x402 and returns its fields opened |
| `wallet` | your address and balances |
| `publish {repo, records}` | commits records to your own repo, from your wallet |

For example:

> Who publishes weather data on Fangorn? Find tornado warnings in Oklahoma this week.

## Settings

| Env var | Default | What it does |
|---|---|---|
| `FANGORN_EXPLORER` | `https://explorer.fangorn.network` | The explorer to ask. Anyone can run one: it is a westmarch app that presents every repo. |
| `FANGORN_MCP_WALLET_KEY` | none | A private key (with or without `0x`) to buy with, in USDC. Unset, `buy` refuses and the agent gives the price instead. `publish` signs with it, else with the `fangorn` CLI's key. |
| `FANGORN_MCP_MAX_PRICE` | `0.10` | The most it pays for one record, in USDC. |
| `FANGORN_NETWORK` | `baseSepolia` | The network `buy`, `wallet` and `publish` sign on. |

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

The plugin's `npx -p @fangorn-network/westmarch` command does not work from inside this
checkout: npx resolves the package to the checkout itself and can reuse a stale link from an
older layout (`fangorn-mcp: not found`). Use the `node` command above here, and delete the
stale `~/.npm/_npx/<hash>` whose `package.json` points at `file:` this repo.

## Single-file binary (maintainers)

`build-bin.js` builds one executable, so users don't need Node. It is **not published yet**: there is no GitHub release and no
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

- **The explorer's view can't be read:** the explorer is down or `FANGORN_EXPLORER` is wrong.
  The data is still on chain; try again, or point at another explorer.
- **A record published a moment ago isn't found:** the explorer indexes every few minutes.
- **`... is not a function` right after an upgrade:** the server is still running the
  old code. Reconnect it.
- **`buying is off`:** set `FANGORN_MCP_WALLET_KEY`.
- **`not buying: the record's sealed data … can't be read`:** nothing was paid. The data isn't
  reachable through the gateway right now; try again later.
- **Search matches words, not meaning:** add `-p @huggingface/transformers` to the `npx`
  command (about 500 MB, once). Without it, search matches words.
