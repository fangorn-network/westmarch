// A market, with fake money and real corpora.
//
// Agents hold budgets and buy from publishers who registered under an app. Every
// payment goes through `publish/terms.js`, so the split an app owner set is the
// split that happens, and the ledger is checked against the payments at the end:
// if those two numbers ever disagree, the revenue model is wrong.
//
// The loop worth watching is the second half. An agent that has bought a few
// corpora can publish a DERIVATIVE — a set it assembled, priced, with lineage
// naming what it was built from. Later buyers of that derivative pay the app,
// the agent, and the agent's own sources, in one payment. Catalog of knowledge →
// a concept somebody assembled → knowledge the next agent builds on, with the
// money following the citations.
//
// Run:  node market.mjs                    (the scripted market)
//       node market.mjs catalog            (what an agent buyer can see)
//       node market.mjs quote <sku>
//       node market.mjs buy <agent> <sku>
//       node market.mjs publish <agent> <name> <price> <sku,sku> <title|title> [upstreamBps]
//       node market.mjs react <agent> <sku> <like|skip|share> <query>
//       node market.mjs sell-taste <agent> <price>
//       node market.mjs cohort <asker> <budget> <corpus> [query]
//       node market.mjs books
//
// ponytail: the ledger is a JSON file, not a chain. This is measuring whether
// the split arithmetic and the incentives hold up, not whether Arbitrum works —
// that half is already demonstrated in sond3r/src/pay/buy.js with real USDC.
import { readFileSync, writeFileSync, existsSync, renameSync, unlinkSync } from "node:fs";
import { splitPayment, label, termsHash } from "@fangorn/westmarch/terms";
import { configure, domainManifests, loadShard, resetShard, trimView } from "@fangorn/westmarch/shard";
import { rolesFrom, textOf } from "@fangorn/westmarch/roles";
import { reactionCorpus } from "@fangorn/westmarch/reactions";
import { MIN_COHORT, aggregate, contribute, keypair, readout, statistics } from "@fangorn/westmarch/cohort";
import { search, browse } from "@fangorn/westmarch/tools";

const BASE = process.env.MARKET_BASE ?? "http://localhost:5180";
const LEDGER = process.env.MARKET_LEDGER ?? new URL("./.market.json", import.meta.url).pathname;

// ── the world ───────────────────────────────────────────────────────────────
const APP = { appId: "fangorn.tv", owner: "0x" + "a".repeat(40), appBps: 1000, currency: "USDC" };
const ADDR = (n) => "0x" + String(n).padStart(40, "0");

const SEED = {
    terms: APP,
    // Publishers who joined the app. Each sells access to one corpus, priced per
    // buyer, which is the only thing the free index withholds.
    publishers: {
        "archive-films": { addr: ADDR(11), view: "/archive-films", price: 250_000n, blurb: "20,986 public-domain films" },
        "archive-transcripts": { addr: ADDR(12), view: "/archive-transcripts", price: 400_000n, blurb: "21,131 timed dialogue rows from those films" },
        games: { addr: ADDR(13), view: "/games", price: 150_000n, blurb: "5,847 games 1995-2024" },
        places: { addr: ADDR(14), view: "/places", price: 100_000n, blurb: "917 local places, events and trails" },
    },
    agents: {},
    derivatives: {},
    // What each agent reacted to while consuming. This is the raw material a
    // consumer turns into a corpus of their own — the thing a surveillance
    // platform would keep for free.
    reactions: {},
    rounds: [],
    payments: [],
};

const load = () => (existsSync(LEDGER) ? JSON.parse(readFileSync(LEDGER, "utf8"), revive) : structuredClone(SEED));
// Atomic, because several agents buy at once and each `buy` is its own process:
// read-modify-write without a lock loses a sale, and a market that occasionally
// forgets a payment is not a market. `wx` is the exclusive-create primitive every
// filesystem has; the rename is the atomic part.
//
// ponytail: a lockfile and a spin. A real settlement is a chain transaction and
// gets this for free — this exists because the simulation does not.
function save(s) {
    const lock = `${LEDGER}.lock`;
    for (let i = 0; i < 200; i++) {
        try { writeFileSync(lock, String(process.pid), { flag: "wx" }); break; }
        catch { if (i === 199) throw new Error("ledger locked"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25); }
    }
    try {
        writeFileSync(`${LEDGER}.tmp`, JSON.stringify(s, replace, 1));
        renameSync(`${LEDGER}.tmp`, LEDGER);
    } finally { try { unlinkSync(lock); } catch { /* already gone */ } }
}

