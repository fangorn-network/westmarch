// What the signal MEANS. The half of §9 that was missing.
//
// cohort.js returns a publisher a number and a direction: `matched`, a
// like/skip split, and a 128-d unit vector attention pointed along. That is an
// honest measurement and it is not a product. A publisher cannot commission a
// film from a unit vector, and asked what to do with one, the honest answer has
// so far been "rank your shelf against it and look" — which is a research task,
// performed by the person who least wants to perform it.
//
// The gap is not more data. The publisher already holds the one asset that makes
// the vector legible: THEIR OWN SHELF, vectors and declared tags included. A
// direction is meaningless in the abstract and precise against a catalogue.
//
// So this file does exactly three things with a readout the publisher just paid
// for:
//
//   1. NAMES the direction in the publisher's own declared tag vocabulary
//      (taste-doc's `vocabulary` + `affinities`, unchanged — the reader-facing
//      code that says "you are drawn to cold war documentaries" is the same code
//      that says "demand is pointing at cold war documentaries"),
//   2. MEASURES what the publisher owns along it — not "do you have rows", every
//      shelf has rows in every direction, but whether the shelf has anything
//      SHARP there: how far its best row stands above its own mean, in the
//      shelf's own sigma,
//   3. RETURNS A VERDICT, one of five, each of which names an action with a
//      budget line: commission, serve, fix, retire, cold.
//
// WHY PERCENTILES AND SIGMA, NEVER COSINE
// ---------------------------------------
// Raw nomic cosine is offset per query. 0.55 against one direction admits three
// rows and against another admits the entire catalogue — measured, and it
// returned byte-identical answers to three different questions. Everything below
// is stated in the shelf's own distribution for the direction being asked about,
// which is the only frame in which two of a publisher's questions are comparable.
//
// WHAT IT REFUSES TO DO
// ---------------------
// A withheld direction stays withheld. cohort.js declines to report a centroid
// standing on fewer than five reactions, because a mean over one row IS that row;
// a report that quietly filled that in with a plausible guess would defeat the
// entire mechanism at the last step, in the file the publisher actually reads.
// `withheld` findings carry counts, no direction, and instructions to widen.
//
// ponytail: no forecast, no attribution model, no "expected lift". The report
// says what was measured and what the publisher owns near it. Everything past
// that is a model of a market that has run five simulated rounds.

import { vocabulary, affinities } from "../consume/taste-doc.js";

/** Matched reactions per reader below which a region is not drawing attention.
 *  0.5 = the median reader reacted to something here at least every other
 *  round. Below that a "region" is a handful of people, and the counts are
 *  still reported — it is the VERDICT that goes cold, not the number. */
export const ATTENTION_FLOOR = 0.5;

/** How far above its own mean a shelf row must stand to count as supply for a
 *  direction. Same z as rank.js uses for a hit, and for the same reason: a
 *  shelf answers every direction a little, and "a little" is not an answer. */
export const SUPPLY_Z = 1;

/**
 * How far the shelf's best row must stand out, RELATIVE TO CHANCE, to count as
 * supply.
 *
 * The first version of this counted rows above mean + 1σ and called three of
 * them a stocked shelf. That number is a function of the shelf's size and
 * nothing else: cosines against a fixed direction are roughly normal, so ~16% of
 * ANY shelf clears mean + 1σ, and a 21,000-row catalogue "stocks" every
 * direction with 3,300 rows including directions it has never heard of.
 *
 * The scale-free question is whether the best row stands out MORE than the best
 * of n arbitrary rows would. The maximum of n standard normals sits near
 * sqrt(2·ln n) — 3.2σ at 200 rows, 4.1σ at 21,000 — so the statistic is the
 * ratio, and 1.0 is "no better than a shelf of noise". Measured on a real
 * 20,986-row archive: a genuinely served region scores above 1, and the region
 * the shelf merely brushes scores below it while still putting 3,300 rows over
 * a 1σ floor.
 */
export const STANDOUT = 1;

/** Rows beating the chance line below which the shelf has nothing to sell here.
 *  For a shelf of pure noise this count is 1 by construction, so three is
 *  inventory rather than coincidence — at 200 rows and at 200,000. */
export const THIN = 3;

