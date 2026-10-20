# Hardening

Written 2026-10-08 against branch `batch-vouchers` (8a81f82). These are the things to fix before
a buyer spends their own money. They are listed in order: the first one can lose a buyer's money.

## 1. A partial settle takes money and returns nothing (fixed 2026-10-08)

`site/worker.js:127` settles a batch's payments one at a time. If payment 3 of 5 fails to settle,
payments 1 and 2 are already spent, and the buyer gets a 402 with no records. The code says to
refund by hand.

This happens more often than "a facilitator error":

- **A spent voucher is used again.** `src/agent/view-tools.js:196` rewrites the voucher file only
  when the whole purchase succeeds. After a partial failure, the vouchers that did settle stay in
  the file, so the next `buy` picks them again and fails the same way. Each failure spends more.
- **The wallet cannot cover a voucher.** Vouchers are signed ahead of time. If the person's balance
  falls below a voucher's value, that voucher verifies and then does not settle.

**Fix:**
- Worker: when some payments settle and one fails, return the records the settled value pays for
  (`floor(settled / price)` of them, in the order asked), plus the transactions and the ids that
  were not delivered. The buyer never pays for nothing, and a spent voucher added to a fresh one
  buys only what the fresh one pays for.
- `buyBatch`: remove each voucher from the list when its receipt comes back, including on a
  partial result, and let the caller save the list in a `finally`.
- Self-check (`node src/agent/x402.js`): a fresh voucher then a spent one delivers one record and
  both leave the stack; the spent one first sends nothing and only it leaves the stack.

**Done:** the Worker delivers `floor(settled / price)` records and names `paid`, `rejected` and
`undelivered`; a facilitator network error no longer turns into a 500 mid-batch. `buyBatch` drops
paid and rejected vouchers on every outcome, and fangorn-mcp saves the file in a `finally`.
`pick` also sorted equal vouchers unpredictably (its comparator never returned 0); fixed.

## 2. Paid records will pass the Pages file limit

`ship.js:261` writes each paid record as its own file in `site/_paid`. Quorum has 11,521 today, and
37,337 items are judged worth selling. Cloudflare Pages allows 20,000 files in a deployment on the
free plan (check the current number). The Worker also fetches one file for each id, which is why a
batch is capped at 25 (50 subrequests on the free plan).

**Fix:** pack paid records into a few hundred files (for example by the first two hex characters
of `fileFor(id)`), each holding `{ id: record }`. The Worker reads only the packs a batch touches.
This fixes the file limit and raises the batch cap, with no new storage.

## Deferred: re-delivering a lost response

If the connection drops after settlement, the buyer has paid and has no records, and a retry gets
"nonce used". A fix needs a new store (KV: nonce → ids). At $0.10 a record that is not worth a new
store yet. Name a contact for refunds instead, and add KV when a buyer loses a purchase.

## 3. Two fangorn-mcp processes can spend the same vouchers (fixed 2026-10-08)

Two MCP servers (for example Claude Desktop and Claude Code) that share one `FANGORN_MCP_VOUCHERS`
file both read it, pick the same vouchers, and race. One purchase wins. The other one hits item 1.

**Fix:** take an exclusive lock file next to the voucher file (`open(path + ".lock", "wx")`) for
the read, buy and write, and wait briefly if it is held. Remove the lock if it is older than 2 minutes.

**Done:** `withLock` in `src/agent/x402.js`, used by fangorn-mcp's `buy`; covered by the self-check.

## 4. One price, not the planned volume bands

The plan (`product/business_plan.md`, Pricing) has $0.10 / $0.05 / $0.02 by batch size. The Worker
charges `CONFIG.paid.price` for each record. While a batch is capped at 25, this does not matter.
Add the bands when the cap goes up: `CONFIG.paid.bands = [[100, p1], [1000, p2], [Infinity, p3]]`.

## 5. The money path has never run end to end

Verify has been checked against the PayAI facilitator. Settle has only run against the stand-in in
the self-check. Before outreach: fund a testnet wallet, sign vouchers, buy a batch through the
deployed Worker, and see the transfers on chain. Repeat once on the mainnet network.

## 6. No "new since" cursor

Rows carry a meeting date, but no date they first appeared in the view. Backfills add old meetings
on new days, so the meeting date cannot say what is new. `where` also matches only exact values
(`src/agent/tools.js:139`). Anything that follows a question or a matter over time (an agent's
scheduled check, a "follow" on the site) needs both.

**Fix:** the view bake stamps `first_seen` (the bake's date) on each row the first time it is
added, and keeps it through rebakes of the same record. `where` accepts `{ gte, lte }` and lists.
`search` and `threads` accept `since`.
