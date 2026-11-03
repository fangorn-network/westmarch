---
name: fangorn-app
description: Build, publish and register a Fangorn app with @fangorn-network/westmarch — a self-improving database with no server. The owner's questions come first; then sources (a crawler, a one-time dataset, or live publishers) are graded against those questions locally before anything goes on chain; then a static site any person can search by meaning and any agent can discover, verify and drive. Use this whenever someone wants to put a dataset, catalog, corpus or feed "on Fangorn", make it searchable without running a server, write golden questions or an eval for one, expose it to agents (WebMCP page tools, fangorn-mcp data tools, an agent card, ERC-8004/A2A), declare an app.json role_map, run westmarch-ship, westmarch-view, westmarch-eval or lint, or asks how their data can be found by fangorn-mcp.
---

# Building a Fangorn app with westmarch

A Fangorn app is a database with no server. Its records are committed to the owner's
repo, `<wallet>:<app>`, on Base Sepolia (`"network": "baseSepolia"` in `app.json`, required); a view of them (content-addressed shards with embeddings)
is served by the app's Cloudflare Worker; a page searches them in the reader's tab;
an agent card bound on chain lets any agent find, verify and drive it. It improves by a
loop the owner runs: new records always ship, and a change to *how* records are made
ships only if the owner's questions are answered no worse.

```
 register (minutes):  repo ─► empty site on its Worker ─► card bound on chain
                                                                 │ the app exists, at its URL
 build (hours):       crawl, snapshot ─► .ship/stage ─► recipe ─► local view ─► westmarch-eval
                                         (plaintext)    (app.json  (--local)    (eval/golden.jsonl)
                                                         types)                       │ pass
 go live:             schema, records ─► chain ─► view ─► Worker ─► agent minted ◄──────┘
 live: other wallets publish into the app ──► chain
```

Two paths, in this order. **Register is fast**: as soon as the person knows what the app
is and what to call it, create its repo, put an empty page at its address and bind its
card, so something real exists within minutes. **Build is slow**: questions, then sources,
then a local build graded against the questions, and only then does any record go on
chain. Nothing in the build is permanent until *Go live*. `westmarch-ship` does both from
one `app.json` (`--register` for the first).

The guide has the details: `app.json`, private apps, grading, discovery. Read the sections named
below when you reach them; do not read it whole up front.

- online: https://github.com/fangorn-network/westmarch/blob/main/docs/app-to-agent.md
- once the package is installed in the project: `node_modules/@fangorn-network/westmarch/docs/app-to-agent.md`

## Lead the conversation

The person arrives with an idea, not a spec. Turn it into one a step at a time, in
conversation; do not collect it with a form.

- **One or two questions a turn**, in prose. Never a numbered questionnaire, and never a
  menu for something only they can answer.
- **Propose, then ask.** After the first answer you know enough to guess. Say the guess
  ("so a resident types a town and gets its board's recent meetings?") and let them
  correct it. Correcting a draft is easier than writing from nothing.
- **Show before asking.** Once there is data, look at it with them. A real record answers
  half the questions and makes the rest concrete.
- **Ask each thing when it starts to matter.** Permanent choices (the app name, where the
  site lives, what is public) come just before the step that needs them, not up front.
- **Write down what is settled as you go** (`eval/goals.md`, `eval/golden.jsonl`,
  `app.json`) and say in a line what you wrote. The files are the running summary, and
  the person can read and edit them.
- **Push back on answers that give nothing to aim at.** "Everything, for everyone" leaves
  the loop no target: ask for one person and one thing they would ask it.

### The arc

Roughly this order. Loop back freely: a failing question in step 5 often sends you back to
step 3 or 4.

**0. What already exists.** Some people start from fangorn.network's Deploy to Cloudflare
button before they open this skill. They arrive with a GitHub repo made from westmarch's
template, a Worker running, and maybe the card bound. Check before asking anything, and
never redo what is done:

- Is the working directory a repo with `app.json` and `wrangler.json`? If `"app"` still
  says `my-app`, ask what the app is called and set it.
