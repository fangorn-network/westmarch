# @fangorn/westmarch

Everything you need to get started building apps with Fangorn.


**For Publishers** — shape a tree into a commit graph, describe what's in it, seal and upload the bytes. Needs `fangorn`. Runs anywhere: a script, a server, a browser.

**For Consumers** — read a quickbeam view's Semantic CDN shards in the reader's own process and rank them there. Needs a view URL and nothing else. No index server, no chain read, and the query never leaves the tab.

The two halves never talk to each other. A publisher writes a graph; some
watcher bakes it into a view; a consumer reads the view. Either half is useful
without the other.

```
publish/                                       consume/
  graph.js     fs tree ⇄ vertices + edges        directory.js  WHICH corpus
  enrich.js    what a file says → search text    shard.js      view → rows, streamed
  envelope.js  chunk keys, AEAD, upload/delete   roles.js      which field is the title
  lint.js      …and whether any of that WORKED   taste.js      what YOU like, portably
                                                 rank.js       rows + query → hits
                                                 embed.js      text → 256-d vector
                                                 apps.js       the registry of apps
                                                 corpora.js    SEVERAL corpora, open at once
                                                 ui.js         previews, from the role_map
```

`lint.js` sits in the consume/ directory and reads like a consumer, but it is
for the person who baked the view: every capability on the right is paid for at
bake time on the left, and the bill is invisible until a reader hits it.

## lint.js — what will the index be able to do with this?

```
$ node consume/lint.js https://cdn.example/q/qb_1
archive-transcripts — 21,131 rows — 1 thing stopping readers finding or reading this
  ✗ paywall names 1 field the free shard ships anyway
      text — readers are told these cost money and are handed them for free.
      → Either withhold them from the shard, or take them out of paywall.locked.
```

Three levels because there are three real outcomes: the reader cannot find you
(no `coverage`, a foreign embedding model, no vectors), they find you and cannot
read you (no `role_map`, no text role), or they read you and cannot go anywhere
(no `externalUrl`, no `actions`, no `launch`).

The check that needs a real shard — and the reason this is not a schema
validator — is a `paywall` naming fields the free shard ships anyway. It found
that in this repo's own fixtures on its first run, twice.

## corpora.js — the questions one publisher cannot answer

`directory.js` picks the right corpus. This holds several of them open, which is
a different thing and the more useful one: rank *these games* by a taste built
from *those films*, put one query to four publishers and get one ranking back.

`shard.js` always cached rows per view — what was singular was the consumer's
idea of "the" corpus, and the two `configure()` hooks, which now say which view
they are running for. Without that, the second corpus loaded is silently parsed
with the first one's text role.

```js
const S = session({ blankRoles: () => rolesFrom([], []) });
configure({
  onManifests: (ms, view) => { S.slot(view).roles = rolesFrom(ms); },
  rowText:     (f, view)  => textOf(f, S.slot(view).roles),
});
// …then merge() collapses per-corpus hit lists onto one scale. It is a sort,
// not a normalisation: every corpus scored the same query vector.
```

`example/cross.mjs` runs it against the four fixture bundles.

## ui.js — an interface for data nobody wrote an interface for

A tool can return an HTML view beside its JSON (MCP Apps, formerly mcp-ui): an
`EmbeddedResource` with a `ui://` uri, rendered by a host that understands it and
ignored by one that does not. `resource` is a standard MCP content block, so
emitting one is safe everywhere.

It is worth doing *here* because this page does not know what its rows are. The
publisher's `role_map` already states which field is the title, the subtitle, the
tags, the measures — which is exactly a table renderer's input. So the interface
is generated per corpus at the moment of the call, from a declaration that
shipped with the data.

## taste.js — the thing one shared embedding space actually buys

The directory refuses to rank a corpus baked with a different model, because
cosine between two models' vectors is noise. Stated that way it sounds like a
limitation. It is the opposite:

> a taste learned in ONE publisher's corpus applies directly to ANOTHER'S.

Not by matching ids — there are none in common. Not by a shared schema — there
isn't one. Measured on this repo's own corpora: four bleak sci-fi films picked
out of 20,986 archive films produce a 888-byte vector which, pointed at 1,571
Wikipedia video games from an unrelated publisher, returns Beam Breakers
(cyberpunk), B-Movie and Crimson Tears. Four comedies produce a vector that
returns Bugs Bunny, Elmo in Grouchland and Goofy Skateboarding. Same corpus,
same code, disjoint answers.

Every recommender that exists keeps its embedding private, which is exactly what
makes taste non-portable — your taste is an asset of whoever holds the model.
Here the model is public and the vectors are in files you already downloaded, so
the taste is a small object you own, carry, read and correct.

State is sond3r's session kernel cut to what travels: `mu` (where you are), `v`
(where you're heading), `q` (the lookahead you rank with), `no` (what you
rejected, with the same GAMMA the kernel uses, so a rejection means the same
thing on both surfaces). `exportTaste` packs it as base64 int8 and carries the
TITLES it was built from — a taste you cannot read is a taste you cannot
correct, and this is meant to be a thing a person owns rather than a profile
held about them.