/** Load, mutate, save — all inside one lock, so two agents buying the same
 *  millisecond both land. Every mutating verb goes through this. */
function txn(fn) {
    const lock = `${LEDGER}.lock`;
    for (let i = 0; i < 200; i++) {
        try { writeFileSync(lock, String(process.pid), { flag: "wx" }); break; }
        catch { if (i === 199) throw new Error("ledger locked"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25); }
    }
    try {
        const st = load();
        const out = fn(st);
        writeFileSync(`${LEDGER}.tmp`, JSON.stringify(st, replace, 1));
        renameSync(`${LEDGER}.tmp`, LEDGER);
        return out;
    } finally { try { unlinkSync(lock); } catch { /* already gone */ } }
}
// BigInt does not survive JSON, and money that silently becomes a float is the
// bug this whole file exists to not have.
const replace = (k, v) => (typeof v === "bigint" ? `${v}n` : v);
const revive = (k, v) => (typeof v === "string" && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v);

const skus = (s) => [
    ...Object.entries(s.publishers).map(([sku, p]) => ({ sku, kind: "corpus", ...p })),
    ...Object.entries(s.derivatives).map(([sku, d]) => ({ sku, kind: "derivative", ...d })),
];
const find = (s, sku) => skus(s).find((x) => x.sku === sku);
const wallet = (s, name) => (s.agents[name] ??= { addr: ADDR(100 + Object.keys(s.agents).length), budget: 0n, spent: 0n, earned: 0n, owns: [] });

// ── the verbs ───────────────────────────────────────────────────────────────
function quote(s, sku) {
    const item = find(s, sku);
    if (!item) throw new Error(`no such sku: ${sku}`);
    const payouts = splitPayment(item.price, { terms: s.terms, publisher: item.addr, lineage: item.lineage ?? [] });
    return { sku, kind: item.kind, price: item.price, blurb: item.blurb, payouts };
}

function buy(s, agentName, sku) {
    const a = wallet(s, agentName);
    const q = quote(s, sku);
    if (a.owns.includes(sku)) return { ...q, note: "already owned — pay once, own forever" };
    if (a.budget - a.spent < q.price) throw new Error(`${agentName} has ${label(a.budget - a.spent)} left, ${sku} costs ${label(q.price)}`);
    a.spent += q.price;
    a.owns.push(sku);
    for (const p of q.payouts) {
        const seller = Object.values(s.agents).find((x) => x.addr === p.to);
        if (seller) seller.earned += p.amount;
    }
    s.payments.push({ at: s.payments.length, buyer: agentName, sku, amount: q.price, payouts: q.payouts });
    return q;
}

/** An agent publishes what it made. `sources` are skus it OWNS — you cannot
 *  cite what you did not buy, which is the only enforcement that matters here:
 *  lineage is a debt the publisher takes on voluntarily, so the incentive not to
 *  declare it has to be beaten by something. Here it is beaten by the buyer
 *  seeing the provenance in the quote. */
