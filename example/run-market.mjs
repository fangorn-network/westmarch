// The whole market, once, in one process.
//
// Run: `node run-market.mjs`. No server to start, no chain, no GPU, no model
// download, no keys. It serves the fixture bundles to itself, drives readers and
// publishers through the same verbs the CLI uses, and writes the result to
// market-report.json for the report page to render.
//
// WHAT IT IS FOR
// --------------
// Two claims in this repo had never been run against each other:
//
//   "a publisher publishes ONCE and accrues value as the thing is bought, cited
//    and resold"  —  and  —  "a reader is paid for signal nobody can trace back
//    to them".
//
// Both are mechanisms with self-checks. Neither had a number attached, because
// nothing in the repo ran both halves in one economy over more than one moment.
// This does, and prints the ledger, so the claims are either supported by an
// arithmetic anyone can re-run or they are not.
//
// WHY NO EMBEDDING MODEL
// ----------------------
// Every vector here comes off a shard that was already baked. A reader reacts to
// a row it downloaded, and the reaction carries THAT row's vector; a publisher
// anchors a question on one of its own rows. Neither side ever needs to embed
// anything, which is why this runs in seconds on a laptop with no CUDA — the
// expensive half of quickbeam is the bake, and the bake already happened.
// Queries are matched lexically, exactly as `search()` degrades when no query
// vector is supplied.
//
// ponytail: the ledger is a JSON file, not a chain. The money RULES are the real
// ones — `splitPayment` from publish/terms.js, the same function the relay
// settles with. What is simulated is the settlement, which sond3r has already
// demonstrated against real USDC. Simulating it again here would test Arbitrum.

