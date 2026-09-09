# westmarch probe

A second consumer of `@fangorn/westmarch`, built to answer one question: is the
library actually app-agnostic, or was it just sond3r with the names filed off?

No player, no storefront, no wallet, no relay. Five WebMCP verbs over rows, and
a page that shows what the agent is doing. **The same build serves any bundle** —
there is no dataset in the source.

Two bundles are wired up, deliberately unrelated:

```sh
pnpm dev                                   # the page, on :5180

#  /?sources=/archive-films,/archive-transcripts,/games,/places
#                               turns on the directory: find-corpora ranks all
#                               four, open-corpus loads whichever wins, and a
#                               taste built in one still works in the next.

#  /?view=/places      917 local businesses + events (Eagle River, WI).
#                      Ships in public/ — same origin, no server at all.
#  /?view=http://localhost:8090
#                      42,215 archive.org films + subtitle passages. Needs
#                      node ../../sond3r/scripts/serve-embeddings.js \
#                          ../../sond3r/archive-videos-test-2.embeddings.ndjson
```

Open it in a Chrome with `--enable-features=WebMCP` and ask an agent for the
tools. `node probe.mjs <viewUrl> [query]` runs the same verbs headless.

`places` declares a `role_map`, so the page titles and tags every row the way its
publisher meant. The archive bundle declares nothing, so roles are sniffed — the
header says which, because a page that silently guesses is one you cannot trust
when it guesses wrong. Neither has a line of code written for it.

**A cross-origin view needs CORS.** `places` is served out of `public/` on the
page's own origin, which is also the realistic deployment: a publisher's static
site carries its own shards. A view on another host must send
`access-control-allow-origin`, as `serve-embeddings.js` does.

## The five verbs

Nothing below reads a field by a name the caller did not give it. That is the
whole demonstration: sond3r's WebMCP surface is nineteen tools and most of them
are television — capture a frame, program a channel, cut a montage. These five
are what is left when you take the app out.

| verb | what it is for |
|---|---|
| `note-taste` | tell the page which rows you liked or disliked. Builds a vector that keeps working after you open a different publisher's corpus. |
| `recommend` | rank the corpus currently open by that taste. The useful call is after `open-corpus` has moved you somewhere else entirely. |
| `export-taste` | the taste as a few hundred portable bytes, naming the rows it came from. |
| `find-corpora` | search FOR data. Ranks every corpus the page knows about against a question, downloading none of them, and quotes what each costs. The question an agent has before it has a corpus. |
| `open-corpus` | load one of them, so the other verbs operate on it. |
| `browse-collection` | list what is here, with no query. Called bare it names the collections and their sizes; with a `type` it lists that collection's rows, with `where`, `sort` and paging. The first call to make on an unfamiliar corpus — every other verb needs something you don't have yet. |
| `describe-corpus` | what is in here at all — rows, vectors, field coverage, and the publisher's own declaration of title/subtitle/tags/prose. Coverage, not a schema: the archive bundle's `series` is on 40% of rows, and a declared schema would have said 100% and been wrong. |
| `search-corpus` | semantic where a row has a vector, word-matching where it doesn't, and it says which per hit. |
| `facet-field` | count a field's values, `where` another field matches. The verb that makes a corpus legible without reading it. |
| `get-row` | one row, whole. The only verb that returns everything. |
| `similar-rows` | nearest by vector — explore a corpus whose vocabulary you don't know yet. |
| `present` | play the answer instead of listing it. Fills a queue from a question (or from the taste alone), orders it by the taste, and returns a surface that PLAYS the first item — video, audio, image, place or reader, chosen from the row's own mime and the publisher's media role. Likes and skips inside it re-order the queue in place, without interrupting what is playing. |
| `taste-doc` | the reader's taste as `taste.md` — what they are drawn to, what they pass on, which way they are moving, in the vocabulary the open publishers declared, above the reader's own standing instructions. Read it before recommending anything. |
| `seed-taste` | start from what someone has actually played. Reads a Steam `localconfig.vdf` — the file Steam already wrote to their own disk — and turns playtime and last-played into a taste against the open corpus. No key, no login, no request to Valve. Drop the file on the page, or pass its contents. |
| `share-reactions` | what you reacted to, as a corpus someone can buy — and, before anything is published, exactly which columns a buyer gets and which the free index discloses. |
| `answer-question` | answer a publisher's question about your reactions without handing over your reactions. Returns a masked share that cancels across the cohort, and refuses to emit one for a cohort too small to hide in. |

## What the page shows

Left, the corpus: its collections as the publisher named them, the rows in the
one you have open, field coverage, one live facet. Right, every tool call as it
lands — arguments, latency, result size. Watching an agent work out a corpus it
has never seen is the thing worth looking at, and the panel is the real record
of what it did, not a summary the agent wrote. An agent's `browse-collection`
moves the page, so the two sides stay in step.