function publish(s, agentName, name, price, sources, titles, upstreamBps = 2500) {
    const a = wallet(s, agentName);
    const missing = sources.filter((sku) => !a.owns.includes(sku));
    if (missing.length) throw new Error(`${agentName} does not own ${missing.join(", ")} — cite what you bought`);
    // The publisher SETS this. It was hardcoded at a quarter of the publisher's
    // share, and the curator agent that first used this market found the hole in
    // one sitting: a derivative that dumps three skus in raw and one that filtered
    // 21,131 rows down to nine usable ones owed exactly the same, so the split
    // priced the inputs and never the selection — which in a market whose whole
    // premise is that assembling a concept from a catalogue creates value is the
    // one thing it must be able to price.
    //
    // It stays a voluntary debt, disciplined by `quote` showing every buyer what
    // provenance a seller declared. A curator who owes upstream little is telling
    // buyers the value is their judgement; one who owes a lot is telling them the
    // value is the sources. Both are honest claims, and the buyer can see which
    // is being made before they spend.
    const up = Math.max(0, Math.min(10000, Number(upstreamBps)));
    const share = Math.floor(up / Math.max(1, sources.length));
    // A zero share is not a citation — it would show up in every quote as a payee
    // owed nothing, which reads as provenance while paying none.
    const lineage = share > 0 ? sources.map((sku) => ({ to: find(s, sku).addr, bps: share, note: sku })) : [];
    s.derivatives[name] = {
        addr: a.addr, price: BigInt(price), lineage, sources, titles,
        blurb: `${titles.length} things, assembled by ${agentName} from ${sources.join(" + ")}`,
    };
    return { published: name, price: BigInt(price), lineage,
             owes: `${share / 100}% of the publisher's share to each of ${sources.length} source(s) — ${up / 100}% in total, set by ${agentName}` };
}

/**
 * A reaction, recorded with the vector of the thing reacted to.
 *
 * The vector is the point: it comes off a shard the agent already downloaded, so
 * the reaction is publishable signal the moment it happens, with no model and no
 * bake. Reacting requires OWNING the corpus — a reaction to something you only
 * saw the free index of is a reaction to a title, and nobody should be able to
 * sell that as attention.
 */
async function react(s, agentName, sku, kind, query) {
    const a = wallet(s, agentName);
    if (!a.owns.includes(sku)) throw new Error(`${agentName} does not own ${sku} — you cannot sell a reaction to something you never read`);
    const { hits } = await sample(sku, query, 1);
    const hit = hits[0];
    if (!hit) throw new Error(`nothing in ${sku} matched ${JSON.stringify(query)} to react to`);
    const row = (await rowsOf(sku))?.rows.find((r) => r.id === hit.id);
    (s.reactions[agentName] ??= []).push({
        id: hit.id, corpus: sku, title: hit.title ?? "", reaction: kind,
        at: new Date().toISOString(), v: [...(row?.vector ?? [])],
    });
    return { agent: agentName, corpus: sku, reaction: kind, to: hit.title, reactions: s.reactions[agentName].length };
}

/**
 * A consumer becomes a publisher.
 *
 * Their reactions become a corpus with the same shape as anyone else's: a free
 * index a buyer can rank, a paid payload, and lineage naming the corpora the
 * attention was spent on. That last part is the argument — a surveillance
 * platform pays those corpora nothing for the same data.
 */
function sellTaste(s, agentName, price) {
    const a = wallet(s, agentName);
    const events = (s.reactions[agentName] ?? []).map((e) => ({ ...e, vector: Float32Array.from(e.v) }));
    if (!events.length) throw new Error(`${agentName} has reacted to nothing — consume something first`);
    const sources = Object.fromEntries(skus(s).map((x) => [x.sku, x.addr]));
    const { manifest, rows: free, lineage, byCorpus } = reactionCorpus(events, {
        publisher: a.addr, name: `${agentName}-taste`, sources, price: String(price),
    });
    s.derivatives[`${agentName}-taste`] = {
        addr: a.addr, price: BigInt(price), lineage,
        sources: Object.keys(byCorpus), titles: [],
        blurb: `${manifest.count} reactions by ${agentName} across ${Object.keys(byCorpus).length} corpora — ranked free, read on purchase`,
    };
    return {
        published: `${agentName}-taste`, price: BigInt(price), reactions: manifest.count,
        from: byCorpus, discloses: manifest.paywall.free, sells: manifest.paywall.locked,
        owes: lineage.map((l) => `${l.note} ${Number(l.bps) / 100}%`),
        coverage: `${manifest.coverage.vectors.length} centroid(s) at ${manifest.coverage.dim}d over ${manifest.count} reactions — a buyer ranks this taste without downloading it or learning one title`,
        freeRowLooksLike: free[0].fields,
    };
}

