// Keeps a stitch over a fixed set of publishers × repo names up to date.
// The SDK does the work: `restitch(patterns, prev)` folds only the update log since `prev`.
// What triggers an update is up to the caller: `watchHeads` (one log subscription), a cron, an HTTP hook…

import { stitchFilter } from "@fangorn-network/sdk";
import { fangornStore } from "./store.js";

/**
 * The stitch patterns (see the SDK's stitchFilter): `follow` as given (`publisher/repo` pairs, bare repo names…),
 * else every `publisher/repo` pair of publishers × repos. Without `publishers`, the bare repo names: that repo
 * of EVERY publisher, so a new publisher joins the stitch with no config change (an indexer as a service).
 * A repo name ending in * is a prefix (for example `lb-*`: every repo whose name starts with `lb-`), for an app that makes its
 * repos as it goes; it becomes a regex here, since stitchFilter knows only names, `*` and `/regex/`.
 */
export const patternsOf = ({ follow, publishers, repos }) =>
    (follow ?? (publishers ? publishers.flatMap((p) => repos.map((r) => `${p}/${r}`)) : [...repos])).map(globToRegex);

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A prefix pattern as a regex, e.g. `0xabc/lb-*` or `lb-*` → `/^0xabc\/lb-.*$/` (publisher lowercased, as stitchFilter matches regexes); anything else as is. */
export function globToRegex(p) {
    if (p === "*" || p.startsWith("/") || !p.endsWith("*")) return p;
    const i = p.indexOf("/"), publisher = i < 0 ? null : p.slice(0, i), name = p.slice(i + 1, -1);
    return `/^${publisher ? escape(publisher.toLowerCase()) : "[^/]+"}\\/${escape(name)}.*$/`;
}

/** Does a repo name match one of `names` (names, or prefixes ending in *)? */
export const repoMatches = (names, repo) => names.some((n) => n.endsWith("*") ? repo.startsWith(n.slice(0, -1)) : n === repo);

/** The repo names a config follows (prefixes ending in *, e.g. `lb-*`, included), or null when a pattern (`*`, a regex) can't be named. */
export function reposOf({ follow, publishers, repos }) {
    const patterns = follow ?? (publishers ? publishers.flatMap((p) => repos.map((r) => `${p}/${r}`)) : [...repos]);
    return patterns.some((p) => p === "*" || p.startsWith("/")) ? null : [...new Set(patterns.map((p) => p.slice(p.indexOf("/") + 1)))];
}

/**
 * A lens is what the stitcher feeds: `{ apply(changes) }`, called with every followed repo whose head
 * moved, `[{ publisher, repo, from, to }]` (heads as `repoDiff` takes them, `from` null for a new repo).
 * The stitch is saved only after `apply` resolves, so the saved stitch is always what the lens has
 * absorbed; if it throws, the next update hands it the same changes again (so `apply` must be idempotent).
 * A lens with limits can take in part of them and resolve `{ partial: true }`: the OLD stitch is saved again, with
 * `caughtUp: false` (and whatever the lens staged), so the next update hands it the same changes to resume.
 * What it saves: `{ stitch, root, patterns, t, caughtUp }`, `t` the block the stitch is folded up to (a string).
 *
 * `step`: fold at most that many blocks per update, saving every step, even one that left the root where it was (so
 * the next update starts after it). For a run with hard limits (a Worker) and a store where a save is cheap (D1,
 * SQLite), not `fangornStore` (a tx a save). `caughtUp` (saved too) says whether the last update reached the head.
 */
export function stitcher(fangorn, config, { store = fangornStore(fangorn), lens, step } = {}) {
    const patterns = patternsOf(config);
    let stitch, committed, loaded, caughtUp = true; // committed: the root last saved
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

    async function commit(root, t) {
        await store.save({ stitch, root, patterns, t: t.toString(), caughtUp });
        committed = root;
    }

    return {
        get stitch() { return stitch; },
        /** False when the last update stopped at its `step`, short of the head: update again. */
        get caughtUp() { return caughtUp; },

        /**
         * Restitch from the last stitch and return its root, committing the stitch when the root moved.
         * A log that moved only for repos we don't follow gives a new stitch but the same root: no tx.
         * If the commit fails it throws, and the next update retries it.
         */
        async update() {
            if (!loaded) { ({ stitch, root: committed } = await load()); loaded = true; }
            // the block the current stitch is folded up to: where a step starts, and what a partial update saves again
            const folded = async () => (stitch ? (await fangorn.readStitch(stitch)).t : fangorn.getConfig().fromBlock ?? 0n);
            const upTo = step === undefined ? undefined : (await folded()) + BigInt(step);
            const next = await fangorn.restitch(patterns, stitch, upTo);
            const { root, t } = await fangorn.readStitch(next);
            if (root !== committed && lens && (await lens.apply(await changes(stitch, next)))?.partial) {
                caughtUp = false;
                await commit(committed, await folded());
                return committed;
            }
            const moved = next !== stitch;
            stitch = next;
            caughtUp = upTo === undefined || t < upTo; // a step stops at upTo; short of it, the fold reached the head
            if (root !== committed || (step !== undefined && moved)) await commit(root, t);
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
export function watchHeads(fangorn, config, onUpdate, onError = console.error) {
    const follows = stitchFilter(patternsOf(config));
    return fangorn.getRegistry().watch({}, (e) => follows(e.publisher, e.repo) && onUpdate(e), onError);
}
