# Mission

Ship one live, revenue-capable product on top of Fangorn + Quickbeam, using a
corpus you choose, and come back with the real numbers.

Not a demo. Not a slide. A URL a stranger can open, search, drive with an agent,
and pay into — plus an honest accounting of what it cost to build, what it costs
to run, and what it would earn at volume.

You are a skunkworks / tiger team dedicated entirely to commercialization, not to
long-term maintenance. Time-to-market beats technical perfection. Ruthlessly cut
anything that does not drive customer value.

---

## The one-line thesis you are testing

Fangorn holds graph state with conditionally-accessible vertices, committed
on-chain. Quickbeam turns that graph into embeddings. Bake those into immutable
shards and a reader's own browser becomes the query engine — a **runtime-free,
privately-searchable agentic database**, served as static files, with a payment
rail attached.

If that is real, a small team can stand up a searchable, monetized corpus in days
with no server to operate. Your job is to prove or disprove that by doing it once,
for real, and writing down the bill.

---

## Hard constraints

These are not negotiable. A deliverable that violates one is a failed deliverable.

1. **No new infrastructure.** The output is static files on a CDN, plus at most
   one scheduled batch job (GitHub Action / cron) that re-crawls and re-bakes.
   Nothing always-on that we operate. No Qdrant server in production, no
   `quickbeam serve`, no API, no database, no auth service, no queue.
   Qdrant is allowed **at bake time only**, on a laptop or in the Action.
2. **Reuse what exists.** `fangorn`, `quickbeam`, `x402f`, `@fangorn/westmarch`,
   the existing access worker and facilitator, Pinata, the chain RPC we already
   use. Existing services are allowed as dependencies. **New ones are not.**
3. **Payments settle on testnet** for this session, behind one config switch that
   flips to mainnet. Real x402f flow, real proofs, real settlement — testnet funds.
4. **Deploy it.** Real public URL, real crawl, real shards, real WebMCP. "Works
   locally" is not done.
5. **No new repo** unless you can state in one sentence why it cannot live in an
   existing one.
6. **Simple wins.** Innovation only has to disrupt one small facet of something to
   create a new capability. Pick the small facet. Do not build a platform.

---

## Before you write any code: read the path that already exists

Most of this pipeline is built. Your first hour is spent finding out exactly how
much, so you do not rebuild it. At minimum, read and run:

| what | where | why it matters to you |
|---|---|---|
| the publish path | `westmarch/publish/` — `graph.js`, `enrich.js`, `cli.js` | fs tree → vertices+edges → committed graph, from a script |
| the bake | `embeddings/` (quickbeam) — `quickbeam build`, `quickbeam cdn bake` | graph → embeddings → immutable shards |
| **the exact static layout** | `westmarch/example/bake-steam.sh` | operator layout ≠ served layout. This script is the mapping. It exists because getting it wrong is a corpus that 404s its own catalog |
| the deploy | `westmarch/example/deploy.sh` | re-bake + `vite build` + `wrangler pages deploy` + lint against the **deployed origin** |
| the consumer | `westmarch/consume/` — `shard.js`, `rank.js`, `embed.js`, `corpora.js` | reader-side ranking, in-tab, query never leaves the browser |
| the agent surface | `westmarch/consume/tools.js`, `example/README.md` | the WebMCP verbs that already work over any corpus, dataset-agnostic |
| **the money** | `westmarch/publish/terms.js`, `settle.js`, `demand.js` | app cut + publisher lineage, in bps, already implemented |
| the acceptance check | `westmarch/consume/lint.js` | run it against the live origin, not local files |

`example/README.md` states the load-bearing fact: *"The same build serves any
bundle — there is no dataset in the source."* Four unrelated corpora are already
wired. **You are adding a fifth and a business model, not writing a pipeline.**

`terms.js` states the other one: *"discovery cannot be charged for (the query
never leaves the client and the index holds 4 KB per corpus), so a take at
settlement is the business model or there isn't one."* Design the product around
that fact rather than around a subscription you cannot enforce.