- `fangorn wallet` shows the signing wallet. `npx westmarch-ship app.json --register --dry-run`
  reads the chain and says whether this wallet's repo `<wallet>:<app>` exists and what card
  its `@card` points at. It writes nothing to the chain or Cloudflare, only `.ship/` locally.
  Repo names are per wallet, so there is nothing to claim and no one else can take the name.

Then:

- **The repo exists, with the Deploy button's Worker running.** The name and the site are
  settled: skip *What is permanent* for them, `westmarch init` and *Register the app*, and
  go from step 1 to step 3. This app deploys by `git push`: Workers Builds runs
  `westmarch build` on every push to `main`. **Never run `westmarch-ship` here without
  `--no-deploy`**, or it deploys a second copy over the Worker. Sources publish with
  `npx westmarch-ship app.json --no-deploy`, publishers push with the `fangorn` CLI, and
  `--local` grades as usual. The Deploy button builds free apps only. Selling records
  (`paid`) or the data (`private`) means moving its deploys to `westmarch-ship`, which
  sets the secret: say so before they choose a price.
- **A Worker from the Deploy button, but `fangorn wallet` is not the wallet whose repo it
  names.** Stop: `fangorn init` was given a different key from the one they used at
  fangorn.network (the hub exports it).
- **Nothing yet.** Start at step 1.

An app whose repo already exists still goes through step 1.5: the answer still decides
what to build into it.

**1. What it is, and who it is for.** Open with one broad question: what they want to make
and who would use it. Reflect back a short sketch (the user, what they ask, what they get)
and refine it until they say it is right. Over the next few turns, as follow-ups to what
they said rather than as a list, draw out:

- the questions their users ask, in their words;
- how a user would know it failed: the wrong or missing answer that would make them stop;
- what must be covered, and by when: towns, products, years, accounts;
- what must never show: people's names, addresses, a client's name.

**1.5. Is it worth building?** Registering is permanent, so ask two things first, using
the questions from step 1. Neither is a hard stop: say what you found and let the person
decide.

- **Does an agent need it?** Put three to five of their questions to a model with no
  tools and none of their data (a subagent with no tools, not you, since you have heard
  the conversation), then again with web search only. Judge each answer against what the
  person says is right. If both already answer well, say so plainly: an agent can already
  get this, so what would the app add? Good answers exist: data that is not online (an
  archive, a sensor, a computation over history), or newer than any model's training
  cutoff, or something a person needs to be able to prove. Write the result to
  `eval/goals.md` as the **baseline** (date, model, closed-book and web scores), so the
  finished app can be graded on the same questions and its lift stated.
- **Does it harm anyone?** Fangorn data should measure institutions, infrastructure and
  the environment, not individuals. Check that:
  - every contributor opts in and can leave;
  - nothing published can be traced back to one person (publish aggregates above a
    threshold, coarse places, no addresses);
  - the people the data is about are not worse off for it being published.
  
  If it fails one, reshape it (aggregate, coarsen, drop a field) or say it should not be
  built. Anything this rules out goes into "what must never show" as a hard check.

**2. Register it.** As soon as the sketch is agreed and worth building, settle the app name and where the
site lives (see *What is permanent*): propose a default for each, say it cannot be
changed, and wait for a yes. Then *Register the app*, and tell them what now exists: the
page at its URL and the card bound on chain. Everything after this fills it in.

**3. Where the data is.** Ask for the actual data (see *Sources*). Once you have it, read
a sample and show them two or three records in plain words: what one record is, what
identifies it, which text says what it is, which fields a user could filter on. Say what
kind of source it is and anything it lacks for the questions from step 1.