/** Truncate to the direction's length and renormalise — a truncated unit vector
 *  is not a unit vector, and rank.js's `cosine` reuses a norm taken over the
 *  full 256 dims, which systematically underrates a row whose energy sits in the
 *  tail. Fine for a 256-d query, wrong against a 128-d cohort centroid. */
const cosTrunc = (vec, dir) => {
    const n = Math.min(vec.length, dir.length);
    let d = 0, vn = 0, dn = 0;
    for (let i = 0; i < n; i++) { d += vec[i] * dir[i]; vn += vec[i] * vec[i]; dn += dir[i] * dir[i]; }
    return d / ((Math.sqrt(vn) || 1) * (Math.sqrt(dn) || 1));
};

/**
 * The publisher's own supply along a direction, in the publisher's own sigma.
 *
 * `depth` is how many rows clear mean + z·σ; `sharpness` is where the best one
 * lands on that scale. A shelf with depth 40 and sharpness 1.4 is a shelf that
 * is vaguely about this and precisely about nothing.
 */
export function supply(shelf, dir, { z = SUPPLY_Z, limit = 5, title = null } = {}) {
    const rows = shelf.filter((r) => r.vector?.length);
    if (!rows.length || !dir?.length) return { depth: 0, sharpness: 0, standout: 0, top: [], scored: 0 };
    const scored = rows.map((r) => ({ r, s: cosTrunc(r.vector, dir) }));
    // THE BASELINE MUST NOT CONTAIN THE REGION. Taking mean and sd over the whole
    // shelf lets a well-stocked region set its own floor, and the statistic then
    // runs BACKWARDS: measured on a 200-row shelf, one genuine row in a region
    // scores 2.19 and forty score 0.66, so the publisher who serves a region best
    // is the one told it has nothing there. Trimming the top decile before
    // computing the baseline breaks that feedback — the region can no longer
    // inflate the sd it is being judged against.
    const asc = scored.map((x) => x.s).sort((a, b) => a - b);
    const keep = asc.slice(0, Math.max(2, Math.floor(asc.length * 0.9)));
    const mean = keep.reduce((a, x) => a + x, 0) / keep.length;
    const sd = Math.sqrt(keep.reduce((a, x) => a + (x - mean) ** 2, 0) / keep.length) || 1e-9;
    scored.sort((a, b) => b.s - a.s);
    const sharpness = (scored[0].s - mean) / sd;
    // The best of n roughly-normal scores sits near sqrt(2·ln n) — the mode of
    // that maximum, not its mean, so this line is conservative by roughly 15%
    // and `standout` medians ~0.85 on pure noise rather than 1.0. Stated against
    // THAT rather than 1σ, because 1σ admits ~16% of any shelf of any size for
    // any direction — measured, 3,284 rows of a 20,986-row archive "supplied" a
    // region it barely touches.
    const chance = Math.sqrt(2 * Math.log(Math.max(2, scored.length)));
    const floor = mean + Math.max(z, chance) * sd;
    return {
        scored: scored.length,
        // Rows that beat chance, not rows that beat the mean: for pure noise
        // this is 1 by construction, so 3 of them is inventory.
        depth: scored.filter((x) => x.s >= floor).length,
        sharpness: +sharpness.toFixed(2),
        // >1 means the best row stands out further than the best of this many
        // arbitrary rows would. This, and not `depth`, decides the verdict.
        standout: +(sharpness / chance).toFixed(2),
        chance: +chance.toFixed(2),
        top: scored.slice(0, limit).map((x) => ({
            id: x.r.id, z: +((x.s - mean) / sd).toFixed(2),
            ...(title && x.r[title] !== undefined ? { title: String(x.r[title]) } : {}),
        })),
    };
}

/**
 * The verdict. Five outcomes, because there are five different things a
 * publisher does next and each costs a different amount of money.
 *
 * The pair that matters is (does attention go there) × (does the shelf answer
 * it). Sentiment splits the served case, and only that case: a region nobody
 * visits has no sentiment worth acting on, and a region the shelf cannot answer
 * has no sentiment about the shelf at all.
 */