Write down, before building: **what is genuinely missing** vs. what you assumed
was missing and found. Anything you build that was already there is a defect.

---

## Choosing the corpus

Your call. Nobody cares which domain — GIS, government, media, patents, court
records, tabletop RPG rulebooks, hardware datasheets, obituaries, permit filings,
menus, trail data, whatever. It has to clear these bars:

- **Open and legally redistributable.** Public domain, open licence, or clearly
  permissive terms. Write down the licence and why redistribution is fine.
- **Big enough to be non-trivial, small enough to bake in an hour.** Order
  10k–500k rows. If a laptop can't bake it overnight, it's the wrong corpus.
- **Has real edges.** If it's a flat list of rows, Fangorn's graph adds nothing
  and you're just shipping a vector index. The typed relations have to matter.
- **Nobody can search it well today.** The bar is a *capability gap*, not a
  prettier UI. Say in one sentence what a person or an agent can do on your site
  that they provably cannot do on the source.
- **Somebody would plausibly pay for some slice of it** — or pay for *derivative*
  work over it, which is what the lineage mechanism is for.

Do **not** use the Piedmont, AL minutes. That path is already walked and is not
the point.

Pick two candidates, spend at most a couple of hours probing both (row counts,
edge density, crawlability, licence), then commit to one and say why. Do not
agonize. A corpus that is 80% right and shipped beats the perfect one unbuilt.

---

## The product

Three layers, in this order. Each must work before the next starts.

**1. The corpus is live and searchable.**
Crawl → graph → embed → bake → static deploy. Real URL. `lint.js` clean against
the deployed origin. Semantic search returns good results for at least ten
questions you write down in advance and do not tune against.

**2. An agent can drive it.**
WebMCP on the page. The existing verbs (`search-corpus`, `browse-collection`,
`facet-field`, `get-row`, `similar-rows`, `describe-corpus`, `note-taste`,
`recommend`, `find-corpora`, `open-corpus`) should mostly work unchanged — add
domain verbs only where the corpus demands something the generic set cannot
express, and justify each one. Prove it: a transcript of an agent doing something
genuinely useful in the tab, that it could not do without your site.

**3. There is a market over the top.**
Something is gated, priced, and buyable via x402f, with a take routed to us
through `terms.js`. Free discovery, paid access or paid derivative — free search
over the whole corpus, payment at the point of real value. What that gated thing
is, is your product decision, and the most important one you make. Candidates
worth weighing: bulk/structured export, the enriched or joined layer (not the raw
source), the freshest slice, high-resolution or full-text bodies where the free
shard carries only summaries, derived analysis, or agent-generated derivatives
that pay lineage back to the corpus.

`lint.js` specifically catches the failure where `paywall` names a field the free
shard ships anyway. It has caught that in this repo's own fixtures. Assume you
will hit it.

---

## Risk-first sequencing

Test the assumptions that can kill this **before** polishing anything. Run
software, data, packaging and go-to-market concurrently, not in hand-offs.

Order by what fails hardest:

1. **Does the corpus even crawl and graph cleanly?** If the source is hostile,
   rate-limited, or the edges are fiction, you learn it in hour two, not day two.
2. **Is browser-side search over a real corpus actually fast enough?** Shard size,
   cold-load time, first-result latency on a mid-range laptop and on a phone.
   This is the single technical assumption most likely to be false at scale. If
   a cold load is 40 seconds, the whole runtime-free thesis has a size ceiling —
   find the ceiling and state it as a number.
3. **Does an agent do something with it that a human couldn't do faster alone?**
   If not, WebMCP is decoration.
4. **Would anyone pay for the gated slice?** You cannot fully answer this in one
   session. You *can*: name the buyer, name the price, state the willingness-to-pay
   hypothesis, and design the cheapest real test of it. Then run that test if it
   is runnable.

Each is a **kill gate**. If one fails, say so plainly, state what it would take to
un-fail it, and either pivot the corpus or pivot the product. Do not quietly
proceed past a failed gate with a workaround.

---

## The numbers I want back

This is half the deliverable. Measure, don't estimate — and label anything you
had to estimate as an estimate.

