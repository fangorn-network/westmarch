// A market of people, run end to end.
//
// Everything here is real except the money: real corpora over HTTP, real vectors,
// real embeddings-space arithmetic, real ECDH. What it demonstrates, in order:
//
//   1. two humans consume media through their own agents, and the agent learns
//      a taste vector that never leaves the machine
//   2. that taste ranks a catalogue it was not learned in — cross-catalogue
//      discovery falls out of a shared embedding, with no shared schema
//   3. a reader sells their own reactions, and the corpora they watched are paid
//      out of that sale
//   4. a publisher buys an ANSWER about its catalogue from a cohort of readers,
//      and every reader is paid identically for it
//   5. what the publisher can and cannot reconstruct, measured rather than claimed
//
// Run:  node simulate.mjs            (needs the fixtures on MARKET_BASE)
import { configure, domainManifests, loadShard, resetShard, trimView } from "@fangorn/westmarch/shard";
import { rolesFrom, textOf, titleOf } from "@fangorn/westmarch/roles";
import { taste, recommend, exportTaste } from "@fangorn/westmarch/taste";
import { label, splitPayment } from "@fangorn/westmarch/terms";
import { MIN_COHORT, aggregate, contribute, keypair, readout, statistics } from "@fangorn/westmarch/cohort";
import { reactionCorpus } from "@fangorn/westmarch/reactions";
import { search } from "./tools.js";
import { SEED, ADDR, wallet, buy, sellTaste, cohort, books } from "./market.mjs";

const BASE = process.env.MARKET_BASE ?? "http://127.0.0.1:5180";
const H = (t) => console.log(`\n\x1b[1m${t}\x1b[0m\n${"─".repeat(t.length)}`);
const P = (...a) => console.log(" ", ...a);

// ── the world ───────────────────────────────────────────────────────────────
const held = new Map();
configure({ onManifests: (ms, v) => held.set(v, rolesFrom(ms)), rowText: (f, v) => textOf(f, held.get(v) ?? { text: [] }) });

const corpora = {};
async function open(name) {
    if (corpora[name]) return corpora[name];
    const view = trimView(`${BASE}/${name}`);
    const rows = await loadShard(view);
    return (corpora[name] = { rows, roles: rolesFrom(domainManifests(view), rows) });
}

/** One person's agent: it searches, it reacts, and it keeps the taste locally. */
class Agent {
    constructor(person, brief) { this.person = person; this.brief = brief; this.log = []; }
    /** `wants` are `[query, "like"|"skip"]` — the person's actual verdict, not a
     *  position in a list. A simulation that decides the reaction by index is
     *  simulating a random number generator, and `taste()` leans on the
     *  difference between what was liked and what was rejected. */
    async consume(corpus, wants) {
        const { rows, roles } = await open(corpus);
        const by = new Map(rows.map((r) => [r.id, r]));
        for (const [q, reaction = "like"] of wants) {
            const [hit] = search(rows, q, roles, { limit: 1 });
            if (!hit || this.log.some((e) => e.id === hit.id)) continue;
            const row = by.get(hit.id);
            this.log.push({
                id: hit.id, corpus, title: titleOf(row, roles), reaction,
                at: new Date(Date.UTC(2026, 8, 1 + this.log.length)).toISOString(), v: [...row.vector],
            });
        }
        return this;
    }
    get taste() {
        const as = (k) => this.log.filter((e) => e.reaction === k).map((e) => ({ id: e.id, title: e.title, vector: Float32Array.from(e.v) }));
        return taste(as("like"), as("skip"));
    }
}

// ── 1. two humans, two agents, private taste ────────────────────────────────
H("1 · two people consume, through their own agents");

const ada = await new Agent("Ada", "silent horror and early expressionist cinema")
    .consume("archive-films", [
        ["german expressionist silent horror", "like"], ["vampire nosferatu murnau", "like"],
        ["metropolis fritz lang futurist city", "like"], ["gothic castle shadows dread", "like"],
        ["1950s laugh track family sitcom", "skip"], ["celebrity cooking demonstration", "skip"]]);