/**
 * A publisher buys an ANSWER about its own catalogue, and never a reader's rows.
 *
 * Every reader with a log answers the question on their own machine, masks the
 * answer so it is uniform on its own, and the masks cancel in the sum. The
 * publisher gets counts and a direction; nobody gets a person.
 *
 * Keys are generated here, per round, and thrown away. That is not a shortcut
 * around persisting them — it is the design. A reader who reuses a key across
 * rounds can be linked across rounds, and a sequence of linked answers is the
 * profile this whole mechanism exists to not build.
 */
async function cohort(s, asker, budget, corpus, anchor, pct = 0.02) {
    const a = wallet(s, asker);
    const total = BigInt(budget);
    if (a.budget - a.spent < total) throw new Error(`${asker} has ${label(a.budget - a.spent)} left`);

    // EVERY reader with a log is invited, including those who will match nothing.
    // Inviting only readers likely to match is itself a disclosure: the invitation
    // list would encode what the publisher already believes about each of them.
    const readers = Object.keys(s.reactions).filter((n) => (s.reactions[n] ?? []).length);
    if (readers.length < MIN_COHORT) {
        throw new Error(`${readers.length} readers have logs — ${MIN_COHORT} is the floor. Below it an "aggregate" is a dossier.`);
    }

    // A publisher OWNS the catalogue it is asking about, so it does not need an
    // embedding model to ask a pointed question — it names one of its own rows and
    // the question becomes "how did readers react around here?". Without an anchor
    // the answer averages the whole shelf, which for a diverse cohort points at
    // nothing in particular and is the least useful thing this can return.
    let q = { corpus };
    let about = "the whole catalogue";
    if (anchor) {
        const got = await rowsOf(corpus);
        if (!got) throw new Error(`${corpus} has no shard to anchor against`);
        const [hit] = search(got.rows, anchor, got.roles, { limit: 1 });
        if (!hit) throw new Error(`nothing in ${corpus} matches ${JSON.stringify(anchor)} to anchor the question`);
        const row = got.rows.find((r) => r.id === hit.id);
        // The threshold is a PERCENTILE OF THE PUBLISHER'S OWN SHELF, not a raw
        // cosine. Raw cosine is offset per query in this space — it is why
        // `rank.js` uses a z-floor rather than an absolute number — so a fixed
        // 0.55 admitted every reaction in the corpus and all three questions came
        // back with byte-identical answers. Ranking the anchor against the rows
        // the publisher already holds turns "near" into something that means the
        // same thing on every reader's machine: as close as my own top 2%.
        const a = row.vector, an = row.norm || 1;
        const sims = got.rows.map((r) => {
            let d = 0; for (let i = 0; i < a.length; i++) d += a[i] * r.vector[i];
            return d / (an * (r.norm || 1));
        }).sort((x, y) => y - x);
        const minScore = sims[Math.min(sims.length - 1, Math.floor(sims.length * pct))];
        q = { corpus, near: a, minScore };
        about = `the region around "${hit.title ?? anchor}" (top ${(pct * 100).toFixed(0)}% of the shelf)`;
    }
    const keys = [];
    for (const _ of readers) keys.push(await keypair());
    const pubs = keys.map((k) => k.pub);

    const shares = [];
    for (let i = 0; i < readers.length; i++) {
        const log = (s.reactions[readers[i]] ?? []).map((e) => ({ ...e, vector: Float32Array.from(e.v ?? []) }));
        shares.push(await contribute(statistics(log, q), keys[i], pubs));
    }
    const answer = readout(aggregate(shares), readers.length);
    if (!answer.ok) throw new Error(answer.why);

    // EVERY READER IS PAID EXACTLY THE SAME. Paying by contribution would put the
    // one number the mechanism hides — how much each reader had to say — straight
    // back on the ledger, where anyone can read it. The remainder goes to the app
    // rather than to an arbitrary reader, so the amounts stay identical to the
    // base unit and a payment discloses nothing but participation.
    const appCut = (total * BigInt(s.terms.appBps)) / 10000n;
    const pool = total - appCut;
    const each = pool / BigInt(readers.length);
    const dust = pool - each * BigInt(readers.length);

    const payouts = [{ to: s.terms.owner, amount: appCut + dust, why: `app ${s.terms.appId} (${s.terms.appBps} bps + dust)` }];
    for (const r of readers) payouts.push({ to: wallet(s, r).addr, amount: each, why: `cohort answer (1 of ${readers.length}, paid identically)` });
    const merged = [...payouts.reduce((m, p) => m.set(p.to, m.has(p.to) ? { ...m.get(p.to), amount: m.get(p.to).amount + p.amount } : p), new Map()).values()];
    if (merged.reduce((t, p) => t + p.amount, 0n) !== total) throw new Error("a cohort payment must conserve money like any other");

    a.spent += total;
    for (const p of merged) {
        const seller = Object.values(s.agents).find((x) => x.addr === p.to);
        if (seller) seller.earned += p.amount;
    }
    s.payments.push({ at: s.payments.length, buyer: asker, sku: `cohort:${corpus}`, amount: total, payouts: merged });
    s.rounds.push({ asker, corpus, about, readers: readers.length, budget: total, answer });

    return {
        asked: `how did ${readers.length} readers react to ${about} in ${corpus}?`,
        paid: label(total), eachReaderGot: label(each),
        answer,
        publisherLearns: ["how many readers answered", "how many reactions matched", "the like/skip/share split",
                          "the direction attention pointed, as a unit vector it can rank its own catalogue against"],
        publisherDoesNotLearn: ["which reader answered what", "any individual's count", "any title anyone reacted to",
                                "whether a given reader matched at all — non-matchers are paid identically",
                                "any direction at all when too few reactions stand behind it — the question has to be widened"],
    };
}