export function verdict({ perReader, sentiment, standout, depth, stands = STANDOUT, thin = THIN, floor = ATTENTION_FLOOR }) {
    const warm = perReader >= floor;
    const stocked = depth >= thin;
    // A direction that is no sharper against this shelf than a random one is not
    // a finding about the shelf, it is a finding about the question: an anchor
    // admitting a third of the catalogue returns the catalogue's own centre, and
    // ranking a shelf against its own centre is a sorted list of nothing. This
    // is Remark 9.3 arriving from the other side — the fix is a narrower
    // percentile, and saying so is more useful than a confident verdict.
    if (standout < stands) {
        return { verdict: "diffuse", act: `the answer is no sharper against your shelf than chance (${standout}) — narrow the anchor percentile and ask again` };
    }
    if (warm && !stocked) return { verdict: "commission", act: "demand you do not serve — this is the one worth money" };
    if (warm && stocked && (sentiment ?? 0) < 0) return { verdict: "fix", act: "they find it and bounce — check the free projection, the price, or the file" };
    if (warm && stocked) return { verdict: "serve", act: "working — promote it, and price the next one like it" };
    if (!warm && stocked) return { verdict: "retire", act: "shelf you carry and nobody walks to" };
    return { verdict: "cold", act: "no demand and no supply — ignore" };
}

/**
 * One question, answered.
 *
 * `question` is the publisher's own words, `readout` is cohort.js's, verbatim.
 * `revenue` is what the publisher's own sales ledger says the top rows earned —
 * supplied by the caller because the ledger is the app's, not the library's.
 */
export function finding({ question, readout: out, shelf, vocab, roles = {}, opts = {} }) {
    const base = { question, readers: out.readers, matched: out.matched, perReader: out.perReader, sentiment: out.sentiment };
    if (!out.ok) return { ...base, verdict: "failed", act: out.why, terms: [], top: [] };
    if (!out.centroid) {
        // Counts survive; the direction does not. Reported as a finding rather
        // than dropped, because "we asked and it was too narrow to answer" is
        // itself a fact about the region, and the next question depends on it.
        return { ...base, verdict: "withheld", act: `${out.withheld} Widen the anchor or pool more rounds.`, terms: [], top: [] };
    }
    const sup = supply(shelf, out.centroid, { ...opts, title: roles.title ?? null });
    return {
        ...base,
        ...verdict({ perReader: out.perReader, sentiment: out.sentiment, standout: sup.standout, depth: sup.depth, ...opts }),
        terms: affinities(vocab, out.centroid, { limit: 5 }),
        depth: sup.depth, sharpness: sup.sharpness, standout: sup.standout, chance: sup.chance, ofRows: sup.scored,
        top: sup.top,
    };
}

/**
 * Where demand is MOVING — the one thing a single round cannot say.
 *
 * ONE QUESTION, ASKED REPEATEDLY. This is not a detail. Two centroids answering
 * two DIFFERENT anchors differ because the questions differ, and subtracting one
 * from the other measures the publisher's own choice of anchor, not any movement
 * in demand. Handed a mixed series it would print a confident heading off a
 * quantity nobody measured — so the mixed series is refused by name.
 *
 * `series` is `[{ question, centroid }]` in time order. It is a heading, not a
 * place, so it is named with `center: false`: subtracting the catalogue's centre
 * from a difference is meaningless (taste-doc says the same of the kernel's `v`).
 */