None of the left side is written for a dataset. `entity_types` says there are
654 Events and 263 Businesses; `presentation.types` says an Event is a 🎫, a
Business is displayed as a **Place**, and its link template is `{googleMapsUri}`.
The archive bundle declares none of that, so it groups by raw type name with no
icon and no links — which is wh at "sniffed" in the header means.

## The whole arc, headless

`steam-taste.mjs` runs the reader's side end to end on a real library, which is
the version of this you can check rather than watch:

```sh
node steam-taste.mjs <view> "<Steam>/userdata/<accountid>/config/localconfig.vdf"
```

Read the library off the disk → seed a taste from playtime and recency → name
what that taste is in the publisher's own declared tags → recommend games it was
never shown → show what sharing the resulting log would disclose, column by
column → answer a publisher's question from it, and refuse to emit a share
because one reader is not a cohort.

Every step is also a verb in the page. This file exists because the verbs are
browser-only and the claims are specific enough to be worth testing.

## The other side of the trade

`publisher-console.mjs` is the half that BUYS. The reader's verbs above decide
what leaves the tab; this decides what a publisher can learn from what did.

```sh
node publisher-console.mjs shelf  <view>              # which of your tags can name a region
node publisher-console.mjs ask    <view> "<question>" --simulate 8 --out rounds.json
node publisher-console.mjs report <view> rounds.json  # the verdict, per question
```

`ask` posts one question to a cohort, every reader answers it against their own
log, and the masked shares are summed. The publisher reads a total and never a
row — not "sees them and promises not to keep them", but *there are no rows in
the input*. `report` names the direction in the publisher's own declared tags and
measures it against their own shelf, returning one of five verdicts, each of
which names an action with a budget line.

A cohort needs five readers and there is one of you, so `--simulate` builds
readers by drawing reaction logs out of the corpus. **Every output it produces is
stamped as simulated**, and it is a test harness for the mechanism rather than
evidence about any audience. Real shares — from a reader calling
`answer-question` in the page — go in with `--shares`, and the aggregation cannot
tell the two apart, which is the property that makes the whole thing work.

## Test

```sh
pnpm test        # tools.js self-check: pure functions, no browser, no network
node probe.mjs   # the same verbs against a running view on :8090
```

## What the second dataset caught

The archival bundle and 917 Wisconsin businesses share no field names at all.
Pointing the probe at the second one is what turned "generic" from a claim into
a fact:

- **Every display path returned `undefined`.** `brief()` hardcoded
  `name`/`path`/`desc`; the places bundle has `title`/`primaryType`/`text`. The
  library layer was already fine — `describe-corpus` read it perfectly. Fixed by
  `roles.js`, reading the `role_map` quickbeam already bakes into the manifest.
- **Roles derived too late are worse than no roles.** `rowText` runs during
  parsing, so deriving it after the load left every row with empty text and
  search matching nothing — with no error anywhere. Hence
  `configure({ onManifests })`.
- **Sniffing needs a sample, and the earliest caller has none.** An undeclared
  bundle now offers the whole candidate list and resolves per row.
- **Tag lists are not short.** `categories` runs to fifty entries per row, so
  four hits came back as four kilobytes of "Point Of Interest". Previews cap the
  list and say how much they dropped.
- **Tool descriptions were hardcoded too** — they named `series`, `year` and
  `subject`. For a publisher's storefront the description *is* the interface, so
  they now point at `describe-corpus` instead of naming one corpus's fields.

## Four things the first corpus caught

None of these showed up against fixtures.

- **An exact match can fail its own z-floor.** Three rows where one matches
  perfectly put the mean so high the floor lands above the match, and the corpus
  answers with nothing. The best semantic row now survives its own floor.
- **A silent `catch` around the embedder** made every hit come back `lexical`
  with no way to ask why. The reason now reaches the tool result *and* the panel.
- **Tools registered only after the corpus loaded** — a twelve-second window in
  which an agent found a page with no tools, indistinguishable from one that does
  not speak WebMCP. They register first and answer honestly while empty.
- **`where` was case-sensitive.** This bundle has `genre` lowercase and `subject`
  title case, so an agent echoing a faceted value back with the wrong case got an
  empty result and no clue why. Matching is case-insensitive, and still on whole
  values — "comedy" must not silently count every "dark comedy".

## One deployment note

`@fangorn/westmarch` is a linked sibling, so vite dev serves its files from
`/@fs/…`, which `server.fs.allow` denies by default. The symptom is not an
import error: the app runs and only the embed worker fails to start, so search
quietly drops to lexical. Both this config and sond3r's now allow it.