/** Every number checked twice: what agents think they spent and earned, against
 *  what the payments actually moved. */
function books(s) {
    const paid = s.payments.reduce((t, p) => t + p.amount, 0n);
    const out = new Map();
    for (const p of s.payments) for (const x of p.payouts) out.set(x.to, (out.get(x.to) ?? 0n) + x.amount);
    const moved = [...out.values()].reduce((t, v) => t + v, 0n);
    if (moved !== paid) throw new Error(`buyers paid ${paid}, payouts moved ${moved}`);
    const spent = Object.values(s.agents).reduce((t, a) => t + a.spent, 0n);
    if (spent !== paid) throw new Error(`agents think they spent ${spent}, payments say ${paid}`);
    const rows = [...out].map(([to, amount]) => {
        const who = to === s.terms.owner ? `app ${s.terms.appId}`
            : Object.entries(s.publishers).find(([, p]) => p.addr === to)?.[0]
            ?? Object.entries(s.agents).find(([, a]) => a.addr === to)?.[0] ?? to;
        return { who, amount };
    }).sort((x, y) => Number(y.amount - x.amount));
    return { sales: s.payments.length, paid, rows, appTake: out.get(s.terms.owner) ?? 0n };
}

// ── what an agent buyer can actually read before it spends ──────────────────
async function catalog(s) {
    const out = [];
    for (const item of skus(s)) {
        const q = quote(s, item.sku);
        out.push({
            sku: item.sku, kind: item.kind, price: label(item.price), what: item.blurb,
            ...(item.sources ? { builtFrom: item.sources, alsoPays: item.lineage.map((l) => `${l.note} ${Number(l.bps) / 100}%`) } : {}),
            appTake: `${Number(s.terms.appBps) / 100}%`,
        });
    }
    return out;
}

/** Free index, paid payload: an agent reads the shard to decide, and pays for
 *  what the shard withholds. This is the whole reason a market can exist without
 *  a trusted middleman — the buyer can rank before they spend. */