export function heading(series = [], vocab, { limit = 4 } = {}) {
    const byQ = new Map();
    for (const x of series.filter((y) => y?.centroid?.length)) byQ.set(x.question, [...(byQ.get(x.question) ?? []), x]);
    // The LONGEST run of one question, never the pooled set: centroids answering
    // different anchors differ because the anchors differ, and their difference
    // measures the publisher's own choice of question.
    const ok = [...byQ.values()].sort((a, b) => b.length - a.length)[0] ?? [];
    if (ok.length < 4) {
        return { terms: [], why: byQ.size > 1
            ? `no question has been asked enough times — ${byQ.size} different questions, the most-repeated answered ${ok.length} time${ok.length === 1 ? "" : "s"}, 4 needed. `
              + "Two anchors differ because the anchors differ; that is not a movement in demand."
            : `a heading needs two windows — ${ok.length} answered round${ok.length === 1 ? "" : "s"} so far, 4 minimum` };
    }
    const half = Math.floor(ok.length / 2);
    const mean = (xs) => xs[0].centroid.map((_, i) => xs.reduce((a, v) => a + v.centroid[i], 0) / xs.length);
    const older = mean(ok.slice(0, half)), later = mean(ok.slice(half));
    const d = later.map((x, i) => x - older[i]);
    // `affinities` unit-normalises whatever it is handed, which throws away the
    // one quantity that says whether demand moved AT ALL. Without this check a
    // static series with 2% sampling noise was named a heading 199 times out of
    // 200 — the "has not moved enough" branch was dead code. The movement has to
    // clear the spread WITHIN each window before it is a movement between them.
    const mag = Math.sqrt(d.reduce((a, x) => a + x * x, 0));
    const spread = (xs, m) => Math.sqrt(xs.reduce((a, v) =>
        a + v.centroid.reduce((b, x, i) => b + (x - m[i]) ** 2, 0), 0) / Math.max(1, xs.length));
    const wobble = Math.max(spread(ok.slice(0, half), older), spread(ok.slice(half), later));
    // Two windows of k samples drawn from ONE static distribution still have
    // means about wobble·sqrt(2/k) apart. That, not the wobble itself, is what a
    // real movement has to beat — and it has to beat it by a margin, because
    // being right about half the static series is not a guard.
    const noise = 2 * wobble * Math.sqrt(2 / Math.max(1, half));
    if (mag <= noise) {
        return { terms: [], rounds: ok.length,
            why: `demand has not moved: the shift between windows (${mag.toFixed(3)}) is inside what ${half} rounds of a standing question would show anyway (${noise.toFixed(3)})` };
    }
    const terms = affinities(vocab, d, { limit, center: false });
    return terms.length
        ? { terms, rounds: ok.length, question: ok[0].question }
        : { terms: [], why: "demand has not moved enough to name a heading" };
}

/**
 * The report. `probes` are `[{ question, readout }]`, in time order.
 *
 * `spend` is the plain arithmetic a publisher needs before the next round and
 * which nothing else in this repo was doing: what the answers cost, against what
 * the rows they point at have actually earned. No projection — earned, from the
 * caller's own ledger.
 */
export function demandReport({ shelf = [], roles = {}, probes = [], paidPerReader = 0n, earned = null, opts = {} } = {}) {
    // THE VOCABULARY MUST LIVE AT THE ANSWER'S DIMENSION. A cohort centroid is
    // 128-d and a shelf vector is 256-d; a term direction built at 256 and
    // compared against a 128-d answer reads `undefined` past the halfway point
    // and the dot product is NaN, which `affinities` filters out as "below the
    // floor" — so every region came back unnameable and nothing errored. Found
    // against a real 20,986-row shelf that declares seven tag fields.
    const dim = Math.min(...probes.map((p) => p.readout?.centroid?.length ?? Infinity));
    const cut = Number.isFinite(dim)
        ? shelf.map((r) => (r.vector?.length > dim ? { ...r, vector: r.vector.slice(0, dim) } : r))
        : shelf;
    const vocab = vocabulary(cut, roles, opts.minSupport ? { minSupport: opts.minSupport } : {});
    const findings = probes.map((p) => finding({ ...p, shelf, vocab, roles, opts }));
    const spent = probes.reduce((a, p) => a + BigInt(p.readout?.readers ?? 0) * BigInt(paidPerReader), 0n);
    return {
        unsafe: differencing(probes),
        shelf: { rows: shelf.length, vectors: shelf.filter((r) => r.vector?.length).length, terms: vocab.terms.length, dim: Number.isFinite(dim) ? dim : null },
        findings,
        heading: heading(probes.map((p, i) => (findings[i].verdict === "withheld" || findings[i].verdict === "failed"
            ? null : { question: p.question, centroid: p.readout.centroid })), vocab),
        spend: { probes: probes.length, paidToReaders: spent, shelfEarned: earned },
        blind: findings.filter((f) => f.verdict === "withheld" || f.verdict === "failed").map((f) => f.question),
    };
}