**4. Draft the questions together.** From their words and the data, propose five to eight
checks, each in plain language first ("'Plover village board' should mostly return
Plover records"), and ask which are wrong or missing. Write the agreed ones to
`eval/golden.jsonl` (see *Writing the questions*), and `eval/goals.md` from what they said
in step 1. Grow to 10–20 as the builds show what is missing.

**5. Build, look, adjust.** Build locally and grade (*Build locally until the questions
pass*), then walk through the result with them. End each round on one decision: fix the
data, fix the recipe, or change the question.

**6. Settle what each type costs to read**, just before *Go live* (see *What is
permanent*). Propose a default, say it cannot be changed once published, and wait for a
yes.

## Writing the questions

`eval/goals.md` has one section per goal: the customer, their questions, the coverage they
need, a date, what would kill it ("no paying user of this kind by then"), and the baseline
from step 1.5 (how a model did on those questions with no tools and with web search, so
the app's lift over both can be stated). It is the person's bet about what is worth
having: draft it from their words and have them confirm it, but never fill a gap with your
own guess about what they want.

`eval/golden.jsonl` holds the checks, one per line, each with the `goal` it serves.

| testing | check |
|---|---|
| a question is answered | `{"id":"plover","q":"Plover village board","expect":{"where":{"city":"Plover"}},"min":0.6,"goal":"places"}` — the share of the top 5 that fits. **Set `min`**: a search check without one always passes |
| a filter reaches the records at all | `{"id":"wells","kind":"count","where":{"county":"Portage"},"expect":{"match":{"heading":"well"}},"min":3}` |
| the data looks right | `{"id":"undated","kind":"records","expect":{"not":{"match":{"date":"."}}},"max_pct":5}` — percent of rows with no date; the same shape catches short prose, ids in titles, placeholder values |
| what must be covered | `{"id":"towns","kind":"coverage","field":"city","values":"targets/towns.json","min":0.5}` — a list, or `{value: weight}` so the missing are named heaviest first. Set `min` here too |
| what must never show | a `records` check with `"hard": true` and `max_pct` 0 |

A predicate is `where` (whole-value, case-insensitive, the filter agents use), `match`
(field → regex; `a|b` joins fields) or `not`. Never record ids: ids are content hashes and
change whenever a record is re-shaped.

**The fields the questions name are the record's shape.** Every field a predicate uses must
exist on the records, filled — so the questions are the spec the sources are written to.

## Sources

A source is one kind of input:

- **crawl**: a site, API or feed read on a schedule, resuming from a cursor;
- **snapshot**: a file, dump or export (CSV, a database export, a bucket), read whole
  each run and replacing the last;
- **live**: people, agents or devices submitting. There is no ingest server: they
  push into its namespace from their own wallets,
  and the view reads every publisher's commits (one domain per publisher). An app with no
  `sources` presents every repo. An app with sources narrows its view
  to their namespaces, so name the ones publishers push to in `"live": ["readings"]` (or
  `"live": true` for any). `--local` then reads what publishers have already committed to
  those namespaces from the chain (reads only, no gas), beside what the sources staged,
  so contributions are graded too. Give each device its own repo name: one writer per
  repo.

For crawl and snapshot, the person must give a path or URL to the actual data; ask for it
plainly and wait. Do not scaffold, invent a shape, or write placeholder rows in its place.
Generating a starter set is a separate choice they make explicitly, and it publishes into
their real, permanent app.

## What a record is

A record is `{ entityType, <identity field>, …fields }`, one tag per kind of thing,
versioned (`my-app.thing.v1`) so a later shape can be a new type.

- The identity must be stable across runs (the same thing keeps the same id, or every
  update is a delete plus an insert) and unique across **every type** in the app: it
  replaces the CID as the row id that `search` returns and `get` looks up. Namespace
  it (`audius:genre:electronic`), keep the source's own id under another name, and
  declare it as `identity` in the role map.
- It needs prose that says what the record *is*. That text is what gets embedded; a
  title alone searches badly.
- Every field the questions filter or match on, as its own key.

## What is permanent

Settle these with the person one at a time, each with a proposed default: the name and
the site just before *Register the app*, what each type costs just before *Go live*.

- **The app name.** The repo name, and the prefix of every tool agents call; permanent once the card is bound. Do not assume it matches the data's name.
- **What each type costs to read.** Anything committed is permanent:
  - **public**: every field of a record is committed (to IPFS, anchored on chain) and
    served in the view. Anyone can read it forever.
  - **paid**: a record's detail sold per record over x402 (`paid` in `app.json`). The
    detail is written off chain, next to the stage, and served only through the site's
    worker; the public record carries its `paid_sha256`. Paid content must never also be
    in a public field, or anyone can read it from the view for free.
  - **private** (the data is the product, read by paying): `private` in `app.json`
    (`{"pass": {"price": "5", "days": 30}, "call": "0.01"}`). Ship seals every row whole
    before it is committed, so IPFS holds ciphertext; the app's Worker opens rows in its
    cron and serves the view and MCP tools only with a pass (`POST /pass`, x402) or one
    x402 payment per tool call. The card, catalog and `describe` stay free. Publish
    counts and timing stay visible on chain. Sources must stage (`--output-dir`). Not
    for data only *named* people may read: anyone who pays reads it.
- **Where the site will live.** The card's `url` is permanent once bound. The default is
  the Worker's `<project>.<account>.workers.dev`; otherwise a domain they own (`site.url`).
  `fangorn.network` is not available to app builders — never offer or assume a hostname
  under it.

## What the person must have

Do not open with this list. Check what you can yourself (`node -v`, `fangorn --version`), and raise a missing piece
when the next step needs it: Node, the Fangorn CLI, the wallet and Cloudflare to register;
whatever the sources run on before the first local build; Pinata before *Go live*.

- Node 22 and the Fangorn CLI: `npm i -g @fangorn-network/sdk@2026.11.3`, or whatever
  newer version westmarch's `package.json` lists as its `@fangorn-network/sdk` peer.
- Whatever the app's sources are written in: a source is any command (see step 2).
- A wallet on Base Sepolia with a little ETH. **It owns the app forever**, so it
  must be the wallet that will publish the data. Never generate a key for a real app;
  throwaway keys are only for read-only paths. Needed to register.
- A Pinata JWT, because commits and the ERC-8004 agent pin files to IPFS. Not needed
  until *Go live*.
- A Cloudflare account (`npx wrangler login`, or `CLOUDFLARE_API_TOKEN` and
  `CLOUDFLARE_ACCOUNT_ID` in CI). The app is a Worker on their account.

Start every app from the template, never by hand:

```sh
npx @fangorn-network/westmarch init <app>   # the repo, npm installed, first commit
```

```
app.json            the app: types (role maps), sources (none: it presents every repo), site, paid
sources/*.py        one module per source, if the app crawls anything
eval/goals.md       the bet
eval/golden.jsonl   the questions
wrangler.json       the Worker, for the deploy button (`westmarch build` fills CONFIG); westmarch-ship writes its own
.ship/              stage, cache, vectors (ignored); state.json (committed: the repo's first block, URL, agent id)
```

The repo is the recipe, never the data, so it can be public. If the app's on-chain repo
already exists, `westmarch-ship` finds it; it never creates it twice.

## Chain writes and deploys are the person's call

Several steps cost money or cannot be undone: every `fangorn repo init` and `fangorn push`
(gas), every deploy, and `fangorn card` (pins to IPFS, mints an ERC-8004 agent; with
`--skip-register` it only commits the repo's `@card`). `westmarch-ship --register` creates the
repo, deploys and binds the card; without `--local` it does all of these. Show the exact command and what it does, then run it only when they
say so. Everything else — the questions, the sources, local builds, the eval — is free
and reversible, so just do it.

## Register the app

The fast path, run once the name and site are agreed. It needs no data, types or sources
yet: an `app.json` with the app, its name, a one-line description and the site.

```json
{ "app": "my-app", "name": "My App", "description": "What it is, in a sentence.",
  "site": { "project": "my-app", "account": "<cloudflare account id>" } }
```

- `fangorn init` (key, Pinata JWT, gateway); `fangorn wallet` shows the owner. The config
  file beats `ETH_PRIVATE_KEY` in the environment.
- `site.account` in `app.json`, or `CLOUDFLARE_ACCOUNT_ID`: the Cloudflare account the
  Worker deploys to. `westmarch-ship` creates its R2 bucket and learns its workers.dev URL.

Then show the plan, and run it on their go-ahead:

```sh
npx westmarch-ship app.json --register --dry-run   # every step, printed, none done
npx westmarch-ship app.json --register             # repo, empty site, deploy, bind the card
```

It creates the app's repo (its block becomes the card's `fromBlock`), deploys the stock page over an empty view ("registered and being built"), and binds the
card URL on chain. It does **not** mint the ERC-8004 agent. The mint copies the card's
skills into a registration file once, for good, so it waits for the first full ship, when
the card describes the app as built. Back up `.ship/state.json`.

Open the URL with the person.

## Build locally until the questions pass

**1. `app.json`** (guide *The short way*). The `types` hold each type's `description`,
`role_map` and `presentation` — what gets embedded (`text`, plus `title`, `subtitle`,
`tags`), what readers see, what agents can filter and count on, where a record links
(`presentation.externalUrl`). Declare every type: an undeclared type gets its roles
guessed from field names, which works for display and often fails for search.

**2. One source per input.** A source is any command, in any language. `westmarch-ship`
runs it two ways, and it must answer both:

- **Stage:** with `--output-dir <dir>` (and `--volume <n>`, default 1), write its records as
  `volume_<n>_<stem>.json`: a JSON array of `{"name": "<record id>", "fields": {…}}`, with
  `fields.entityType` set to the record's declared type. References between records go in
  `volume_<n>_edges.json`: `[{"from": "<id>", "rel": "<relation>", "to": "<id>"}]`.
  `--local` reads only these files.
- **Publish:** with `--publish --namespace <ns> --fangorn-bin "<cli>"`, commit the same
  records to the repo `<ns>` through that `fangorn` CLI (`fangorn commit` then `fangorn push`).
  `--replace` means a snapshot: the run replaces the repo's records instead of adding to them.

Its entry in `app.json` must pass `--output-dir .ship/stage/<namespace>`: that directory
is the stage. A crawl also keeps its own cache and checkpoint (under `.ship/`), so the next
run resumes where this one stopped. A source with `"each": "rows.json"` is a template, one
source per row (`{field}`, `{field|slug}`, `{args...}`), so adding a town or a feed is
adding a row.

Withholding (names, addresses) belongs in the source, before anything is staged, so every
record passes through it. To sell a record, its publisher seals and prices it when
committing: `fangorn commit records.json --paid <field> --price 0.01`. The app then quotes
it (`"paid": true` and `"facilitator"` in `app.json`).

**3. Build and grade:**

```sh
npx westmarch-ship app.json --local /tmp/view --crawl   # run the sources, stage, embed — no chain, no key
npx westmarch-eval /tmp/view                            # the questions, answered as fangorn-mcp would
```

The first build downloads the 131 MB model into `~/.cache/fangorn-mcp/models` and embeds
on CPU at 14–65 records/s. Vectors are cached in `.ship/vectors.ndjson` by the exact text
embedded, so a rebuild embeds only what changed. Without `--crawl` it rebuilds from what is
staged (a recipe change in `app.json`); `--only ns1,ns2` limits it to some namespaces.

A big corpus on an NVIDIA GPU: `WESTMARCH_EMBED_DEVICE=cuda` runs the same q8 encoder on
the GPU (same stamp; ~0.99 cosine to CPU vectors, closer than the browser's queries get).
One-time setup: `ONNXRUNTIME_NODE_INSTALL=cuda12 node script/install.js` inside
`node_modules/onnxruntime-node`, and the CUDA 12 runtime, cuBLAS and cuDNN on
`LD_LIBRARY_PATH` (on WSL, add `/usr/lib/wsl/lib`). Another encoder's vectors (fastembed
fp32, say) are a different encoder, and a q8 view refuses them.

**4. Read the result with the person.** For each failing check:

- a search check low or 0: its top 3 titles are printed. The right records ranked low
  means the recipe (what `text` says, which role embeds it). The right records absent
  means the data lacks them — a source question. Or the question's predicate is wrong,
  which is the person's call.
- a records check over its ceiling: the source's shaping, in `build_graph`.
- coverage: the missing values are listed, heaviest first — the next source rows to add.

Then what the questions never asked. It is not graded yet, so look at the stage directly —
each field worth filtering on, and a few records whole:

```sh
jq -r '.[].fields.<field>' .ship/stage/<ns>/volume_1_*.json | sort | uniq -c | sort -rn | head -20
jq -r '.[].fields.text' .ship/stage/<ns>/volume_1_*.json | shuf -n 3
```

A large group no question touches is either a question the person has not written yet,
or data to drop in the source: less to embed, less to search past, less to expose.

**5. Repeat until the questions the person cares about pass.** Then set the floors just
past what this build scored — each search `min`, each records `max_pct` — so the gate
catches a regression. Commit `app.json`, `sources/` and `eval/`: from now on `HEAD` is the
recipe every change is graded against.

## Go live

The app is registered and the local build passes. Before the first commit, the Pinata
gateway must belong to the same account as the JWT, or the commit fails:
`curl -s https://api.pinata.cloud/v3/ipfs/gateways -H "Authorization: Bearer $JWT"` must
list the configured host.

Then show the person the plan, and run it on their go-ahead:

```sh
npx westmarch-ship app.json --dry-run   # every step, printed, none done
npx westmarch-ship app.json             # crawl + publish, view, site, card, deploy, mint the agent
```

The repo already exists (skipped *Register*? the same command creates it first). It runs each source with `--publish`
(one push per namespace), builds the view, writes the stock page, card and `_headers`
(and `_worker.js` with `paid`), deploys, and mints the ERC-8004 agent from the finished
card. Every step checks the chain or Cloudflare first, so rerunning it is how the app is
updated. State lives in `.ship/`; `.ship/state.json` holds the repo's first block, the URL and
whether the agent is still to be minted — back it up.

## The page: fangorn shape, the app's paint

Every Fangorn app's page has the same shape, so a person who has used one can use the next,
and an agent finds the same verbs. The stock page (`westmarch/site`) is that shape. It ships
structure and a few tokens, not a look. Do not design over it: the look belongs to the owner.

- **The shape.** A bar with the name, search box and sections. A results list, one row per
  record: its title (linking to the record), a meta line (facet · subtitle), a clipped
  detail, and 👍 👎 on the right. A record page with the fields, its source, and "Similar".
  **For you**: the likes and dislikes as removable pills, the four knobs (Lookahead,
  Variety, Surprise, Reach), Reroll, and the picks as the same rows. Liked and History,
  both kept on the device.
- **Like / dislike is the taste.** 👍 and 👎 feed the kernel (`discover` in
  `westmarch/taste`, knobs from its `KNOBS`); the page and the tools `rate` and `discover`
  call the same code, so an agent's vote shows on the page. Taste stays in the browser,
  never on chain.
- **Paint** is `theme.css` in `site.pages`, loaded after the base. It overrides the tokens:
  `--bg --fg --muted --line --accent --mark --font --font-display --radius --measure`,
  with a dark block under `:root:not([data-theme="light"])`. Ask the owner for a colour
  or a font before inventing one. With no answer, ship no `theme.css`: the plain fangorn base
  is the default, not a gap to fill.
- **A page of your own** (`site.pages/index.html` + `site.agent`, as Sidequest and Nimbus
  do) keeps the shape: the same rows, 👍 👎 on every record, a For-you built on `discover`
  with the same four knobs, the same token names, and the `rate`/`discover` verbs
  (`rate-<noun>`, `discover-<noun>` when they carry app-specific filters).

## Before saying it is done

- `npx westmarch-eval https://<site>/view` passes, and scores what the local build scored.
  The deployed view is what agents read.
- `fangorn status` shows the local tip on chain.
- `lint.js` against the **deployed** origin reports "nothing to fix" for every domain:
  `npx westmarch-lint https://<site>/view`.
  What matters is what a stranger can fetch, not what was built.
- The card answers `200` with CORS from another origin:
  `curl -sD - https://<site>/.well-known/agent-card.json -o /dev/null | grep -iE "^HTTP|access-control"`.
- `fangorn-mcp open-app <name>` returns `verified: true`, and `describe` lists the
  namespaces with the schema's description, not a guess.
- A search phrased by *meaning* (not a title) returns the right records with
  `ranked_by: "meaning"`.

## The local loop

This is what keeps the app current and improving, run on the owner's machine (by hand,
from cron, or with `/loop`). It needs no CI and no hosted runner.

**New data** is facts, and always ships:

```sh
npx westmarch-ship app.json                                                # crawl, publish, view, deploy
npx westmarch-eval https://<site>/view --report .ship/last-eval.json       # how the live app scores now
```

A check failing live is the next thing to work on, in this order: a `hard` records check
(privacy) first; then a source the ship log names as failed; then the largest coverage
gap of the goal furthest behind; then that goal's weakest question.

**A recipe change** (a source's `build_graph`, `app.json` `types`) can make the app worse,
so it is graded against `HEAD` over the same records before it ships:

```sh
git worktree add ../base HEAD && cp -r .ship ../base/
(cd ../base && npx westmarch-ship app.json --local /tmp/base)
npx westmarch-ship app.json --local /tmp/cand
npx westmarch-eval /tmp/cand --base /tmp/base          # exit 1 = worse
git worktree remove ../base
```

For a change to how a source *parses*, add `--crawl --only <the namespaces it affects>` to
both builds, or both read the old stage and the grade proves nothing. `worse`: revert it.
`better`, or `unchanged` with the target question up: commit it, then ship.

Rules that keep the gate honest:

- Never run the full ship with an uncommitted recipe change: it publishes whatever the
  sources produce.
- Never change `eval/` and the recipe in the same commit, so a change is held to the
  questions that existed before it.
- Worse is: mean precision or `known@10` down more than 0.05, a question the base
  answered now answered by nothing, a `hard` check rising, or any floor missed.

`fangorn-improve` automates picking and proposing one change per run, but it assumes
GitHub (pull requests, Actions artifacts, branch protection). Without that, follow its
order of work with the commands above.

## After initial implementation is complete, deployed, and verified

The base app is just a simple search. Once everything has been deployed and verified, prompt the user for extra functionality
to be present in the UI. For each extra requirement, there must be a corresponding webmcp tool that allows agents to seamlessly
interact with the application.

Start only after every item in *Before saying it is done* has passed against the
deployed site. A feature built on a broken base makes both failures harder to find.

On `westmarch-ship`, the page's own files go in the directory `site.pages` names (copied
over the stock page) and its tools in the module `site.agent` names, whose
`registerAgent` the card lists. Paths below (`app/agent.js`, `npm run card`) are the
by-hand layout; map them onto those.

### 1. Ask, offering what the view can actually back

Same rules as *Lead the conversation*. Start from what they just saw: ask what they
wished the page did while they used it. If they have no answer, suggest two or three
features in prose, built from **this** app's schema (its real fields and types, not
generic features), and ask which one first. Build one feature at a time, show it, then
ask about the next. Every suggestion must map to something `westmarch/tools` already
does over the loaded rows:

| feature a person sees | westmarch call | notes |
|---|---|---|
| filter by a category, e.g. genre chips or a region dropdown | `search(…, { where })`, `facet` | only fields declared in `tags`/`presentation.facets`; `facet` supplies the values |
| browse without a query, sorted by a date or count | `browse(rows, roles, { type, where, sort, desc, limit, offset })` | `sort` takes a field name; numeric strings sort as numbers |
| a record's detail panel | `getRow` | returns every field, so decide which to show |
| "more like this" | `neighbors(rows, id, roles, { limit })` | vector-only, needs no query |
| counts and charts ("how many per genre") | `facet(rows, field, { where })` | |
| records that belong to one entity ("this artist's tracks") | `browse` with `where: { <foreign-key field>: id }` | only if the row carries the key (e.g. `artistId`) |
| recommendations from likes and dislikes | `discover(rows, likes, dislikes, knobs)` | the stock page already has it (*The page*); keep taste in memory or `localStorage`, never on chain |

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
| **b. schema only** | a new facet, `externalUrl`, `presentation.types` labels, a `measures` field | `app.json` `types` | ship (redeploys the Worker; its next cron applies the spec with no re-embed) | deploy |
| **c. data** | a new field on records, new records | `pipeline/graph.mjs` | `westmarch-ship` (sources publish; the Worker's cron embeds) | push + deploy, stating the re-embed cost |
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
- **Do not rerun `fangorn card` without `--update`.** Bare, it always mints a *new*
  agent, so rerunning leaves two agents for one app. The ERC-8004 registration file is a
  snapshot of the card: name, description, card URL, `a2aSkills` (the union of the skills'
  **tags**, not tool names), and `x402Support` (whether any skill is tagged `x402`). New
  tools that reuse the existing tags leave it accurate. A new tool that adds a tag makes
  `a2aSkills` stale, and a first `x402` tag makes `x402Support` wrong. After deploying such a
  card, refresh the existing agent from it, with the person's go-ahead (a pin and one
  transaction from the owner wallet, nothing minted):
  `fangorn card <card url> --repo <app> --update <agentId>` (the id is in `.ship/state.json`).
  If a bind fails on "replacement transaction underpriced" after a mint, the agent exists:
  rebind with `--skip-register`, never rerun the mint.
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
| `discover(rows, likes, dislikes, { lookahead, variety, surprise, reach, seed, limit })` | likes/dislikes as for `taste`, newest last; knobs 0–1 (`KNOBS` has defaults and descriptions) | `{ taste: { from, rejected, heading, n } \| null, knobs, picks: [{ row, score }] }`; never returns what was voted on |

