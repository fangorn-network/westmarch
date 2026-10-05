// The whole argument, on one person's real library, in one file.
//
// Everything here also exists as a verb in `main.js`, where an agent drives it.
// This is the headless version, and it exists for two reasons: the browser verbs
// have no test that runs in CI, and the claim being made is specific enough that
// it should be possible to check it rather than watch a demo of it.
//
// The arc:
//
//   1. READ a Steam library off the local disk. No key, no login, no request to
//      Valve — the file is one Steam already wrote to this machine.
//   2. SEED a taste from it. Playtime decides which games count; last-played
//      decides their order, because the kernel weights by recency.
//   3. NAME what that taste is, in the publisher's own declared tag vocabulary —
//      the same code that later tells a publisher where demand is pointing.
//   4. RECOMMEND games it has never been shown, excluding everything it learned
//      from. This is the product.
//   5. DISCLOSE what sharing the resulting log would actually hand over, column
//      by column, before anything is published.
//   6. ANSWER a publisher's question from that log without moving it, and show
//      the refusal when the cohort is too small to hide in.
//
// Run:
//   node steam-taste.mjs <viewUrl> [path/to/localconfig.vdf]
//
// On Windows/WSL the file is usually at
//   <Steam>/userdata/<accountid>/config/localconfig.vdf
import { readFileSync, existsSync } from "node:fs";
import { configure, domainManifests, loadShard } from "@fangorn/westmarch/shard";
import { rolesFrom, textOf, titleOf } from "@fangorn/westmarch/roles";
import { seedTaste, steamLibrary, summarize } from "@fangorn/westmarch/steam";
import { exportTaste, recommend, taste } from "@fangorn/westmarch/taste";
import { tasteDoc } from "@fangorn/westmarch/taste-doc";
import { FREE, LOCKED, reactionCorpus } from "@fangorn/westmarch/reactions";
import { MIN_COHORT, SLOTS, statistics } from "@fangorn/westmarch/cohort";

const [view, vdfPath] = process.argv.slice(2);
if (!view) {
    console.error("usage: node steam-taste.mjs <viewUrl> [path/to/localconfig.vdf]");
    process.exit(1);
}
if (!vdfPath || !existsSync(vdfPath)) {
    console.error(`no Steam config at ${vdfPath ?? "(not given)"}\n` +
                  "Look in <Steam>/userdata/<accountid>/config/localconfig.vdf");
    process.exit(1);
}

const rule = (s) => console.log(`\n${"─".repeat(72)}\n${s}\n`);

// ── 1. the corpus ───────────────────────────────────────────────────────────
const held = new Map();
configure({
    onManifests: (ms, v) => held.set(v, rolesFrom(ms)),
    rowText: (f, v) => textOf(f, held.get(v) ?? { text: [] }),
});
const rows = await loadShard(view);
const roles = rolesFrom(domainManifests(view), rows);
console.log(`corpus: ${rows.length} rows from ${view}`);

// ── 2. the library ──────────────────────────────────────────────────────────
rule("1. the library, read off this machine");
const lib = steamLibrary(readFileSync(vdfPath, "utf8"));
const seed = seedTaste(lib, rows, { title: (r) => titleOf(r, roles) });
console.log(summarize(seed));
console.log(`\nmost recently played, which the half-life weights most:`);
for (const l of seed.likes.slice(-6)) {
    console.log(`  ${l.title}  ${(l.playtime / 60).toFixed(0)}h`);
}
if (seed.dislikes.length) {
    console.log(`\nlaunched and bounced off — the only negative signal a library holds:`);
    for (const d of seed.dislikes.slice(-5)) console.log(`  ${d.title}`);
}
if (!seed.likes.length) {
    console.error("\nno games matched — is this corpus keyed on `appid`?");
    process.exit(1);
}

// ── 3. what that taste IS ───────────────────────────────────────────────────
rule("2. what that taste is, in the publisher's own declared tags");
const t = taste(seed.likes, seed.dislikes);
const doc = tasteDoc({ t, catalogues: [{ name: "games", rows, roles }] });
// The DERIVED half only. The standing-instructions section above it is the
// reader's own and there is nobody here to have written it.
//
// Sliced on "## Observed" rather than on a section title: the titles are written
// in the first person ("## What I am drawn to"), and guessing at one printed an
// empty section instead of failing, which is the shape of bug this file exists
// to catch.
const from = doc.indexOf("## Observed");
console.log(from < 0 ? doc : doc.slice(from).split("\n").slice(0, 32).join("\n"));

// ── 4. the product ──────────────────────────────────────────────────────────
rule("3. recommendations — games it was never shown");
const seen = new Set(seed.likes.concat(seed.dislikes).map((x) => x.id));
for (const { row, score } of recommend(rows, t, { limit: 12, exclude: seen })) {
    const tags = String(row.tags ?? "").split(",").slice(0, 4).map((s) => s.trim()).filter(Boolean);
    console.log(`  ${score.toFixed(3)}  ${titleOf(row, roles)}${tags.length ? `  · ${tags.join(", ")}` : ""}`);
}
const wire = exportTaste(t);
console.log(`\nthat taste is ${JSON.stringify(wire).length} bytes and works in any corpus on this network.`);

// ── 5. what sharing it would disclose ───────────────────────────────────────
rule("4. what sharing this log would actually hand over");
const events = seed.likes.map((l) => ({ id: l.id, corpus: "games", title: l.title, vector: l.vector, reaction: "like", at: l.lastPlayed * 1000 }))
    .concat(seed.dislikes.map((d) => ({ id: d.id, corpus: "games", title: d.title, vector: d.vector, reaction: "skip", at: d.lastPlayed * 1000 })));
const corpus = reactionCorpus(events, { publisher: `0x${"0".repeat(40)}`, name: "reactions", price: "250000" });
console.log(`${events.length} reactions → a corpus of ${corpus.manifest.count} rows`);
console.log(`  free  : ${FREE.join(", ")}`);
console.log(`  paid  : ${LOCKED.join(", ")}`);
console.log(`\nNo reaction ships a vector. A reaction's vector is a byte-for-byte copy of a\n` +
            `row anyone can download free, so publishing it would hand a buyer the paid\n` +
            `column for nothing — joinable against the source corpus in one pass.`);

// ── 6. answering without moving the log ─────────────────────────────────────
rule("5. answering a publisher's question, without the log moving");
const question = { corpus: "games" };
const stats = statistics(events, question);
const counts = Object.fromEntries(SLOTS.map((s, i) => [s, Number(stats[i])]));
console.log(`this reader's own answer: ${JSON.stringify(counts)}`);
console.log(`\nA share is that answer plus values derived pairwise with every other reader,\n` +
            `which cancel when the cohort is summed. With ${MIN_COHORT > 1 ? "only this reader" : "one reader"} there is no cohort, so no\n` +
            `share is emitted: below ${MIN_COHORT} readers a "total" is one person's answer with a\n` +
            `sum sign on it. That refusal is the mechanism, not a limitation of it.`);
console.log(`\nRun the other side with:  node publisher-console.mjs ask ${view} "<question>"`);