/**
 * The attack the per-round floor cannot see.
 *
 * cohort.js guards ONE round: five readers, five matched reactions, or no
 * direction. Nothing in it composes across rounds, and this file is what made
 * composing them a product — `probes` is an array and `heading` asks for four.
 *
 * Two rounds on the same anchor at slightly different widths return two answered
 * directions, both far above the floor, whose difference is the handful of
 * reactions that fell between the widths. Measured against a 400-row catalogue
 * and 8 readers: matched 39 and 38, the normalised difference of the two
 * centroids landed at cosine 1.0000 on one public row — one reader's film,
 * recovered exactly, from two rounds that individually disclosed nothing.
 *
 * The floor is on rows per round; this has to be on the SERIES, and this file is
 * the only one that sees a series. So the report names the pairs rather than
 * pretending the per-round guard covered them.
 *
 * ponytail: named, not enforced. A budget that refuses to compute is the right
 * mechanism and it belongs where rounds are PAID FOR — refusing here only moves
 * the arithmetic one file over, since the publisher holds both readouts either
 * way. What this can do honestly is refuse to be the tool that performs it, and
 * say so at the top of the brief.
 */
export const CLOSE = 5;

export function differencing(probes = [], { close = CLOSE } = {}) {
    const answered = probes.map((p, i) => ({ i, q: p.question, r: p.readout }))
        .filter((x) => x.r?.ok && x.r.centroid);
    const out = [];
    for (let a = 0; a < answered.length; a++) {
        for (let b = a + 1; b < answered.length; b++) {
            const gap = Math.abs(answered[a].r.matched - answered[b].r.matched);
            if (gap === 0 || gap >= close) continue;
            out.push({ questions: [answered[a].q, answered[b].q], matched: [answered[a].r.matched, answered[b].r.matched], gap });
        }
    }
    return out;
}

const usd = (base) => `${(Number(base) / 1e6).toFixed(2)} USDC`;
const named = (ts) => (ts.length ? ts.map((t) => `${t.value}`).join(", ") : "an unnamed region — no declared tag of yours describes it");

/**
 * The brief, as an agent reads it out.
 *
 * Markdown rather than a table of numbers, because the consumer of this is a
 * publisher's agent answering "what should I make next", and the answer to that
 * is a sentence. Every number in it is measured; nothing is projected.
 */