`where` matches case-insensitively on whole values, so an agent echoing a faceted value
back with the wrong case still hits, and `comedy` never counts every `dark comedy`.

## What can never change once it is on chain

| pin | why |
|---|---|
| the app name | the repo name, in every card and every tool prefix |
| the card's `url` and `fromBlock` | a rebuild that changes either publishes a card every reader rejects |
| a record's `id` | the same thing under a new id is a delete and an insert, re-embedded at full cost |
| for an app selling files through `src/publish/graph.js` and `envelope.js`: `ns`, `file`, `passages`, `pointerFields` | folded into every resourceId and vertex ever minted; the headers of those two files say why |

## The view on disk

Whether `westmarch-view` or a bake script writes it, a reader fetches exactly this:

```
<view>/cdn/catalog                          embedding_model + every domain's description, count, coverage
<view>/cdn/domains/<domain>/manifest        role_map, presentation, embedder, shards [{file, count, bytes, sha256}], tombstones
<view>/cdn/domains/<domain>/shards/shard-NNNN-<sha12>.ndjson.gz
```

A shard row is `{ track_id, owner, fields, v }` with `v` as base64 int8 (`packVec`
from `src/core/embed.js`). The manifest hashes each shard *as served*, gzipped, and
`shard.js` refuses a mismatch — that is what lets the files sit behind any CDN. Serve
`.ndjson.gz` as `application/gzip` with no `Content-Encoding`, or readers cannot verify.
`coverage` is spherical k-means over the domain's own vectors (`coverage()` in
`src/market/reactions.js`); without it a corpus scores `null` in every directory and is
never opened.

