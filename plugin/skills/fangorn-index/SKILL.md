---
name: fangorn-index
description: Find and use the apps registered on Fangorn. Rank every publisher against a question without downloading any corpus, then browse, search, facet and explore whichever one wins, and hand the person off to the app that owns the row. Carries a taste kernel that lives on the filesystem and applies in every corpus on the network, so what was learned in one publisher's catalog ranks another's. Use when the user wants to find data, media, places, games or films on Fangorn, wants recommendations across apps, wants to teach or read their own taste, or asks what is even out there.
---

# The Fangorn app index

The index **points at apps, it does not host them**. Its job is to tell you what
is out there, let you read enough to decide, and hand the person to the app that
owns the thing. `launch` is the end of the road, not a failure to render.

Everything runs through one script. No browser, no MCP server, no publisher has
to host anything but a baked view:

```sh
npx -y -p @fangorn-network/westmarch -p @huggingface/transformers fangorn-fx <verb> …   # JSON on stdout; `fx` below
```

Run it bare for the verb list.

---

## 0. Sources — which publishers exist

Every verb that spans publishers needs a list of view URLs. In order of
precedence:

```sh
--sources=https://a/q/qb_1,https://b/q/qb_2      # explicit
FANGORN_SOURCES=…                                # env
~/.fangorn/sources.json                          # a JSON array
(none of the above)                              # every app bound on chain.
                                                 # Preferred. --from-block=N
                                                 # for another deployment.
```

The chain is the real answer: it is the same scan `fangorn-mcp`'s `list-apps`
runs, so apps registered after this plugin was written are found without a code
change. Pin sources only to narrow the search.

---

## 1. The loop

```
find  →  describe  →  browse / search / facet / similar  →  row  →  launch
```

**`find <query>` first, always.** It ranks every publisher's corpus against the
question using coverage centroids — a few KB per corpus — and **downloads none of
them**. On a network of forty publishers this is the difference between one
question and forty downloads.

```sh
fx find "1950s atomic paranoia"
```

Read three fields off the result and nothing else matters:

- `relevant: N` — how many cleared the floor. **Open those and stop.** The tail is
  sorted, not relevant.
- `unreachable` — publishers that were down. Say so; do not conclude the data
  does not exist.
- `mismatched` — corpora baked with a different embedding model. They cannot be
  ranked against this question at all, and pretending otherwise produces numbers
  that look like scores and are noise.

**Then `describe <view>`** before anything else on a corpus you have not seen.
It reports **coverage, not a schema** — "`series` on 40% of rows" is the fact you
need to decide whether faceting on it means anything, and a declared schema would
have said 100% and been wrong. It also tells you `shape: declared | sniffed`:
sniffed means the publisher declared no `role_map` and the titles are a guess.
Say which when it matters.

**Then read.** `browse` for what is here with no query (the first call on an
unfamiliar corpus — every other verb needs something you do not have yet),
`facet` to make a field legible without reading it, `search` for a question,
`similar` to explore a vocabulary you do not know, `row` for one record whole.

`--where=k=v` composes with `search`, `browse` and `facet`. It matches
**case-insensitively but on whole values**, so `comedy` never silently counts
every `dark comedy`.

**Then `launch`.** Two forms, and they are different things:

```sh
fx launch <view> "cold war"          # the APP, with the kernel and query in the URL
fx launch <view> --row=<id>          # the publisher's own link for that row
```

The first only works where the publisher declared `presentation.launch`. That is
the app handoff and it carries the taste kernel — the app ranks its own rows by
what this person liked elsewhere, without either side having heard of the other.

---

## 2. The kernel — the thing that actually travels

```sh
fx like <view> <id...>        # teach it
fx dislike <view> <id...>     # "not that" — the only thing a person says explicitly
fx forget <id...>             # take one back
fx taste                      # what it is, and what it was built from
fx recommend <view>           # rank ANY corpus by it
```

It lives in **`~/.fangorn/taste.json`** — a file, between the human and the
agent. Not localStorage, which is origin-scoped and therefore invisible to the
next app by construction. This is the one piece of state in the whole system and
the reason this is a plugin rather than a page.

**The headline is `recommend` against a corpus the kernel has never seen.** Every
publisher bakes into one embedding space, so a taste learned in a film archive
ranks a stranger's game catalog directly — not by matching ids, there are none in
common, and not by a shared schema, there isn't one. MEASURED against the repo's
own fixtures: liking one bar in Eagle River pulls *Callahan's Crosstime Saloon*
and *Where the Water Tastes Like Wine* out of 5,847 Wikipedia video games.

Use it that way. `recommend` on the corpus the picks came from is the boring
call; `recommend` on the next app is the product.

Three things to hold:

- **It is the person's, and it is readable.** `taste` prints the titles it was
  built from. If a recommendation is wrong, show them the picks and offer
  `forget` — a profile you cannot correct is a profile held *about* someone.
- **Order is signal.** Picks are weighted by recency (half-life 8), so liking
  things in the order they were actually liked matters.
- **`recommend` refuses across embedding models** rather than returning scores
  that are noise. If it does, say so; do not work around it.

---

## 3. Limits — state these, do not paper over them

- **The index shows previews, never the thing.** A row here is enough to decide.
  Playing it, buying it, editing it — that is the app's, and `launch` is how you
  get there.
- **Every command re-fetches its view.** Fine at a thousand rows, seconds at
  forty thousand. Chain verbs sparingly on a big corpus, and prefer `find` +
  `describe` + one `search` over ten exploratory calls.
- **The first embedding call downloads the model** (~100MB, cached after). Until
  then, and if it fails, `search` degrades to lexical and **says so** in
  `mode`/`why`. Report which one answered — a lexical result to a conceptual
  question is not a wrong answer, it is a different question.
- **Paid fields are withheld.** `describe` reports `gates`; a locked field is
  absent from the free shard, not empty. Quote the price rather than reporting
  the data as missing.
- **No spending.** Nothing here touches a wallet. `launch` walks the person to
  the app; buying happens there, with their hands.
- **A vectorless row cannot be liked** and cannot be a neighbour. It is still
  searchable lexically. Half a real bundle looks like this.
