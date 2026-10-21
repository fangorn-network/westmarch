# The Fangorn plugins

Two Claude Code plugins from one marketplace (`.claude-plugin/marketplace.json`).

**`fangorn-index`** (this folder) is for people and agents using Fangorn apps:

- The **`fangorn-index`** skill makes the app index usable by an agent: find which
  publisher has what, read enough of it to decide, and hand off to the app that owns
  it, carrying a taste kernel that works in every corpus on the network. The rest of
  this file is about that skill.
- The **`fangorn`** MCP server (`.mcp.json`) is `fangorn-mcp` from npm: it lists the
  apps on chain, opens one and relays its tools, and pays x402 prices with
  `FANGORN_MCP_WALLET_KEY` when that is set in your environment (see `docs/mcp.md`).

**`fangorn-builder`** (`../plugin-builder`) is for app owners:

- **`fangorn-app`** builds an app: records → graph → schema → commit → view →
  page → agent card → on-chain binding, with the API shapes and the pins that
  cannot change stated up front. It is the agent-facing form of
  `docs/app-to-agent.md`, and points at that guide section by section rather than
  repeating it. It triggers on anything like "put this dataset on Fangorn" or "make
  this searchable by agents".
- **`fangorn-improve`** keeps a live app getting better: each run picks one thing (a failing
  guardrail, a broken source, an accepted Observation, the largest coverage gap, the weakest
  question), proves it locally with `westmarch-eval`, and opens one pull request that the
  app's `eval` gate then grades. It never publishes, deploys or merges. Run it by hand or on
  a schedule (`/loop`).

The skills run their commands from the published `@fangorn-network/westmarch` through
`npx`, so a change to `src/` reaches users when the package is published, not when this
repo is pushed.

## What the skill is not

**Not a browser driver.** `sond3r-tv` drives a live tab
through WebMCP, which is the right shape when the app IS the product. This is the
other half: an index that points at apps needs no runtime of its own, and no
publisher should have to host a server to be findable. Every verb is a function
`@fangorn-network/westmarch` already exports, and the shell is the transport. The MCP server
beside it is for clients that would rather call tools than run commands.

## Install

```sh
# or, from a shell: claude plugin marketplace add … && claude plugin install …
/plugin marketplace add fangorn-network/westmarch
/plugin install fangorn-index@fangorn     # consumers: skill + MCP
/plugin install fangorn-builder@fangorn   # app owners and publishers
```

It finds every app bound on chain by itself. To search only some publishers, pin
them:

```sh
echo '["https://…/q/qb_1","https://…/q/qb_2"]' > ~/.fangorn/sources.json
```

Run Claude Code from outside this repo. Inside it, `npx -p @fangorn-network/westmarch`
resolves the local checkout, where `fangorn-mcp` is not on the path, so the MCP
server reports "Connection closed".

## Paying for private apps

Only the MCP server pays; the skill never does. It reads its wallet from the
environment Claude Code starts in, so export these first:

```sh
export FANGORN_MCP_WALLET_KEY=0x…   # private key of a wallet holding USDC
export FANGORN_MCP_MAX_PRICE=0.10   # most it pays for one call, in USDC (default 0.10)
export FANGORN_NETWORK=baseSepolia  # optional; unset, the SDK's default
claude
```

When a private app's tool answers with x402's PaymentRequired, the server pays it
if the price is at or under `FANGORN_MCP_MAX_PRICE`, and retries the call. With no
wallet set, nothing is paid and the price comes back to the agent to tell the
person.

The server can also buy a pass (pay once, not per call) when the app sells one at
or under `FANGORN_MCP_MAX_PASS`. The plugin's `.mcp.json` does not pass that
variable through yet, so through the plugin it buys per call only.

Anything under the cap is paid without asking. Use a separate wallet with a small
balance, not one you care about.

## The verbs

```
find <query>              which app has this. Downloads no corpus — coverage
                          centroids only, a few KB each.
describe <view>           rows, field COVERAGE (not a schema), roles, where it
                          hands off, what it charges for
browse <view>             what is here, with no query
search <view> <query>     semantic where rows carry vectors, lexical where they
                          don't, and it says which
facet <view> <field>      count a field's values
row <view> <id>           one record, whole
similar <view> <id>       nearest by vector

like|dislike <view> <id>  teach the kernel
forget <id>               take a pick back
taste                     what it is, and what it was built from
recommend <view>          rank ANY corpus by it

launch <view> [query]     the app, with the kernel in the URL
launch <view> --row=<id>  the publisher's own link for that row
```

## The kernel

`~/.fangorn/taste.json`. A file, between the human and the agent — **not**
localStorage, which is origin-scoped and so invisible to the next app by
construction. That scoping is precisely why every app rebuilds a profile from
zero and why none of them is the person's.

It stores the picks, not only the derived vector, so it can be read and
corrected. Every publisher bakes into one embedding space, so it applies
wherever it is pointed:

```sh
fx like  http://localhost:8099/places ChIJJ0iVXx3LVU0R0E4pjG1Oo8M   # a bar
fx recommend http://localhost:8099/games                            # → Callahan's
                                                                    #   Crosstime Saloon
```

Two corpora with no field in common and no shared ids.

## Try it against the fixtures

```sh
cd examples/demo/public && python3 -m http.server 8099 &
B=http://localhost:8099
node plugin/scripts/fx.mjs find "1950s atomic paranoia" \
  --sources=$B/archive-films,$B/archive-transcripts,$B/games,$B/places
```

## What it will not do

Spend money (paying is the MCP server's, above), and host an app. `launch` walks the person to the door; the app is
on the other side of it.
