// The other half of the trade: what a publisher can learn, and what it cannot.
//
// `examples/demo/main.js` is the reader's side — react to rows, build a taste, and
// decide whether to share any of it. This is the side that BUYS, and it exists
// because the modules that make the purchase honest (`src/market/cohort.js`,
// `src/market/demand.js`) had no way to be run against a real corpus by a real
// publisher. They were exercised only inside a scripted market narrative, which
// proves the arithmetic and not the product.
//
// WHAT A PUBLISHER GETS HERE
// --------------------------
//   1. it posts a question and a budget,
//   2. every reader answers it against their OWN log, locally, returning a
//      masked share — their real answer plus values that cancel across the
//      cohort,
//   3. the shares are summed. The masks vanish, the totals remain,
//   4. the total is named in the publisher's own declared tag vocabulary and
//      measured against the publisher's own shelf, producing a verdict with a
//      budget line: commission, serve, fix, retire, cold.
//
// The publisher never sees a row. Not "sees them and promises not to keep them"
// — the per-reader rows are not in the input, because a share is uniform over
// the ring until every other share is added to it.
//
// ON THE SYNTHETIC READERS
// ------------------------
// A cohort needs at least five readers and there is one of you. So `--simulate`
// builds readers by drawing reaction logs from the corpus itself, and every
// output it produces is stamped as simulated. This is a test harness for the
// mechanism, NOT evidence about any real audience, and the distinction is worth
// being noisy about: a demand report is the kind of artefact that gets screen-
// shotted, and one built from readers this file invented would be a lie with a
// verdict on it.
//
// A real share comes from a reader calling `answer-question` in the page. Pass
// those with `--shares <file.json>` and they mix with, or replace, the synthetic
// ones — the aggregation cannot tell them apart, which is the property that
// makes the whole thing work.
//
// Run:
//   node publisher-console.mjs ask <viewUrl> "<question>" [--simulate 8] [--shares f.json]
//   node publisher-console.mjs report <viewUrl> <rounds.json>
//   node publisher-console.mjs shelf <viewUrl>
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { configure, domainManifests, loadShard } from "@fangorn/westmarch/shard";
import { rolesFrom, textOf, titleOf } from "@fangorn/westmarch/roles";
import { MIN_COHORT, aggregate, contribute, keypair, readout, statistics } from "@fangorn/westmarch/cohort";
import { brief, demandReport } from "@fangorn/westmarch/demand";
import { embedQuery, EMBED_MODEL } from "@fangorn/westmarch/embed";

const argv = process.argv.slice(2);
const verb = argv[0];
const flag = (name, dflt = null) => {
    const i = argv.indexOf(`--${name}`);
    return i < 0 ? dflt : (argv[i + 1] ?? true);
};

/** The publisher's own shelf, read the way any consumer reads it — through the
 *  manifests. Sniffing here would pick the wrong text field and the vocabulary
 *  would be built from filenames. */
async function shelf(view) {
    const held = new Map();
    configure({
        onManifests: (ms, v) => held.set(v, rolesFrom(ms)),
        rowText: (f, v) => textOf(f, held.get(v) ?? { text: [] }),
    });
    const rows = await loadShard(view);
    return { rows, roles: rolesFrom(domainManifests(view), rows) };
}

/**
 * A synthetic reader: someone whose attention sits in one region of the corpus.
 *
 * Drawn by picking a random row as an anchor and reacting to its neighbours, so
 * a simulated cohort has the property a real one has — readers are CLUSTERED,
 * not uniform — which is what makes a cohort centroid mean anything at all. A
 * cohort of uniformly random readers averages to zero and every question comes
 * back "diffuse", which would test nothing.
 */
function syntheticReader(rows, rng) {
    const withVec = rows.filter((r) => r.vector?.length);
    const anchor = withVec[Math.floor(rng() * withVec.length)];
    const near = withVec
        .map((r) => {
            let s = 0;
            for (let i = 0; i < Math.min(r.vector.length, anchor.vector.length); i++) s += r.vector[i] * anchor.vector[i];
            return { r, s };
        })
        .sort((a, b) => b.s - a.s)
        .slice(0, 30 + Math.floor(rng() * 40));
    return near.map(({ r }) => ({
        id: r.id, corpus: "shelf", vector: r.vector,
        // Mostly likes near the anchor, some skips — a reader with no negatives
        // makes `sentiment` a constant and the verdict untestable.
        reaction: rng() < 0.75 ? "like" : "skip", at: Date.now(),
    }));
}

/** Deterministic PRNG, so a simulated run is reproducible and can be compared
 *  against the next one. A report that moves when nothing changed is a report
 *  nobody can act on. */
