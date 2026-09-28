# fangorn-index

A Claude Code plugin with two skills.

**`fangorn-app`** builds an app: records → graph → schema → commit → view →
page → agent card → on-chain binding, with the API shapes and the pins that
cannot change stated up front. It is the agent-facing form of
`docs/app-to-agent.md`, and points at that guide section by section rather than
repeating it. It triggers on anything like "put this dataset on Fangorn" or "make
this searchable by agents".

**`fangorn-improve`** keeps a live app getting better: each run picks one thing (a failing
guardrail, a broken source, an accepted Observation, the largest coverage gap, the weakest
question), proves it locally with `westmarch-eval`, and opens one pull request that the
app's `eval` gate then grades. It never publishes, deploys or merges. Run it by hand or on
a schedule (`/loop`).

**`fangorn-index`** makes the Fangorn app index usable by an agent: find
which publisher has what, read enough of it to decide, and hand off to the app
that owns it — carrying a taste kernel that works in every corpus on the network.
The rest of this file is about that skill.

Ships inside the `@fangorn/westmarch` repo, and imports it by relative path. It
is not standalone.

## What it is not

**Not an MCP server, and not a browser driver.** `sond3r-tv` drives a live tab
through WebMCP, which is the right shape when the app IS the product. This is the
other half: an index that points at apps needs no runtime of its own, and no
publisher should have to host a server to be findable. Every verb is a function
`@fangorn/westmarch` already exports, and the shell is the transport.

## Install

```sh
/plugin marketplace add fangorn-network/westmarch
/plugin install fangorn-index@fangorn-index
```

It finds every app bound on chain by itself. To search only some publishers, pin
them:

```sh
echo '["https://…/q/qb_1","https://…/q/qb_2"]' > ~/.fangorn/sources.json
```

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
cd example/public && python3 -m http.server 8099 &
B=http://localhost:8099
node plugin/scripts/fx.mjs find "1950s atomic paranoia" \
  --sources=$B/archive-films,$B/archive-transcripts,$B/games,$B/places
```

## What it will not do

Spend money, and host an app. `launch` walks the person to the door; the app is
on the other side of it.
