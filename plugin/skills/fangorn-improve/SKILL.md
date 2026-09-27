---
name: fangorn-improve
description: Improve a live Fangorn app one gated pull request at a time — work its Observation issues, close its coverage gaps, lift its weakest goal — without ever publishing, deploying or merging. Use when someone asks to improve, grow or maintain a Fangorn app built on westmarch-ship, to "work the observations", "add the next town", "cover more of the state", to raise an eval goal's score, or runs it on a schedule (/loop). Requires the app's eval gate to be set up (fangorn-app, "Keeping it current, and improving it safely").
---

# Improving a Fangorn app, one pull request at a time

An app on `westmarch-ship` improves in a loop: people and agents file what it got wrong,
the owner's bet says what matters (`eval/goals.md`), and a gate refuses any change that
makes it worse (`eval.yml`). This skill is the part of the loop that proposes changes.
Each run does **one** piece of work and ends in **one** pull request, or in nothing.

What it may never do, whatever it is asked:

- push to `main`, merge, approve, or change a PR's required checks;
- run anything that writes to the chain or deploys: `westmarch-ship` without `--local`,
  `fangorn commit`/`push`/`app …`, `wrangler pages deploy`. It needs no wallet key and
  must not look for one;
- edit `eval/goals.md` (the owner's bet), `.github/`, or anything else in `CODEOWNERS`
  except by a PR the owner reviews; change `eval/` and the recipe in the same PR;
- close, relabel or accept an Observation. It comments on them.

If the repo lets it do any of these (no branch protection, a token that can push to
`main`), stop and tell the person before doing anything else.

## 0. Is the app ready for this?

All of these, or stop and say which is missing (fangorn-app sets them up):

- `app.json` (westmarch-ship), `eval/golden.jsonl` with `goal` tags, `eval/goals.md`;
- `.github/workflows/ship.yml` with the `observe` step and its `observe-report` artifact,
  and `.github/workflows/eval.yml`;
- `main` protected (`gh api repos/{owner}/{repo}/branches/main/protection` answers, and
  requires `eval`);
- labels `observation`, `accepted`, `improve` exist (`gh label create` them if the person
  says to).

## 1. Read the state

Start from a clean checkout of `origin/main`. Then:

```sh
gh run list --workflow ship --status success -L 1 --json databaseId -q '.[0].databaseId'   # last good ship
gh run download <id> --name observe-report --dir /tmp/observe                             # its eval report
gh issue list --label observation --state open --json number,title,labels,body,comments
gh pr list --label improve --state open --json number,title,headRefName
```

The report is `westmarch-eval --json` over what is live: `goals` (each goal's passing
checks, search and coverage), and per check its score and, for coverage, the largest
missing values first. `eval/goals.md` holds each goal's milestones.

**At most three open `improve` PRs.** At the cap, report what they are waiting on and stop.
Never open a second PR for something an open one already addresses.

## 2. Pick one thing, in this order

1. **A guardrail failing live**: a `hard` records check above its ceiling (privacy). Fix
   first, whatever else is open.
2. **A broken source**: the configured-towns coverage below its floor, or a source the ship
   log names as failed. The missing places are listed; find why that source stopped.
3. **An `accepted` Observation** (the owner triaged it), in the goal furthest behind its
   milestone.
4. **The largest coverage gap** in the goal furthest behind its milestone: the first
   missing place in its coverage check.
5. **The weakest question** of the weakest goal: a recipe experiment.

An Observation without `accepted` is not work yet. You may propose the golden question it
implies (below), which is how the owner triages it; do not act on it otherwise.

Before starting, read the item's comments: an earlier run may have tried something and
recorded that it did not help. Do not repeat it.

## 3. Know which kind of change it is

One kind per PR. The kind decides what proves it.

| kind | touches | proof before the PR | what `eval` does with it |
|---|---|---|---|
| **data**: a new town, a new feed | a row in `towns.json`, `legistar.json`, … | the row probes, and the source stages records for it | grades unchanged (it does not crawl); coverage rises after the next ship |
| **recipe**: shaping, parsing, schema | `sources/*.py`, `app.json` `types` | a local grade, base against candidate: not worse, and the target question up | grades it; worse cannot merge |
| **crawler**: a source that reads what it could not (a new platform, a fallback when an API refuses, a site layout it misreads) | `sources/*.py`, plus the rows that use it | the target place stages records; every namespace it already crawled stages the same records as before; the privacy checks hold on the new records | grades the recipe side; the new place's coverage rises after the next ship |
| **questions** | `eval/golden.jsonl` only | the new check runs against the current view | grades it with the new check; owner reviews (CODEOWNERS) |

## 4. Do it

Work in a branch `improve/<short-slug>`, and in a separate worktree for the base, so the
two builds never share a `.ship/`:

```sh
git switch -c improve/<slug> origin/main
git worktree add ../base origin/main && cp -r .ship ../base/ 2>/dev/null   # staged records, PDF cache, vectors
```

**Data: add a place.** Sources are Python on quickbeam's harness: install
`sources/requirements.txt` first, or point `PYTHON` at an environment that has quickbeam.
Find how the place publishes its meetings, cheapest first:

- Legistar: `curl -s https://webapi.legistar.com/v1/<client>/bodies`. A list of bodies
  (check they are the city's, e.g. "Common Council", not the county's) means yes; HTTP 500
  means no such client. Try the obvious clients (`racine`, `<city>wi`, `cityof<city>`).
- CivicPlus: `npm run probe -- <site> "<City>" WI` prints a `towns.json` row, or says no
  meeting module; `python -m sources.discover` finds CivicPlus towns in bulk.
- Otherwise, the site's own meetings page, for a `pages.json` row (sources/pdflinks.py).

Add one row, named the way `eval/targets/` names the place, since the coverage checks
match on that name. Then prove it stages:

```sh
npx westmarch-ship app.json --local /tmp/cand --crawl --only <namespace>
```

Nonzero records for the new namespace, or the row is wrong. Say how many, and show three
headings so a reviewer can see they are that place's decisions.

Before a place is recorded as uncrawlable, look for a **crawler** change that reaches it
(below): a different client name the town's own site links to, a public web page where the
API refuses. A place that truly cannot be crawled (HTTP 403 to every request, a bot challenge,
meetings only as scanned images) is still data: add its row with `"skip": true` and a `"reason"` naming
what was tried and the date, in a data PR. Runs skip it from then on instead of retrying,
and its coverage stays honestly missing. Move to the next gap in the same run.

**Recipe: change how records are made.** Build both, over the same records, and grade:

```sh
(cd ../base && npx westmarch-ship app.json --local /tmp/base)
npx westmarch-ship app.json --local /tmp/cand
npx westmarch-eval /tmp/cand --base /tmp/base --report /tmp/verdict.json
```

For a change to a source's **parsing**, `--local` alone reads the old staged records and
proves nothing: add `--crawl --only <namespaces it affects>` to **both** builds, so each
parses the same documents (the PDF cache makes the second crawl cheap). Keep the namespaces
few; say which.

- `worse`: do not open a PR. Comment on the Observation (or goal) what was tried and the
  failures, so the next run does not repeat it.
- `unchanged` and the target question did not rise: the same, as a comment.
- `better`, or `unchanged` with the target question up and nothing else down: open it.

**Crawler: make a source read what it could not.** This is code, and the most valuable
kind: one fix can reach every place on the same platform. The rules:

- Follow the town's own site to its meetings. The platform account it links to is the live
  one; a guessed client name can be an abandoned account (Racine: `racine.legistar.com` is
  empty, `cityofracine.legistar.com` is live).
- Respect the site: its `robots.txt`, the source's `--delay`, no bypassing a bot check or a
  login. A site that refuses crawlers is a skip row, not a problem to defeat.
- Reuse the source's own pieces (`split_items`, `clean`, `document`, the harness): new code
  reads a new shape of page, and hands the text to the same splitting and withholding as
  every other record, so privacy does not depend on the new code getting it right.
- Change existing behaviour only where it failed: a fallback that runs when the old path
  refuses, not a rewrite of the path that works.
- Keep it testable offline: the parsing takes HTML or JSON and returns rows, and a
  `--selfcheck` (or the module's existing one) runs it on a saved sample.

Proof, all of it in the PR:

```sh
npx westmarch-ship app.json --local /tmp/new --crawl --only <new namespace>          # the target: records, and three headings
npx westmarch-ship app.json --local /tmp/cand --crawl --only <2-3 namespaces it already read>
(cd ../base && npx westmarch-ship app.json --local /tmp/base --crawl --only <the same>)
npx westmarch-eval /tmp/cand --base /tmp/base                                      # the old path: unchanged
npx westmarch-eval /tmp/new --golden eval/golden.jsonl --known 0                   # privacy checks on the new records
```

A change to the platform itself (westmarch, quickbeam's harness) is not this skill's to
make: open an issue in that repo with the change proposed and the evidence, and link it.

**Questions.** Add the check the Observation implies to `eval/golden.jsonl`, with the
`goal` it serves and a predicate over fields (never record ids). Run `westmarch-eval` on
the current view and report its score: a new question that already passes is still worth
having, and one that fails is the point.

## 5. Open the pull request

```sh
gh pr create --label improve --title "<kind>: <what>" --body-file /tmp/body.md
```

The body, every time:

- **Why**: the Observation (`Closes #n` only for questions and recipe fixes it answers;
  data PRs `Refs #n`), or the goal and check it moves, with the numbers before.
- **Kind** and **what changed**, in a sentence each.
- **Proof**: the verdict table from `westmarch-eval` (or the staged-record count for
  data), and the commands that produced it.
- **Cost**: records it will re-embed on the next ship, and gas (one push per namespace
  touched).
- **Not verified**: anything the proof did not cover (a parsing change checked on two
  namespaces of twenty; a site that rate-limited the crawl).

Then comment on the Observation with the PR link. Remove the worktree. Stop: one PR per run.

## When there is nothing to do

No failing guardrail, no broken source, no accepted Observation, every goal at its
milestone: say so in one line with the goal scores, and stop. That is a good run.