## Symptoms and causes

| symptom | cause |
|---|---|
| card rejected as not bound | the card URL differs by a slash, scheme or path |
| the view is empty after a push | the Worker's cron hasn't run yet (`westmarch-ship app.json --index`), or the push has not landed (`fangorn status`) |
| search matches words, never meaning | the bundler pre-bundled westmarch; exclude it in `optimizeDeps` |
| an agent's first call returns empty, later calls work | tools registered before the data loaded |
| `search` ignores what records say, or titles are ids | the type is not in the schema, so roles were guessed |
| a schema change did not change search | records keep the text they were embedded with; only new records use the new `text` role |
| lint: "nowhere to go" | no `presentation.externalUrl` for that entity type |
| `fangorn card`: registration needs IPFS | no Pinata JWT in `fangorn init` |
| `fangorn card` signs as the wrong wallet | `~/.fangorn/config.json` beats `ETH_PRIVATE_KEY` |
| IPFS reads say "switching to a service worker gateway" | ipfs.io no longer serves raw content; set a Pinata gateway in `fangorn init` |
| `fangorn-mcp`: "this browser has no WebMCP" | page tools need Chrome 150+ with `--enable-features=WebMCP`; data tools never need a browser |
| `commit` right after `repo init`: "owner of this gateway does not have this content pinned" (ERR_ID:00006) | the configured gateway belongs to a different Pinata account than the JWT; check `curl -s https://api.pinata.cloud/v3/ipfs/gateways -H "Authorization: Bearer $JWT"` lists it |
| `get` returns the wrong record, or two types share search ids | payload `id` is not unique across types; it replaces the CID as the row id; make it the namespaced key (`audius:genre:electronic`) |
| wrangler: "More than one account available" | set `CLOUDFLARE_ACCOUNT_ID` |
| `fangorn card`: "agent … was minted but its registration file was not set" | the mint landed and the pin or `setAgentURI` failed; run the `--update` command it prints, never a bare rerun (that mints a second agent) |