export function brief(rep, { title = "demand" } = {}) {
    const order = { commission: 0, fix: 1, serve: 2, retire: 3, diffuse: 4, withheld: 5, cold: 6, failed: 7 };
    // One question asked weekly is ONE finding with six rounds behind it, not six
    // findings. Printing it six times buries the one question that was asked once
    // and mattered, which is the failure mode of every dashboard.
    const seen = new Map();
    for (const f of rep.findings) {
        const k = `${f.question}|${f.verdict}`;
        const p = seen.get(k);
        if (p) { p.rounds++; p.matched = Math.round((p.matched * (p.rounds - 1) + f.matched) / p.rounds); }
        else seen.set(k, { ...f, rounds: 1 });
    }
    const fs = [...seen.values()].sort((a, b) => (order[a.verdict] ?? 9) - (order[b.verdict] ?? 9));
    const L = [`# ${title}`, "",
        `${rep.shelf.rows} rows on your shelf, ${rep.shelf.vectors} with vectors, ${rep.shelf.terms} of your tags carry enough rows to name a region.`,
        `${rep.spend.probes} question${rep.spend.probes === 1 ? "" : "s"} asked, ${usd(rep.spend.paidToReaders)} paid to readers.`
        + (rep.spend.shelfEarned === null ? "" : ` This shelf has earned ${usd(rep.spend.shelfEarned)} over the same period.`), ""];
    if (rep.unsafe?.length) {
        L.push("> **Do not difference these answers.** " + rep.unsafe.map((u) =>
            `“${u.questions[0]}” and “${u.questions[1]}” matched ${u.matched.join(" and ")} reactions`).join("; ")
            + `. Two answers ${rep.unsafe[0].gap} reaction${rep.unsafe[0].gap === 1 ? "" : "s"} apart differ by those reactions, `
            + "and a reaction's vector is a copy of a row anyone can download. The per-round floor does not see a series.", "");
    }

    for (const f of fs) {
        L.push(`## ${f.verdict} — ${f.question}`);
        L.push(`*${f.act}*`, "");
        // A failed round's totals are noise, so there are no counts to print —
        // `readout` returns only `{ok, why}` and everything else renders
        // "undefined reactions from undefined readers", which reads as data.
        if (f.verdict === "failed") { L.push(""); continue; }
        L.push((f.rounds > 1 ? `asked ${f.rounds}×, mean ` : "") + `${f.matched} reaction${f.matched === 1 ? "" : "s"} from ${f.readers} readers (${f.perReader}/reader)`
            + (f.sentiment === null ? "" : `, sentiment ${f.sentiment > 0 ? "+" : ""}${f.sentiment}`) + ".");
        if (f.verdict === "withheld") { L.push(""); continue; }
        if (f.verdict === "diffuse") { L.push(`Your shelf: best row at ${f.sharpness}σ against ${f.chance}σ for the best of ${f.ofRows} arbitrary rows.`, ""); continue; }
        L.push(`Demand points at: **${named(f.terms)}**.`);
        L.push(`Your shelf: best row at ${f.sharpness}σ against ${f.chance}σ for the best of ${f.ofRows} arbitrary rows — standout ${f.standout}.`);
        if (f.top.length) L.push("", ...f.top.map((t) => `- ${t.title ? `**${t.title}**` : `\`${t.id}\``} ${t.z}σ`));
        L.push("");
    }
    L.push("## heading", "");
    L.push(rep.heading.terms.length
        ? `Demand is moving toward **${named(rep.heading.terms)}** over ${rep.heading.rounds} answered rounds.`
        : rep.heading.why);
    if (rep.blind.length) L.push("", "## not answered", "", ...rep.blind.map((q) => `- ${q}`));
    return L.join("\n");
}

// ── self-check: `node publish/demand.js` ────────────────────────────────────
if (typeof process !== "undefined" && import.meta.url === `file://${process.argv[1]}`) {
    const { keypair, statistics, contribute, aggregate, readout } = await import("./cohort.js");

    // A shelf with two genuine regions and a hole between them. 128 dims so the
    // shelf and a cohort centroid line up without truncation doing the work.
    const D = 128;
    const axis = (k) => { const v = new Float32Array(D); v[k] = 1; return v; };
    const jitter = (v, i) => { const o = Float32Array.from(v); o[(i * 7) % D] += 0.08; return o; };
    // A deterministic background of 200 unrelated rows, because a shelf of
    // nothing but two clusters has an sd so wide that NO row clears the chance
    // line, and the statistic below is calibrated for a real catalogue whose
    // cosines against one direction are roughly normal. The toy shelf without
    // this background reported depth 0 for a region it obviously serves.
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) - 0.5;
    const shelf = [
        ...Array.from({ length: 200 }, (_, i) => ({
            id: `bg-${i}`, vector: Float32Array.from({ length: D }, rnd), genre: "misc", year: 1970,
        })),
        ...Array.from({ length: 12 }, (_, i) => ({ id: `sub-${i}`, vector: jitter(axis(0), i), genre: "submarine", year: 1960 })),
        ...Array.from({ length: 12 }, (_, i) => ({ id: `cartoon-${i}`, vector: jitter(axis(1), i), genre: "cartoon", year: 1950 })),
        // Two rows only, in a third direction: a region the shelf does not serve.
        ...Array.from({ length: 2 }, (_, i) => ({ id: `noir-${i}`, vector: jitter(axis(2), i), genre: "noir", year: 1948 })),
    ];
    const roles = { tags: ["genre"] };
    const vocab = vocabulary(shelf, roles);
    if (vocab.terms.length !== 3) throw new Error(`only tags with real support may name a region: ${vocab.terms.length}`);
    if (vocab.terms.some((t) => t.value === "noir")) throw new Error("two rows is below the support floor — noir must not be a term");

    // ── the shelf's own sigma, not a cosine ───────────────────────────────
    const sub = supply(shelf, Array.from(axis(0)));
    const noir = supply(shelf, Array.from(axis(2)));
    if (sub.depth < 10) throw new Error(`the shelf answers submarine deeply: ${sub.depth}`);
    if (noir.depth > 4) throw new Error(`…and answers noir with almost nothing: ${noir.depth}`);
    if (!(sub.sharpness > 1)) throw new Error("a served direction stands above the shelf's own mean");
    if (!sub.top[0].id.startsWith("sub-")) throw new Error("the top row must be from the region asked about");

    // ── a real round, end to end, through cohort.js ────────────────────────
    // Six readers who all reacted in the noir direction: attention with no supply.
    const R = 6;
    const log = (seed) => Array.from({ length: 4 }, (_, i) => ({
        id: `x${seed}${i}`, corpus: "films", reaction: "like", vector: jitter(axis(2), seed + i),
    }));
    const ks = []; for (let i = 0; i < R; i++) ks.push(await keypair());
    const pubs = ks.map((k) => k.pub);
    const run = async (logs) => {
        const shares = [];
        for (let i = 0; i < R; i++) shares.push(await contribute(statistics(logs[i], { corpus: "films" }), ks[i], pubs));
        return readout(aggregate(shares), R);
    };
    const hot = await run(Array.from({ length: R }, (_, i) => log(i)));
    if (!hot.ok || !hot.centroid) throw new Error("24 reactions from 6 readers is answerable");

    const rep = demandReport({
        shelf, roles,
        probes: [{ question: "how did readers react around our noir?", readout: hot }],
        paidPerReader: 1000n,
        revenue: (id) => (id.startsWith("noir") ? 250000n : 0n),
    });
    const f = rep.findings[0];
    if (f.verdict !== "commission") throw new Error(`attention with no supply is a commission, not a ${f.verdict}`);
    if (!f.act.includes("do not serve")) throw new Error("the verdict must name the action, not just the label");
    if (f.terms.length) throw new Error("no declared tag of this publisher describes the noir region — it must say so, not pick the nearest tag");
    if (rep.spend.paidToReaders !== 6000n) throw new Error(`six readers at 1000 base units: ${rep.spend.paidToReaders}`);

    // Same shelf, attention in a direction it DOES serve: the verdict flips, and
    // nothing else about the machinery changes.
    const served = await run(Array.from({ length: R }, (_, i) =>
        Array.from({ length: 4 }, (_, j) => ({ id: `s${i}${j}`, corpus: "films", reaction: "like", vector: jitter(axis(0), i + j) }))));
    const rep2 = demandReport({ shelf, roles, probes: [{ question: "and around our submarines?", readout: served }] });
    if (rep2.findings[0].verdict !== "serve") throw new Error(`attention the shelf answers is "serve": ${rep2.findings[0].verdict}`);
    if (rep2.findings[0].terms[0]?.value !== "submarine") throw new Error("…and it is named in the publisher's OWN tag");

    // Attention the shelf answers, and readers bounce off: a different action.
    const bounced = { ...served, sentiment: -0.6 };
    if (demandReport({ shelf, roles, probes: [{ question: "q", readout: bounced }] }).findings[0].verdict !== "fix") {
        throw new Error("supply + attention + negative sentiment is a fix, not a promotion");
    }
    // Supply nobody walks to.
    const quiet = { ...served, perReader: 0.1 };
    if (demandReport({ shelf, roles, probes: [{ question: "q", readout: quiet }] }).findings[0].verdict !== "retire") {
        throw new Error("shelf with no attention is shelf to retire");
    }

    // ── a withheld direction stays withheld, all the way to the brief ──────
    // This is the one that would quietly undo cohort.js: the round correctly
    // refuses to name a direction over one reaction, and a report that filled it
    // in from the nearest shelf row would publish exactly the row the floor
    // exists to hide.
    const lonely = [log(0).slice(0, 1), ...Array.from({ length: R - 1 }, () => [])];
    const thin = await run(lonely);
    if (thin.centroid) throw new Error("cohort.js should have withheld this");
    const rep3 = demandReport({ shelf, roles, probes: [{ question: "the narrow one", readout: thin }] });
    if (rep3.findings[0].verdict !== "withheld") throw new Error("a withheld direction is a withheld finding");
    if (rep3.findings[0].terms.length || rep3.findings[0].top?.length) throw new Error("a withheld finding names NOTHING on the shelf");
    if (!rep3.blind.includes("the narrow one")) throw new Error("and the report says which questions it could not answer");
    const b3 = brief(rep3);
    if (/noir|sub-|cartoon/.test(b3)) throw new Error("no shelf row may appear in a brief built on a withheld direction");
    if (!b3.includes("Widen")) throw new Error("the brief must tell the publisher what to do about it");

    // ── the differencing oracle the per-round floor cannot see ─────────────
    // Two answers a few reactions apart differ BY those reactions, and every
    // reaction vector is a copy of a public row. Both rounds here are far above
    // MIN_SUPPORT and neither discloses anything on its own.
    const wide = { ...hot, matched: 39 }, narrow = { ...hot, matched: 38 };
    const risky = demandReport({ shelf, roles, probes: [
        { question: "near our noir, top 2.5%", readout: wide },
        { question: "near our noir, top 3.0%", readout: narrow }] });
    if (risky.unsafe.length !== 1) throw new Error("two answers one reaction apart must be named as a pair");
    if (!brief(risky).includes("Do not difference")) throw new Error("…at the top of the brief, before any finding");
    const apart = demandReport({ shelf, roles, probes: [
        { question: "a", readout: { ...hot, matched: 40 } },
        { question: "b", readout: { ...hot, matched: 12 } }] });
    if (apart.unsafe.length) throw new Error("answers far apart are not a differencing pair");

    // ── a failed round prints no counts, because it HAS none ───────────────
    const broke = brief(demandReport({ shelf, roles, probes: [{ question: "q", readout: { ok: false, why: "the masks did not cancel" } }] }));
    if (broke.includes("undefined")) throw new Error("a failed round must not render undefined as a measurement");

    // ── the heading needs two windows and refuses to invent one ────────────
    const one = demandReport({ shelf, roles, probes: [{ question: "q", readout: hot }] });
    if (one.heading.terms.length) throw new Error("one round is not a heading");
    if (!one.heading.why.includes("4 minimum")) throw new Error("…and it must say why rather than returning empty");
    const drift = [axis(0), axis(0), axis(1), axis(1)].map((v) => ({ question: "same one, weekly", centroid: Array.from(v) }));
    const h = heading(drift, vocab);
    // A static series must not be named. `affinities` unit-normalises the
    // difference, so without a magnitude check every series has a heading.
    const noisy = () => { const v = Array.from(axis(0)); for (let i = 0; i < D; i++) v[i] += rnd() * 0.04; return v; };
    const still = Array.from({ length: 6 }, () => ({ question: "s", centroid: noisy() }));
    if (heading(still, vocab).terms.length) throw new Error("a series that did not move has no heading");
    if (!heading(still, vocab).why.includes("has not moved")) throw new Error("…and it must compare the shift to the wobble");
    // …and a series of DIFFERENT questions is not a heading at all.
    const mixed = drift.map((x, i) => ({ ...x, question: `q${i}` }));
    if (heading(mixed, vocab).terms.length) throw new Error("four different questions are not a time series");
    if (!heading(mixed, vocab).why.includes("anchors differ")) throw new Error("…and it must say exactly why");
    if (h.terms[0]?.value !== "cartoon") throw new Error(`a heading is where demand MOVED to, in the publisher's tags: ${JSON.stringify(h.terms)}`);

    // ── the brief is what an agent reads ──────────────────────────────────
    const text = brief(demandReport({
        shelf, roles,
        probes: [{ question: "noir?", readout: hot }, { question: "submarines?", readout: served }],
        paidPerReader: 1000n, revenue: (id) => (id.startsWith("sub") ? 50000n : 0n),
    }));
    if (text.indexOf("## commission") > text.indexOf("## serve")) throw new Error("the money finding goes first — a brief is read from the top");
    if (!text.includes("0.01 USDC")) throw new Error("what it cost, in money, not base units");
    if (!text.includes("submarine")) throw new Error("the served region is named in the publisher's own vocabulary");

    console.log("demand.js self-check ok — a direction is named in the publisher's own declared tags or admitted to be unnameable, "
        + "supply is measured in the shelf's own sigma so two questions are comparable, attention without supply is the finding "
        + "worth money and sorts to the top, a withheld direction names nothing on the shelf all the way through the brief, "
        + "a heading refuses to exist before two windows of ONE repeated question, and the spend is stated in money");
}
