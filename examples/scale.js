#!/usr/bin/env node
// Experiment: what grows as publishers and apps are added, on the sandbox.
//
//   npm run sandbox             # in one terminal
//   node examples/scale.js [8,32,96]
//
// For each N, N more agents each publish 5 notes to their own "memory" repo, then an app follows all of
// them. The embedder is a fake one, so the numbers are the infrastructure's, not the model's.

import { run } from "../src/run.js";
import { fold } from "../src/fold.js";
import { patternsOf } from "../src/stitcher.js";
import { fakeEmbedder } from "../src/testing.js";
import { agent, metered, say, h, chain } from "./lib.js";

const sizes = (process.argv[2] ?? "8,32,96").split(",").map(Number);
const REPO = "memory", all = [];
const notes = (p, k) => [...Array(5)].map((_, i) => ({ id: `n${i}`, type: "note", payload: { claim: `${p.name} note ${i} v${k}` } }));
const count = (fn) => async (...a) => { const t = performance.now(); const out = await fn(...a); return { out, ms: Math.round(performance.now() - t) }; };

say("   N  writes reverted  write gas   log   open app (embeds)   1 write → catch-up (embeds)   +1 publisher (embeds)   verifyStitch   fold all");
for (const N of sizes) {
    const fresh = await Promise.all([...Array(N - all.length)].map((_, i) => agent(`p${all.length + i}`)));
    const w = await metered("", () => Promise.all(fresh.map(async (p) => { await p.initRepo(REPO); await p.uploadBatch(REPO, notes(p, 0)); })), { quiet: true });
    all.push(...fresh);

    const reader = await agent("reader"), embedder = fakeEmbedder();
    const config = { publishers: all.map((p) => p.address), repos: [REPO] };
    const open = await count(run)({ config, fangorn: reader, embedder, path: ":memory:", log: () => {} });
    const app = open.out, e0 = embedder.seen.length;

    await all[0].uploadBatch(REPO, notes(all[0], N).slice(0, 1));
    const catchUp = await count(() => app.tick())();
    const e1 = embedder.seen.length;
    const { stitch } = await app.index.store.load();
    await app.stop();

    // following one more publisher: today's index rebuilds from scratch
    const extra = await agent(`x${N}`); await extra.initRepo(REPO); await extra.uploadBatch(REPO, notes(extra, 0));
    const grown = { ...config, publishers: [...config.publishers, extra.address] };
    const e2 = embedder.seen.length;
    const plus = await count(run)({ config: grown, fangorn: reader, embedder, path: ":memory:", log: () => {} });
    await plus.out.stop();
    const e3 = embedder.seen.length;
    all.push(extra);

    const verify = await count(() => reader.verifyStitch(stitch, patternsOf(config)))();
    const folded = await count(() => fold(reader, [REPO], (n = 0) => n + 1))();
    const log = (await reader.getRegistry().log({}, 0n, await chain.getBlockNumber({ cacheTime: 0 }))).length;

    say(`${String(N).padStart(4)}  ${`${w.reverted}/${w.txs}`.padStart(15)}  ${String(Math.round(w.gas / w.txs)).padStart(9)}  ${String(log).padStart(4)}  ${String(open.ms).padStart(8)} ms (${String(e0).padStart(3)})  ${String(catchUp.ms).padStart(14)} ms (${e1 - e0})  ${String(plus.ms).padStart(16)} ms (${e3 - e2})  ${String(verify.ms).padStart(9)} ms  ${String(folded.ms).padStart(5)} ms (${folded.out.state} commits)`);
}
process.exit(0);
