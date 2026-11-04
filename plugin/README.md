# The Fangorn plugins

Two Claude Code plugins from one marketplace (`.claude-plugin/marketplace.json`).

**`fangorn-index`** (this folder) is for people and agents finding data on Fangorn:

- The **`fangorn`** MCP server (`.mcp.json`) is `fangorn-mcp` from npm. It downloads the view
  of the Fangorn explorer, which indexes every publisher, and searches it on this machine, so
  no query leaves it: `search`, `publishers`, `get`, `buy`, `wallet`, `publish`.
- The **`fangorn-index`** skill tells the agent how to use it: search records, credit the
  publisher, say the price before buying.

**`fangorn-builder`** (`../plugin-builder`) is for publishers building an app:

- **`fangorn-app`** builds, ships and registers an app with `westmarch-ship`. It is the
  agent-facing form of `docs/app-to-agent.md`.
- **`fangorn-improve`** improves a live app one gated pull request at a time. It never
  publishes, deploys or merges.

The MCP server runs from the published `@fangorn-network/westmarch` through `npx`, so a
change to `src/` reaches users when the package is published, not when this repo is pushed.

## Install

```sh
# or, from a shell: claude plugin marketplace add … && claude plugin install …
/plugin marketplace add fangorn-network/westmarch
/plugin install fangorn-index@fangorn     # finding and buying data: skill + MCP
/plugin install fangorn-builder@fangorn   # publishers building apps
```

Run Claude Code from outside this repo. Inside it, `npx -p @fangorn-network/westmarch`
resolves the local checkout, where `fangorn-mcp` is not on the path, so the MCP server
reports "Connection closed".

## Settings

The server reads these from the environment Claude Code starts in:

```sh
export FANGORN_EXPLORER=https://explorer.fangorn.network   # the default; another explorer if you run one
export FANGORN_MCP_WALLET_KEY=0x…   # a wallet holding USDC, to buy records
export FANGORN_MCP_MAX_PRICE=0.10   # most it pays for one record, in USDC (default 0.10)
claude
```

With no wallet set, nothing is paid: `buy` says so, and the agent tells the person the
price. `buy` checks the sealed data can be read before paying, and pays anything under the
cap when the agent calls it; the skill tells the agent to ask first. Use a separate wallet with a small balance, not one you care about.
