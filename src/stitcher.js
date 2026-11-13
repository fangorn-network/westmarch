// Keeps a stitch over a fixed set of publishers × repo names up to date.
// The SDK does the work: `restitch(patterns, prev)` folds only the update log since `prev`.
// What triggers an update is up to the caller: `watchHeads` (one log subscription), a cron, an HTTP hook…

import { stitchFilter } from "@fangorn-network/sdk";
import { fangornStore } from "./store.js";

/**
 * Every `publisher/repo` pair, as stitch patterns. Without `publishers`, the bare repo names: that repo
 * of EVERY publisher, so a new publisher joins the stitch with no config change (an indexer as a service).
 */
export const patternsOf = ({ publishers, repos }) => publishers ? publishers.flatMap((p) => repos.map((r) => `${p}/${r}`)) : [...repos];

/**
 * A lens is what the stitcher feeds: `{ apply(changes) }`, called with every followed repo whose head
 * moved, `[{ publisher, repo, from, to }]` (heads as `repoDiff` takes them, `from` null for a new repo).
 * The stitch is saved only after `apply` resolves, so the saved stitch is always what the lens has
 * absorbed; if it throws, the next update hands it the same changes again (so `apply` must be idempotent).
 */
export function stitcher(fangorn, { publishers, repos }, { store = fangornStore(fangorn), lens } = {}) {
    const patterns = patternsOf({ publishers, repos });
    let stitch, committed, loaded; // committed: the root last saved
    let running, queued;

    const headsOf = async (s) => new Map(s ? (await fangorn.stitchHeads(s)).map((h) => [`${h.publisher}/${h.repo}`, h]) : []);

    /** Repos whose head differs between two stitches. A stitch never drops a repo under the same patterns. */
    // ponytail: reads both stitches' whole trees, O(heads); walk only the changed MST paths when that shows up
    async function changes(from, to) {
        const [was, now] = await Promise.all([headsOf(from), headsOf(to)]);
        return [...now].filter(([k, h]) => was.get(k)?.head !== h.head)
            .map(([k, { publisher, repo, head }]) => ({ publisher, repo, from: was.get(k)?.head ?? null, to: head }));
    }

    /** The saved stitch, or {} if there is none, or it was built for other patterns (its tree holds their repos). */
    async function load() {
        const it = await store.load();
        return it && JSON.stringify(it.patterns) === JSON.stringify(patterns) ? it : {};
    }

    async function commit(root) {
        await store.save({ stitch, root, patterns });
        committed = root;
    }

    return {
        get stitch() { return stitch; },

        /**
         * Restitch from the last stitch and return its root, committing the stitch when the root moved.
         * A log that moved only for repos we don't follow gives a new stitch but the same root: no tx.
         * If the commit fails it throws, and the next update retries it.
         */
        async update() {
            if (!loaded) { ({ stitch, root: committed } = await load()); loaded = true; }
            const next = await fangorn.restitch(patterns, stitch);
            const { root } = await fangorn.readStitch(next);
            if (root !== committed && lens) await lens.apply(await changes(stitch, next));
            stitch = next;
            if (root !== committed) await commit(root);
            return root;
        },

        /**
         * `update`, coalesced: call it on every event. While one runs, every trigger shares ONE follow-up
         * run, which picks up everything since (restitch reads the whole log tail). Resolves to a root
         * that includes this trigger's event.
         */
        trigger() {
            if (!running) return (running = this.update().finally(() => { running = undefined; }));
            return (queued ??= running.catch(() => {}).then(() => { queued = undefined; return this.trigger(); }));
        },
    };
}

/**
 * Calls `onUpdate(entry)` for each head update to a followed repo. ONE subscription to the registry's
 * update log for every repo, filtered in memory: no per-head polling and no IPFS reads (unlike
 * `fangorn.feed()`, which diffs every commit). Returns the unsubscribe function.
 */
// ponytail: unfiltered on the RPC side, so it sees the whole network's updates; filter by publisher
// on-chain (LogFilter takes one) if that stream outgrows the in-memory filter.
export function watchHeads(fangorn, { publishers, repos }, onUpdate, onError = console.error) {
    const follows = stitchFilter(patternsOf({ publishers, repos }));
    return fangorn.getRegistry().watch({}, (e) => follows(e.publisher, e.repo) && onUpdate(e), onError);
}