**Build cost (one-time, per corpus)**
- crawl: wall time, bytes fetched, rows recovered, rows dropped and why
- graph: vertices, edges, labels; commit count; CAR size; IPFS pin bytes
- embed: model, dimensions, rows/sec, total wall time, hardware, GPU or CPU
- bake: shard count, total bytes, bytes/row, compression ratio
- chain: transactions sent, gas, and what that is in real money at current prices
- **your own time**: roughly how long each stage took to get working, including
  the wrong turns. This is the number that decides whether corpus #2 is viable.

**Run cost (ongoing)**
- static hosting: bytes stored, egress per 1,000 readers, cost at 1k / 100k / 1M
- IPFS pinning per month
- re-bake: cost and wall time of one incremental refresh vs. a full rebuild
- what a settlement costs (gas + facilitator), and what it nets after the take

**Reader-side performance** — the thesis lives or dies here
- cold load: bytes to first usable query, on a laptop and on a phone
- query latency: p50/p95 over your ten questions
- memory footprint of an open corpus in the tab
- **the size ceiling**: at what row count does this stop being pleasant? Find it
  empirically — bake a bigger slice if you have to — and state the number.

**Unit economics**
- price per gated unit, take rate, net per sale
- readers needed to cover run cost; sales needed to cover build cost
- and the honest verdict: what has to be true about volume for this to be a
  business rather than an art project

---

## Deliverables

1. **The live URL.** Static, WebMCP-enabled, lint-clean against its own origin.
2. **The market**, working on testnet, with a mainnet config switch and the take
   wired through `terms.js`.
3. **A `COSTS.md`** with every number above, measured, with methodology.
4. **A `DECISIONS.md`**: corpus chosen and why (and what you rejected), what the
   gated product is and why, every kill gate and its result, and — most
   valuable — **everything that turned out to be harder than it looked**.
5. **The reproduction path**: what someone runs to do this again for corpus #2,
   and which steps are still manual. Do not generalize it into a framework. Just
   make the path legible.
6. **A one-page verdict** for me: is this a product, a feature, or a research
   demo? Argue it from the numbers you just measured, not from enthusiasm. A
   well-argued "this doesn't work at these economics" is a successful session.

---

## Explicitly out of scope

- Piedmont, AL. Any rebuild of a pipeline that already runs.
- The ZK / on-chain KG-commitment work. I have pieces for this and will share them
  later; assume it lands after this session and do not design around it.
- Multi-tenant anything. Onboarding flows. Dashboards. Admin UIs. Settings pages.
- Abstractions for corpus #2 that corpus #1 did not force you to write.
- Long-term maintainability. This team ships and hands off.

---

## Operating rules

- **Autonomy.** You report to me, not to a process. Make the calls. Do not stop to
  ask permission for reversible decisions; state the assumption and keep moving.
  Stop and ask only when proceeding either way would waste a day or spend real
  money.
- **Concurrent engineering.** Data, software, packaging, pricing and go-to-market
  advance together. Do not sequence them into hand-offs.
- **MVP discipline.** Strip anything not required to make one real user or one
  real agent do one real thing they could not do before.
- **Report faithfully.** If a stage fails, show the output. If a number is an
  estimate, say so. If you skipped something, name it. A session that reports a
  working product that does not work is worse than one that reports nothing.
- **When in doubt, do less and measure more.** The numbers are the product here as
  much as the site is.

The roles below are a checklist of perspectives to apply, not people to simulate.
Use them to catch what you would otherwise miss; do not perform a meeting.

- *Commercialization / Product* — single point of accountability. Is this shippable
  and does anyone want it? Cut features that don't drive customer value.
- *Principal Inventor* — technical blockers, core IP, integrity under scaling.
- *Systems / Production* — turn lab code into something that runs unattended.
- *UX / Design* — hide the complexity; a stranger must get value in 30 seconds.
- *NPI / Operations* — unit economics, licences, compliance, what it costs to
  repeat this.
- *Growth / Pilot* — who's the first user, what makes them come back, what's the
  price, how do we find out if they'll pay.