import { createServer } from "node:http";
import { createReadStream, existsSync, statSync, writeFileSync, rmSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PORT = 5199;
process.env.MARKET_BASE = `http://127.0.0.1:${PORT}`;
process.env.MARKET_LEDGER = join(HERE, ".market-sim.json");
rmSync(process.env.MARKET_LEDGER, { force: true });

// ── the fixtures, served to ourselves ───────────────────────────────────────
// The publisher's static site, in twenty lines. That is genuinely all a
// Semantic CDN view is on the wire: files under a path, gzip already applied at
// bake time, and CORS so a reader on another origin can pull them.
const MIME = { ".json": "application/json", ".gz": "application/gzip", ".ndjson": "application/x-ndjson" };
const server = createServer((req, res) => {
    const p = join(HERE, "public", normalize(decodeURIComponent(req.url.split("?")[0])).replace(/^(\.\.[/\\])+/, ""));
    if (!existsSync(p) || !statSync(p).isFile()) { res.writeHead(404).end("no"); return; }
    res.writeHead(200, {
        "access-control-allow-origin": "*",
        "content-type": MIME[extname(p)] ?? "application/octet-stream",
    });
    createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

const M = await import("./market.mjs");
const { search } = await import("./tools.js");
const { label } = await import("@fangorn/westmarch/terms");
const { taste, recommend, exportTaste } = await import("@fangorn/westmarch/taste");
const { demandReport, brief } = await import("@fangorn/westmarch/demand");
const { findCorpora } = await import("@fangorn/westmarch/directory");

const usd = (b) => label(b);
const h1 = (s) => console.log(`\n\n\x1b[1m━━ ${s} ${"━".repeat(Math.max(0, 72 - s.length))}\x1b[0m`);
const say = (...a) => console.log(...a);
const report = { acts: [], ledger: null, brief: null };

// ── the cast ────────────────────────────────────────────────────────────────
// Six readers, because five is the cohort floor and a market that only works at
// exactly the floor is a market with one customer. Each has a brief in their own
// words — the thing they would type — and a budget.
const READERS = [
    { name: "mara",  brief: "submarine war at sea",        budget: 3_000_000n },
    { name: "iven",  brief: "cold war nuclear propaganda", budget: 3_000_000n },
    { name: "juno",  brief: "vampire horror night",        budget: 3_000_000n },
    { name: "peter", brief: "cartoon animation comedy",    budget: 3_000_000n },
    { name: "sable", brief: "detective crime murder",      budget: 3_000_000n },
    { name: "otto",  brief: "space rocket science",        budget: 3_000_000n },
];
const SHELF = "archive-films";

try {
    // ═══ ACT 1 ═══════════════════════════════════════════════════════════════
    h1("ACT 1 — four publishers, published once, never touched again");
    const cat = await M.catalog(M.load());
    for (const c of cat) say(`  ${c.sku.padEnd(22)} ${String(c.price).padStart(10)}   ${c.what}`);
    say(`\n  Nothing below this line asks a publisher to do anything. They are done.`);
    report.acts.push({ act: 1, title: "published once", catalog: cat });

    // ═══ ACT 2 ═══════════════════════════════════════════════════════════════
    h1("ACT 2 — readers choose a corpus WITHOUT downloading one");
    // findCorpora ranks catalog coverage centroids: ~4 KB per publisher, and the
    // question is embedded on the reader's side, so the index learns neither the
    // query nor that it was asked. Here there is no embedder, so the ranking is
    // over what the catalogue declares — which is the honest degradation, and it
    // is reported as such rather than dressed up as semantic.
    const sources = M.skus(M.load()).filter((x) => x.view).map((x) => process.env.MARKET_BASE + x.view);
    const dir = await findCorpora("films about war and horror", { sources });
    for (const d of dir.corpora ?? []) {
        say(`  ${String(d.name ?? d.domain).padEnd(24)} ${d.count ?? "?"} rows`
            + `  ${d.affinity == null ? "unranked — no embedder in this process" : `affinity ${d.affinity.toFixed(3)}`}`
            + `  ${d.price ? `costs ${d.price}` : "free"}`);
    }
    if (!dir.ranked) say(`  (unranked: ${dir.why ?? "no embedder was supplied"} — the directory says so rather than inventing an order)`);
    if (dir.unreachable?.length) say(`  unreachable: ${dir.unreachable.map((u) => u.view ?? u).join(", ")}`);
    if (dir.mismatched?.length) say(`  excluded, different embedding model: ${dir.mismatched.map((u) => u.name ?? u).join(", ")}`);
    say(`\n  ${sources.length} corpora ranked. Bytes downloaded from any shard: 0.`);
    report.acts.push({ act: 2, title: "discovery without disclosure", searched: dir.searched ?? sources.length, ranked: dir.ranked, downloaded: 0, corpora: (dir.corpora ?? []).map((d) => ({ name: d.name, count: d.count, price: d.price ?? null })) });

    // ═══ ACT 3 ═══════════════════════════════════════════════════════════════
    h1("ACT 3 — six readers buy the shelf, and react to what they came for");
    const shelf = await M.rowsOf(SHELF);
    say(`  ${SHELF}: ${shelf.rows.length} rows, title role = ${shelf.roles.title}, tags = ${(shelf.roles.tags ?? []).join(", ") || "(none declared)"}`);

    const logs = {};
    M.txn((s) => {
        for (const r of READERS) {
            const w = M.wallet(s, r.name);
            w.budget = r.budget;
            M.buy(s, r.name, SHELF);
            // The reader's agent finds what the brief asked for, in the corpus
            // the reader now owns, and reacts. Likes are the top of the list,
            // skips are the tail: a real session's shape, and the tail is what
            // makes `no` mean anything.
            const hits = search(shelf.rows, r.brief, shelf.roles, { limit: 14 });
            const by = new Map(shelf.rows.map((x) => [x.id, x]));
            const evs = hits.map((h, i) => ({
                id: h.id, corpus: SHELF, title: h.title ?? "", reaction: i < 9 ? "like" : "skip",
                at: new Date().toISOString(), v: [...(by.get(h.id)?.vector ?? [])],
            })).filter((e) => e.v.length);
            s.reactions[r.name] = evs;
            logs[r.name] = evs;
            say(`  ${r.name.padEnd(6)} "${r.brief}" → ${evs.length} reactions, top: ${evs[0]?.title?.slice(0, 46) ?? "(nothing matched)"}`);
        }
    });

    // ═══ ACT 4 ═══════════════════════════════════════════════════════════════
    h1("ACT 4 — a taste built in one publisher's corpus ranks another's");
    const mara = logs.mara;
    const t = taste(
        mara.filter((e) => e.reaction === "like").map((e) => ({ id: e.id, vector: Float32Array.from(e.v), title: e.title })),
        mara.filter((e) => e.reaction === "skip").map((e) => ({ id: e.id, vector: Float32Array.from(e.v), title: e.title })),
    );
    const games = await M.rowsOf("games");
    const picks = recommend(games.rows, t, { limit: 5 });
    say(`  mara's taste: ${exportTaste(t).mu.length} base64 chars of int8, built from ${mara.length} reactions in ${SHELF}`);
    say(`  pointed at ${games.rows.length} rows from an unrelated publisher, no shared field, no shared id:`);
    const titleOf = (r, roles) => String(r[roles.title] ?? r.title ?? r.name ?? r.id);
    for (const p of picks) say(`    ${titleOf(p, games.roles).slice(0, 60)}`);
    report.acts.push({ act: 4, title: "portable taste", from: SHELF, to: "games", picks: picks.map((p) => titleOf(p, games.roles)) });

    // ═══ ACT 5 ═══════════════════════════════════════════════════════════════
    h1("ACT 5 — a curator resells, and the publisher is paid for work it did not do");
    M.txn((s) => {
        const w = M.wallet(s, "curator"); w.budget = 5_000_000n;
        M.buy(s, "curator", SHELF);
        M.buy(s, "curator", "archive-transcripts");
        const out = M.publish(s, "curator", "cold-war-cut", 600_000n,
            [SHELF, "archive-transcripts"], logs.iven.slice(0, 6).map((e) => e.title), 3000);
        say(`  curator publishes "cold-war-cut" at ${usd(out.price)} — ${out.owes}`);
        for (const r of ["mara", "juno", "sable"]) M.buy(s, r, "cold-war-cut");
        const q = M.quote(s, "cold-war-cut");
        say(`  three sales. Each one pays:`);
        for (const p of q.payouts) say(`    ${usd(p.amount).padStart(11)}  ${p.why}`);
    });

    // ═══ ACT 6 ═══════════════════════════════════════════════════════════════
    h1("ACT 6 — six readers sell their own reactions; the shelf is cited and paid again");
    M.txn((s) => {
        for (const r of READERS.slice(0, 3)) {
            const out = M.sellTaste(s, r.name, 120_000n);
            say(`  ${r.name}-taste — ${out.reactions} reactions, free index says ${out.discloses.join("/")}, paid payload is ${out.sells.join("/")}`);
            say(`     owes upstream: ${out.owes.join(", ")}`);
        }
        M.wallet(s, "adhouse").budget = 4_000_000n;
        for (const r of READERS.slice(0, 3)) M.buy(s, "adhouse", `${r.name}-taste`);
        say(`  a buyer takes all three. The corpora those reactions were spent in are paid, which is`);
        say(`  the exact transaction an advertising network performs for nothing.`);
    });

    // ═══ ACT 7 ═══════════════════════════════════════════════════════════════
    h1("ACT 7 — the publisher asks the same question six times, and buys an ANSWER");
    // ONE question, asked repeatedly. Six different questions would produce six
    // centroids whose differences measure the publisher's choice of anchor and
    // nothing about demand — demand.js refuses that series by name.
    M.txn((s) => { M.wallet(s, "archivehouse").addr = s.publishers[SHELF].addr; M.wallet(s, "archivehouse").budget = 6_000_000n; });
    const QUESTION = "how are readers reacting around our submarine reel?";
    const probes = [];
    for (let week = 1; week <= 6; week++) {
        // Readers keep reading between rounds: two of them drift toward horror,
        // which is the movement a heading is supposed to detect.
        if (week === 3 || week === 5) {
            M.txn((s) => {
                for (const n of ["otto", "peter"]) {
                    const hits = search(shelf.rows, "vampire horror ghost", shelf.roles, { limit: 6 });
                    const by = new Map(shelf.rows.map((x) => [x.id, x]));
                    s.reactions[n].push(...hits.map((h) => ({
                        id: h.id, corpus: SHELF, title: h.title ?? "", reaction: "like",
                        at: new Date().toISOString(), v: [...(by.get(h.id)?.vector ?? [])],
                    })).filter((e) => e.v.length));
                }
            });
        }
        // cohort is async, txn is not — so load, mutate, save. Without the save
        // the rounds ran and the money never moved, and the books still balanced,
        // because nothing had been written to be out of balance with.
        const st = M.load();
        const round = await M.cohort(st, "archivehouse", 60_000n, SHELF, "submarine", 0.05);
        M.save(st);
        probes.push({ question: QUESTION, readout: round.answer });
        say(`  week ${week}: ${round.answer.readers} readers · ${round.answer.matched} matched · sentiment ${round.answer.sentiment}`
            + ` · direction ${round.answer.centroid ? "reported" : "WITHHELD"} · paid ${round.eachReaderGot} each`);
    }
    // Two one-off questions about OTHER regions, asked once each. They cannot
    // contribute to a heading and demand.js will not let them try.
    for (const [anchor, pct] of [["ballet dance opera", 0.05], ["dracula vampire", 0.05]]) {
        const st1 = M.load();
        const r = await M.cohort(st1, "archivehouse", 60_000n, SHELF, anchor, pct);
        M.save(st1);
        probes.push({ question: `and around "${anchor}"?`, readout: r.answer });
        say(`  one-off "${anchor}": ${r.answer.matched} matched, direction ${r.answer.centroid ? "reported" : "WITHHELD"}`);
    }
    const last = await M.cohort(M.load(), "archivehouse", 60_000n, SHELF, "submarine", 0.05); // not saved: printed for its guarantees, not its money
    say(`\n  what the publisher CANNOT learn, by construction:`);
    for (const l of last.publisherDoesNotLearn) say(`    · ${l}`);

    // ═══ ACT 8 ═══════════════════════════════════════════════════════════════
    h1("ACT 8 — what the answer MEANS, on the publisher's own shelf");
    const st = M.load();
    const earnedBy = new Map();
    for (const p of st.payments) if (p.sku === SHELF) for (const x of p.payouts) earnedBy.set(x.to, (earnedBy.get(x.to) ?? 0n) + x.amount);
    const shelfEarned = [...st.payments].reduce((a, p) =>
        a + p.payouts.filter((x) => x.to === st.publishers[SHELF].addr).reduce((b, x) => b + x.amount, 0n), 0n);
    const rep = demandReport({ shelf: shelf.rows, roles: shelf.roles, probes, paidPerReader: 9_000n, earned: shelfEarned });
    const text = brief(rep, { title: `demand — ${SHELF}` });
    say(text.split("\n").map((l) => "  " + l).join("\n"));
    report.brief = text;
    report.demand = JSON.parse(JSON.stringify(rep, (k, v) => (typeof v === "bigint" ? String(v) : v)));

    // ═══ ACT 9 ═══════════════════════════════════════════════════════════════
    h1("ACT 9 — the books");
    const b = M.books(M.load());
    say(`  ${b.sales} settlements, ${usd(b.paid)} moved.\n`);
    for (const r of b.rows) say(`    ${usd(r.amount).padStart(11)}   ${r.who}`);
    const pubAddr = st.publishers[SHELF].addr;
    const streams = new Map();
    for (const p of st.payments) for (const x of p.payouts) {
        if (x.to !== pubAddr) continue;
        const why = p.sku.startsWith("cohort:") ? "cohort rounds (paid OUT)" : p.sku === SHELF ? "direct sales" : `cited by ${p.sku}`;
        streams.set(why, (streams.get(why) ?? 0n) + x.amount);
    }
    say(`\n  ${SHELF} published once, in act 1. Since then it has been paid by:`);
    for (const [why, amt] of streams) say(`    ${usd(amt).padStart(11)}   ${why}`);
    const spent = st.agents.archivehouse?.spent ?? 0n;
    say(`\n  …and it SPENT ${usd(spent)} buying answers about itself. Net: ${usd([...streams.values()].reduce((a, x) => a + x, 0n) - spent)}`);
    report.ledger = JSON.parse(JSON.stringify({ ...b, streams: Object.fromEntries(streams), spent }, (k, v) => (typeof v === "bigint" ? String(v) : v)));

    writeFileSync(join(HERE, "market-report.json"), JSON.stringify(report, null, 1));
    say(`\n  written: example/market-report.json\n`);
} finally {
    server.close();
}