async function rowsOf(sku) {
    const item = find(load(), sku);
    if (!item?.view) return null;
    resetShard();
    const view = trimView(BASE + item.view);
    // The searchable prose is whatever THIS publisher declared, and it is built
    // per row AT PARSE TIME — so the hook has to be wired before the shard
    // loads, not after. Without this every corpus is parsed with the default
    // sniff (`name + path + desc`), which for a corpus of dialogue means the
    // searchable text of all 21,131 rows is the filename, and for one of places
    // means there is no text at all. Two buyers hit that in this market: one
    // nearly walked away from the only corpus that served their brief, the other
    // stopped trusting the sampler and read the shard by hand.
    const held = new Map();
    configure({
        onManifests: (ms, v) => held.set(v, rolesFrom(ms)),
        rowText: (f, v) => textOf(f, held.get(v) ?? { text: [] }),
    });
    const rows = await loadShard(view);
    // From the MANIFESTS, not a sniff. Sniffing found `name` and searched titles,
    // so a corpus of dialogue answered every question about what was said with
    // zero hits — a buyer read that as "worthless" when it meant "wrong index",
    // and nearly walked away from the one asset that served their brief.
    // This is the failure `consume/lint.js` calls "no role_map", arriving from
    // the other direction: the declaration existed, the reader didn't load it.
    const roles = rolesFrom(domainManifests(view), rows);
    return { rows, roles };
}

async function sample(sku, query, n = 6) {
    const got = await rowsOf(sku);
    if (!got) return { sku, note: "a derivative — its titles are listed in the catalog" };
    const { rows, roles } = got;
    const hits = query ? search(rows, query, roles, { limit: n }) : browse(rows, roles, { limit: n }).rows;
    // The matched line, not just the title. A buyer inspecting a corpus of
    // dialogue needs to see dialogue: titles alone told them nothing about
    // whether the transcription was any good, which is the one thing that
    // decides whether 0.40 is a fair price.
    const by = new Map(rows.map((r) => [r.id, r]));
    const terms = String(query ?? "").toLowerCase().split(/\s+/).filter((w) => w.length > 3);
    for (const h of hits) {
        const t = by.get(h.id)?.text ?? "";
        if (!t) continue;
        const at = terms.map((w) => t.toLowerCase().indexOf(w)).filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? 0;
        h.excerpt = `${at > 40 ? "…" : ""}${t.slice(Math.max(0, at - 40), Math.max(0, at - 40) + 200).trim()}…`;
    }
    return { sku, rows: rows.length, hits };
}

// The verbs, for a simulation that wants the same money rules the CLI uses rather
// than a second implementation of them that can drift.
export { load, save, txn, wallet, quote, buy, publish, sellTaste, react, books, cohort, skus, find, sample, rowsOf, catalog, SEED, APP, ADDR };

// ── cli ─────────────────────────────────────────────────────────────────────
const j = (v) => JSON.stringify(v, replace, 1);
const CLI = import.meta.url === `file://${process.argv[1]}`;
const [cmd, ...rest] = CLI ? process.argv.slice(2) : ["__lib__"];
const s = CLI ? load() : null;