const boris = await new Agent("Boris", "detective plots and deduction")
    .consume("archive-films", [
        ["hard boiled detective murder mystery", "like"], ["film noir private investigator", "like"],
        ["courtroom trial evidence testimony", "like"], ["ellery queen whodunit deduction", "like"],
        ["musical variety dance number", "skip"], ["children's cartoon animation", "skip"]]);

for (const a of [ada, boris]) {
    P(`\x1b[1m${a.person}\x1b[0m — "${a.brief}"`);
    for (const e of a.log) P(`   ${e.reaction === "like" ? "♥" : "·"} ${e.title.slice(0, 58)}`);
    P(`   taste: ${exportTaste(a.taste).mu.length} chars of base64, held on ${a.person}'s machine and nowhere else\n`);
}

// ── 2. taste crosses a catalogue it never saw ───────────────────────────────
H("2 · that taste ranks a catalogue it was never learned in");
const games = await open("games");
for (const a of [ada, boris]) {
    const recs = recommend(games.rows, a.taste, { limit: 3 });
    P(`\x1b[1m${a.person}\x1b[0m's film taste, pointed at ${games.rows.length.toLocaleString()} games:`);
    for (const { row, score } of recs) P(`   ${score.toFixed(3)}  ${titleOf(row, games.roles).slice(0, 56)}`);
    P("");
}
P("No shared schema, no shared ids, no publisher agreement — one embedding space.");

// ── 3. a reader sells their own reactions, and pays the corpora they watched ─
H("3 · Ada sells her reactions; the corpora she watched are paid out of the sale");
const m = structuredClone(SEED);
m.reactions = {};
wallet(m, "ada").budget = 0n; wallet(m, "boris").budget = 0n;
m.reactions.ada = ada.log; m.reactions.boris = boris.log;
const sold = sellTaste(m, "ada", 200_000n);
P(`published "${sold.published}" — ${sold.reactions} reactions, ${sold.coverage}`);
P(`free row:  ${JSON.stringify(sold.freeRowLooksLike)}`);
P(`sold:      ${sold.sells.join(", ")}`);
P(`owes:      ${sold.owes.join(", ") || "nothing"}`);
wallet(m, "trainer").budget = 400_000n;
buy(m, "trainer", "ada-taste");
for (const p of m.payments.at(-1).payouts) {
    const who = p.to === m.terms.owner ? `app ${m.terms.appId}`
        : Object.entries(m.publishers).find(([, x]) => x.addr === p.to)?.[0]
        ?? Object.entries(m.agents).find(([, x]) => x.addr === p.to)?.[0] ?? p.to;
    P(`  ${label(p.amount).padStart(12)}  ${who}`);
}

// ── 4. a publisher buys an answer, not the rows ─────────────────────────────
H("4 · a publisher asks the cohort about its own catalogue");

// Four more readers, so a cohort exists at all. Different briefs, so the answer
// is an aggregate over disagreement rather than five copies of one opinion.
const others = [
    ["Cleo", [["newsreel wartime footage", "like"], ["documentary industrial process", "like"], ["horror monster", "skip"]]],
    ["Dev", [["science fiction space rocket", "like"], ["monster creature feature", "like"], ["romance melodrama", "skip"]]],
    ["Esme", [["german expressionist shadows", "like"], ["silent film intertitles", "like"], ["sports broadcast", "skip"]]],
    ["Finn", [["serial cliffhanger adventure", "like"], ["boxing sports drama", "like"], ["opera performance", "skip"]]],
];
for (const [who, ws] of others) m.reactions[who.toLowerCase()] = (await new Agent(who, "").consume("archive-films", ws)).log;
for (const n of Object.keys(m.reactions)) wallet(m, n);
wallet(m, "archivehouse").budget = 1_000_000n;

