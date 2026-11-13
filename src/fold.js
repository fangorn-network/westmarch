// Shared app state with no app server: a pure reducer over the update log.
//
// Every commit to a followed repo is one event, in the order the chain logged it. If `reduce` is pure,
// everyone who folds the same log gets the same state: a game, an order book, a turn queue. Nobody hosts
// it. A stitch pins a prefix of that log (its `t` and `logRoot`), so "the state as of stitch S" is
// `fold(…, { to: S.t })`, and anyone can check S against the chain with `verifyStitch`.
//
// Contrast with the stitcher's lens, which sees net changes between two stitches (fine when only the
// latest records matter, as in a search index) and loses the order of commits in between.

import { stitchFilter, ZERO_HEAD } from "@fangorn-network/sdk";

/**
 * Fold `reduce(state, event)` over every commit to repos matching `patterns` (as for stitches: `pub/repo`,
 * or a bare repo name to take every publisher's repo of that name), oldest first.
 * `event` is `{ publisher, repo, pos, t, timestamp, puts, deletes }`: one commit, diffed against its parent.
 * Resume with the `{ state, t }` it returned; stop at block `to` (default: now).
 */
// ponytail: reads the whole network's log and filters in memory; narrow with LogFilter's `repo` when the
// network outgrows that. And it trusts the RPC for the log, like everything else that reads it here.
export async function fold(fangorn, patterns, reduce, { state, t, to } = {}) {
    const registry = fangorn.getRegistry(), follows = stitchFilter(patterns);
    to ??= await registry.clock();
    const from = t != null ? BigInt(t) + 1n : BigInt(fangorn.getConfig().fromBlock ?? 0n);
    for (const e of await registry.log({}, from, to)) {
        if (!follows(e.publisher, e.repo)) continue;
        const { puts, deletes } = await fangorn.engine.repoDiff(e.parent === ZERO_HEAD ? null : e.parent, e.head);
        state = reduce(state, { publisher: e.publisher.toLowerCase(), repo: e.repo, pos: e.pos, t: e.t, timestamp: e.timestamp, puts, deletes });
    }
    return { state, t: to };
}