function mulberry(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** One round: every reader answers, the shares are summed, the total is read. */
async function round(rows, question, { simulate = 8, shares: extra = [], seed = 1 } = {}) {
    const rng = mulberry(seed);
    const near = question ? await embedQuery(question) : null;

    const readers = [];
    for (let i = 0; i < simulate; i++) {
        readers.push({ log: syntheticReader(rows, rng), keys: await keypair() });
    }
    // Real shares arrive already masked against a cohort they named. Mixing them
    // into a differently-keyed synthetic cohort would break the cancellation and
    // the round would correctly fail `verify` — so a run with real shares uses
    // ONLY those, and says so.
    if (extra.length) {
        if (extra.length < MIN_COHORT) {
            throw new Error(`${extra.length} real shares is below the ${MIN_COHORT}-reader floor — the round cannot be read`);
        }
        const total = aggregate(extra.map((s) => s.map(BigInt)));
        return { readout: readout(total, extra.length), simulated: false, readers: extra.length };
    }

    const pubs = readers.map((r) => r.keys.pub);
    const shares = [];
    for (const r of readers) {
        shares.push(await contribute(statistics(r.log, { near }), r.keys, pubs, 0));
    }
    const total = aggregate(shares);
    return { readout: readout(total, readers.length), simulated: true, readers: readers.length };
}

const usage = () => {
    console.log(`
publisher-console — buy an answer, never the rows

  ask <view> "<question>" [--simulate N] [--shares f.json] [--seed N] [--out f.json]
      Post one question to a cohort and print what came back.

  report <view> <rounds.json> [--paid 9000] [--earned 0]
      Turn a file of asked rounds into the demand report: the direction named in
      your own tags, what your shelf holds along it, and a verdict per question.

  shelf <view>
      What the vocabulary can even see — the tags of yours that carry enough rows
      to name a region. Call this first; a shelf with no declared tags produces
      an unnameable direction and the report says so at some length.
`);
};

// ---------------------------------------------------------------------------
if (!verb || verb === "help") { usage(); process.exit(0); }

const view = argv[1];
if (!view) { usage(); process.exit(1); }

const { rows, roles } = await shelf(view);
const withVec = rows.filter((r) => r.vector?.length);
console.log(`shelf: ${rows.length} rows, ${withVec.length} with vectors, model ${EMBED_MODEL}`);
if (!withVec.length) {
    console.error("this view has no vectors — nothing here can be measured. Was it baked?");
    process.exit(1);
}

if (verb === "shelf") {
    const { vocabulary } = await import("@fangorn/westmarch/taste-doc");
    const v = vocabulary(rows, roles);
    console.log(`\n${v.terms.length} of your tags carry enough rows to name a region:`);
    // `{field, value, n}` — the field matters as much as the value, because two
    // publishers can both declare a "genre" and mean different vocabularies.
    console.log(v.terms.slice(0, 40)
        .map((t) => `  ${t.value}  (${t.field}, ${t.n} rows)`).join("\n"));
    if (!v.terms.length) {
        console.log("\n  none. The report can measure demand and cannot NAME it — declare tag\n" +
                    "  fields in the domain's role_map, or every finding comes back unnameable.");
    }
    process.exit(0);
}

if (verb === "ask") {
    const question = argv[2] ?? "";
    if (!question) { console.error('ask needs a question: ask <view> "co-op survival crafting"'); process.exit(1); }
    const extra = flag("shares") && existsSync(flag("shares"))
        ? JSON.parse(readFileSync(flag("shares"), "utf8")) : [];
    const r = await round(withVec, question, {
        simulate: Number(flag("simulate", 8)), shares: extra, seed: Number(flag("seed", 1)),
    });
    if (r.simulated) {
        console.log("\n⚠  SIMULATED COHORT — readers drawn from the corpus, not real people.\n" +
                    "   This exercises the mechanism. It is not evidence about any audience.");
    }
    console.log(`\nquestion: ${question}`);
    console.log(`readers:  ${r.readers}`);
    const o = r.readout;
    if (!o.ok) { console.log(`FAILED — ${o.why}`); process.exit(1); }
    console.log(`matched:  ${o.matched} reactions (${o.perReader}/reader)`);
    console.log(`split:    ${o.like} like, ${o.skip} skip`);
    console.log(`sentiment:${o.sentiment === null ? " withheld" : ` ${o.sentiment}`}`);
    console.log(`direction:${o.centroid ? ` ${o.centroid.length}-d unit vector` : ` withheld — ${o.withheld}`}`);

    const out = flag("out");
    if (out) {
        // Append, because `heading` needs one question asked at least four times
        // and a file that overwrote itself could never accumulate that.
        const prior = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : [];
        prior.push({ question, readout: o, simulated: r.simulated, at: Date.now() });
        writeFileSync(out, JSON.stringify(prior, null, 1));
        console.log(`\n→ ${out} (${prior.length} round${prior.length === 1 ? "" : "s"})`);
    }
    process.exit(0);
}

if (verb === "report") {
    const file = argv[2];
    if (!file || !existsSync(file)) { console.error("report needs the rounds file written by `ask --out`"); process.exit(1); }
    const probes = JSON.parse(readFileSync(file, "utf8"));
    const rep = demandReport({
        shelf: withVec, roles, probes,
        paidPerReader: BigInt(flag("paid", 9000)),
        earned: flag("earned") === null ? null : BigInt(flag("earned")),
    });
    if (probes.some((p) => p.simulated)) {
        console.log("\n⚠  Some rounds in this file came from a SIMULATED cohort.\n");
    }
    // Named from the manifest, not hardcoded: this console is pointed at a view,
    // and a report headed with the wrong corpus is worse than an unheaded one.
    const domain = domainManifests(view)?.[0]?.name ?? view;
    console.log(brief(rep, { title: `demand — ${domain}` }));
    process.exit(0);
}

usage();
process.exit(1);