P(`${Object.keys(m.reactions).length} readers hold logs. Floor is ${MIN_COHORT}.`);
P(`Nobody sends a log anywhere. Each answers on their own machine and masks the answer.\n`);
// A publisher owns its catalogue, so it asks pointed questions without an
// embedding model: it names one of its own rows and asks how the cohort reacted
// around there. Three questions about three shelves, one budget each.
const films = await open("archive-films");
const rank = (centroid, n = 4) => {
    const c = Float32Array.from(centroid);
    return films.rows.map((r) => {
        let s = 0; for (let i = 0; i < c.length; i++) s += c[i] * r.vector[i];
        return { r, s: s / (r.norm || 1) };
    }).sort((x, y) => y.s - x.s).slice(0, n);
};

let A = null, round = null;
for (const [anchor, pct] of [["nosferatu vampire silent horror", 0.02], ["nosferatu vampire silent horror", 0.35],
                             ["detective murder investigation", 0.35], [null, 1]]) {
    round = await cohort(m, "archivehouse", 200_000n, "archive-films", anchor, pct);
    A = round.answer;
    P(`\x1b[1m${round.asked}\x1b[0m`);
    if (!A.matched) { P(`   nothing matched — and the ${A.readers} readers were paid anyway, which is the point\n`); continue; }
    P(`   ${A.readers} readers · ${A.matched} reactions matched · ${A.like} liked, ${A.skip} skipped`);
    P(`   sentiment ${A.sentiment >= 0 ? "+" : ""}${A.sentiment}   ·   each reader paid ${round.eachReaderGot}, identically`);
    if (!A.centroid) { P(`   \x1b[33m${A.withheld}\x1b[0m\n`); continue; }
    P(`   attention pointed at the publisher's own shelf:`);
    for (const { r } of rank(A.centroid)) P(`      ${titleOf(r, films.roles).slice(0, 58)}`);
    P("");
}

// ── 5. what it can and cannot reconstruct ───────────────────────────────────
H("5 · what the publisher can and cannot reconstruct");
P("\x1b[1mCan:\x1b[0m");
for (const x of round.publisherLearns) P(`   ✓ ${x}`);
P("\x1b[1mCannot:\x1b[0m");
for (const x of round.publisherDoesNotLearn) P(`   ✗ ${x}`);

// The business answer, which is the whole reason a publisher pays: the same
// catalogue, asked about in two places, scores differently. That is a
// commissioning decision, and it was reached without holding one person's log.
const byRegion = m.rounds.filter((r) => r.answer.centroid && r.about.startsWith("the region"));
if (byRegion.length >= 2) {
    P("\n\x1b[1m  what the publisher does with this:\x1b[0m");
    for (const r of byRegion) {
        P(`     ${r.about.replace(/ \(top.*/, "").padEnd(46)} sentiment ${r.answer.sentiment >= 0 ? "+" : ""}${r.answer.sentiment}  (${r.answer.matched} reactions)`);
    }
    const [best] = [...byRegion].sort((x, y) => y.answer.sentiment - x.answer.sentiment);
    P(`     → the ${best.about.replace(/ \(top.*/, "").replace("the region around ", "")} shelf outperforms. Commission there.`);
}

// Measured, not asserted: try to identify one reader's titles from the answer.
const truth = new Set(m.reactions.ada.map((e) => e.title));
const recovered = A.centroid ? rank(A.centroid, 25).map(({ r }) => titleOf(r, films.roles)) : [];
const overlap = recovered.filter((t) => truth.has(t));
P(`\n\x1b[1m  attack\x1b[0m — take the published centroid, rank the publisher's shelf, and read off`);
P(`  the top 25 as "what Ada watched": ${overlap.length} of Ada's ${truth.size} titles appear.`);
P(`  The centroid is the sum of ${A.readers} readers, so a hit is the cohort agreeing,`);
P(`  not Ada being identified — and nothing in the answer says which reader supplied it.`);

const b = books(m);
P(`\n  books: ${b.sales} sales, ${label(b.paid)} moved, payouts == payments == agent spend.`);
const paid = m.payments.at(-1).payouts.filter((p) => p.to !== m.terms.owner).map((p) => p.amount);
if (new Set(paid.map(String)).size !== 1) throw new Error("readers must be paid IDENTICALLY — an unequal payment is a disclosure");
P(`  every reader payment identical: ${label(paid[0])} × ${paid.length}`);