if (cmd === "catalog") console.log(j(await catalog(s)));
else if (cmd === "quote") console.log(j(quote(s, rest[0])));
else if (cmd === "sample") console.log(j(await sample(rest[0], rest.slice(1).join(" "))));
else if (cmd === "fund") console.log(j(txn((st) => { wallet(st, rest[0]).budget += BigInt(rest[1]); return st.agents[rest[0]]; })));
else if (cmd === "buy") console.log(j(txn((st) => buy(st, rest[0], rest[1]))));
else if (cmd === "publish") console.log(j(txn((st) => publish(st, rest[0], rest[1], rest[2], rest[3].split(","), rest[4].split("|"), rest[5] ?? 2500))));
else if (cmd === "react") console.log(j(await (async () => { const r = await react(s, rest[0], rest[1], rest[2], rest.slice(3).join(" ")); txn((st) => { st.reactions = s.reactions; return st; }); return r; })()));
else if (cmd === "sell-taste") console.log(j(txn((st) => { st.reactions = s.reactions; return sellTaste(st, rest[0], rest[1]); })));
else if (cmd === "cohort") { const out = await cohort(s, rest[0], rest[1], rest[2], rest.slice(3).join(" ")); save(s); console.log(j(out)); }
else if (cmd === "books") console.log(j(books(s)));
else if (cmd === "reset") { save(structuredClone(SEED)); console.log("market reset"); }
else if (cmd === "hash") console.log(await termsHash(s.terms));
else if (cmd === "__lib__") { /* imported as a library — run nothing */ }
else {
    // ── the scripted market, and the self-check ─────────────────────────────
    const m = structuredClone(SEED);
    wallet(m, "curator").budget = 2_000_000n;
    wallet(m, "reader").budget = 800_000n;

    buy(m, "curator", "archive-films");
    buy(m, "curator", "games");
    if (m.agents.curator.spent !== 400_000n) throw new Error("spend must accumulate");
    if (books(m).appTake !== 40_000n) throw new Error(`app takes 10% of everything: ${books(m).appTake}`);

    // The C→K step: the curator sells a thing that did not exist before it bought
    // its inputs, and its sources are paid every time it sells.
    publish(m, "curator", "frozen-nights", 500_000n, ["archive-films", "games"], ["Frostpunk", "JackFrost.mp4"]);
    buy(m, "reader", "frozen-nights");

    const last = m.payments.at(-1);
    const got = (to) => last.payouts.find((p) => p.to === to)?.amount ?? 0n;
    if (got(m.terms.owner) !== 50_000n) throw new Error("the app's cut does not change for a derivative");
    if (got(m.publishers["archive-films"].addr) !== 56_250n) throw new Error(`a source is paid on a sale it was not part of: ${got(m.publishers["archive-films"].addr)}`);
    if (got(m.agents.curator.addr) !== 337_500n) throw new Error(`the curator keeps the rest: ${got(m.agents.curator.addr)}`);
    if (m.agents.curator.earned !== 337_500n) throw new Error("earnings must be credited to the seller");

    // ── the consumer becomes a publisher ────────────────────────────────────
    // The reader bought a derivative, consumed it, and now sells what consuming
    // it produced. Under surveillance this stream is taken for free and the
    // corpora that produced the attention are paid nothing; here they are paid
    // out of every sale, which is a strictly better offer to a publisher.
    const vec = (a, b) => { const v = new Float32Array(256); v[0] = a; v[1] = b; return v; };
    m.reactions.reader = [
        { id: "f1", corpus: "archive-films", title: "Nosferatu (1922)", reaction: "like", at: "2026-09-01T00:00:00Z", v: [...vec(1, 0)] },
        { id: "f2", corpus: "archive-films", title: "Metropolis 1927", reaction: "like", at: "2026-09-02T00:00:00Z", v: [...vec(0.9, 0.1)] },
        { id: "f3", corpus: "archive-films", title: "a sitcom", reaction: "skip", at: "2026-09-03T00:00:00Z", v: [...vec(0, 1)] },
        { id: "g1", corpus: "games", title: "Obra Dinn", reaction: "like", at: "2026-09-04T00:00:00Z", v: [...vec(0.8, 0.2)] },
    ];
    const sold = sellTaste(m, "reader", 200_000n);
    if (sold.owes.join() !== "archive-films 15%,games 5%") throw new Error(`upstream must follow where the attention went: ${sold.owes}`);
    if (sold.discloses.includes("title") || sold.discloses.includes("item")) throw new Error("the free index must never name what was watched");

    wallet(m, "trainer").budget = 300_000n;
    buy(m, "trainer", "reader-taste");
    const t = m.payments.at(-1);
    const paid = (to) => t.payouts.find((p) => p.to === to)?.amount ?? 0n;
    if (paid(m.terms.owner) !== 20_000n) throw new Error("the app takes its 10% of behavioural data too");
    if (paid(m.publishers["archive-films"].addr) !== 27_000n) throw new Error(`the films are paid when the reactions to them sell: ${paid(m.publishers["archive-films"].addr)}`);
    if (paid(m.publishers.games.addr) !== 9_000n) throw new Error("…in proportion to how much of the attention they got");
    if (paid(m.agents.reader.addr) !== 144_000n) throw new Error(`the reader keeps the majority of their own signal: ${paid(m.agents.reader.addr)}`);
    if (paid(m.agents.reader.addr) < paid(m.terms.owner) + paid(m.publishers["archive-films"].addr) + paid(m.publishers.games.addr)) {
        throw new Error("if the reader is not the largest payee, nobody would opt in");
    }

    // A seller prices its own selection. Two derivatives over the same inputs can
    // owe different amounts, and the quote says which is which — that is the only
    // place the market can express that curation was worth something.
    publish(m, "curator", "raw-dump", 500_000n, ["archive-films", "games"], ["a", "b"], 4000);
    const dump = quote(m, "raw-dump"), picked = quote(m, "frozen-nights");
    const upstream = (q) => q.payouts.filter((p) => p.why.startsWith("upstream")).reduce((t, p) => t + p.amount, 0n);
    if (upstream(dump) <= upstream(picked)) throw new Error("a seller who leans on its sources must owe them more");
    if (upstream(dump) !== 180_000n) throw new Error(`4000 bps of a 450k publisher pool: ${upstream(dump)}`);
    if (publish(m, "curator", "all-mine", 1n, ["games"], ["x"], 0).lineage.length !== 0) throw new Error("owing nothing upstream is a claim a seller is allowed to make");

    // ── a publisher buys an answer, never the rows ──────────────────────────
    // Six readers with logs; the publisher pays once and every reader is paid the
    // same amount, because paying by contribution would publish the one number the
    // masking exists to hide.
    for (const who of ["r1", "r2", "r3", "r4", "r5"]) {
        m.reactions[who] = [{ id: `x-${who}`, corpus: "archive-films", title: "t", reaction: "like",
                              at: "2026-09-01T00:00:00Z", v: [...vec(1, 0)] }];
        wallet(m, who);
    }
    wallet(m, "studio").budget = 500_000n;
    const round = await cohort(m, "studio", 300_000n, "archive-films");
    if (round.answer.readers !== 6) throw new Error(`every reader with a log is invited: ${round.answer.readers}`);
    // 5 planted readers x 1 film each, plus the reader's 3 archive-films reactions
    // (their 4th was in `games` and correctly does not match a films question).
    if (round.answer.matched !== 8) throw new Error(`the question must scope to its corpus: ${round.answer.matched}`);
    if (round.answer.like !== 7 || round.answer.skip !== 1) throw new Error(`sentiment must survive aggregation: ${round.answer.like}/${round.answer.skip}`);
    const rp = m.payments.at(-1).payouts.filter((p) => p.to !== m.terms.owner).map((p) => String(p.amount));
    if (new Set(rp).size !== 1) throw new Error(`readers must be paid identically — an unequal payment is a disclosure: ${rp}`);
    if (m.payments.at(-1).payouts.reduce((t, p) => t + p.amount, 0n) !== 300_000n) throw new Error("a cohort payment conserves money like any other");

    // Below the floor it refuses rather than answering about three people.
    const tiny = structuredClone(SEED);
    tiny.reactions = { only: m.reactions.reader };
    wallet(tiny, "studio").budget = 500_000n;
    let refused = false;
    try { await cohort(tiny, "studio", 1000n, "archive-films"); } catch (e) { refused = /floor|dossier/.test(e.message); }
    if (!refused) throw new Error("a cohort under the floor must be refused, not answered");

    // You cannot cite what you did not buy.
    let threw = false;
    try { publish(m, "reader", "cheap", 1n, ["places"], ["x"]); } catch { threw = true; }
    if (!threw) throw new Error("lineage must be limited to what the publisher owns");

    // A buyer with no budget left does not buy.
    // 800k budget, 500k spent on the derivative — the 400k corpus is out of reach.
    threw = false;
    try { buy(m, "reader", "archive-transcripts"); } catch { threw = true; }
    if (!threw) throw new Error("an agent must not spend past its budget");

    const b = books(m);
    console.log(j({ ...b, note: "books balance: payouts == payments == agent spend" }));
    console.log("market.mjs self-check ok — app take fixed at 10%, a derivative pays its sources on every sale, "
        + "budgets bind, a publisher buys a cohort answer and pays every reader identically, "
        + "a publisher sets what it owes upstream and the quote shows it, citations limited to what was bought, a reader's own reactions sell as a corpus that pays the "
        + "corpora it watched and still leaves the reader the largest payee, books balance to the base unit");
}