```sh
node example/taste-demo.mjs        # films -> games, end to end
```

## directory.js — searching FOR data, before searching IN it

Every other module answers a question about rows you already have. An agent
facing a network of independent publishers has an earlier question: *which
corpus*.

The bake already publishes the answer. Each domain's `catalog.json` carries
`coverage` — spherical k-means centroids over a sample of its own vectors, 8 at
128 dims, about 4 KB. Rank a query against every publisher's centroids and you
have ranked the network without downloading a shard.

That is what keeps it from being a search engine. A directory that indexed rows
would have to hold everyone's rows. This holds 4 KB per corpus and never sees
one — and the query is embedded in the client, so it never sees the question
either. Same privacy property the shards give search, one level up.

`findCorpora(query, {sources, embed, model})` returns matches with affinity,
size and price, plus what could not be reached and what could not be compared —
a corpus baked with a different embedding model is excluded and named, because
cosine between two models' vectors is noise that still looks like a score.

## roles.js — why a reader works on a corpus nobody wrote code for

A generic reader has one hard problem: it has rows and no idea which field is
the title. Hardcode `name` and it works on one bundle and returns `undefined` on
the next.

The answer is already baked. A quickbeam domain manifest carries `role_map`
(title, subtitle, tags, the prose to search, measures, location, link) and
`presentation` (icon, accent and singular/plural per entity type, plus per-type
external URL templates). `rolesFrom(manifests, sample)` merges that across the
domains a view fuses and falls back to sniffing where a domain declared nothing.
`collections(roles, rows)` turns `entity_types` into browsable groups with the
publisher's own icons and plurals, and `values(v)` normalizes a multi-valued
field — one real shard holds the same field as an array, as `"['a', 'b']"` and
as `"a,b"`, and handing an agent two shapes for one field is how it filters on
the wrong one.

One ordering matters and it is silent when you get it wrong: `rowText` runs per
row *during parsing*, so anything it depends on must exist before the first
shard is read. Derive roles after `loadShard` resolves and every row is already
parsed with the default — search then matches nothing and nothing errors. That
is what `configure({ onManifests })` is for; the format puts every manifest on
the wire before any shard.

## What an app has to pin

Almost nothing — but what there is, is permanent, because it goes on-chain.

| pin | where | why it can never change |
|---|---|---|
| **namespace** | `resourceIdFor(ns, …)` | folded into every resourceId ever minted. A different `ns` derives different ids, and bytes already stored become unreachable from the resource someone paid for. |
| **`file`** | `buildTreeGraph(nodes, { file })` | the fs node type, vertex tag and payload `kind`. Every vertex already committed says it. Default `"file"` — a new app takes it. |
| **`passages`** | same | the timestamped-text sidecar (cues, chapters, a transcript): its tag, edge rel, back-pointer field and id suffix. `null` if an app's files have no timeline. |
| **`pointerFields`** | same | which keys of a node's `published` blob reach the payload. `null` passes the blob through whole, which is right for a new app; pin a list once something is committed, so a field added upstream can't quietly start appearing. |

`sond3r/server/graph.js` and `sond3r/src/pay/envelope.js` are what a pin looks
like: a short file that holds the constants still and re-exports the rest.

## What an app has to wire

```js
import { configure } from "@fangorn/westmarch/shard";

configure({
  // How to learn WHICH view to read. A callback, not a constant: a view id
  // embeds its requester, so repointing an app must not need a rebuild.
  resolveView: () => "https://registry.example/q/qb_1",
  // The free text a lexical query matches, per row. Default: name/path/desc.
  rowText: (f) => [f.name, f.path, f.desc].filter(Boolean).join(" "),
});
```

Then `loadShard()` gives you every row, streamed, tombstones resolved, cached per
view; `watchShard(fn)` drops that cache when the view gains shards;
`suggestDomains(q)` ranks domains you have *not* downloaded, off the coverage
centroids in `catalog.json` — which is how you choose what to pull before the
bytes move.

## What it deliberately does not do

No row schema, no plugin system, no adapter interface. A row is
`{ id, owner, ...fields, text, vector, norm }` and what those fields *mean* is
the app's: what counts as a file, how hits group into results, what a price is.
`sond3r/src/catalog/search.js` is that layer for one app — series collapsing,
subtitle seeks, an x402f pointer projection — and none of it belongs here.

No UI. The React publisher and storefront still live in sond3r. A component API
designed against one consumer is a guess; the second app is what earns it.

## Test

```sh
pnpm test    # every module's own self-check, no network, no browser
```

`publish/envelope.js` pins fixed vectors for sond3r's live ids. If that check
fails, the extraction broke money.

`example/` is a second consumer — five WebMCP verbs and a telemetry page — run
against two unrelated bundles to prove the seam holds. See its README.
