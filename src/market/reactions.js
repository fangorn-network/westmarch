// A consumer's reactions, as a corpus anyone can buy.
//
// THE ARGUMENT THIS FILE EXISTS TO MAKE
// -------------------------------------
// Surveillance is not the only way to get behavioural data, and this claims it
// is not even the profitable way. Under surveillance the platform takes the
// reaction stream for free and the publisher whose catalogue produced it gets
// nothing — the film that made someone lean forward is an input the film's owner
// is not paid for. Here the same stream is a corpus with `lineage`, so when a
// trainer buys one agent's reactions the corpora those reactions were ABOUT are
// paid out of the sale. Publishers earn from the reaction economy rather than
// being its raw material. That is a better offer than surveillance makes them,
// and it is the whole of the wedge.
//
// WHY A CONSUMER CAN PUBLISH THIS WITH NO INFRASTRUCTURE
// ------------------------------------------------------
// A reaction's vector is the vector of the row reacted to, which the reader
// already downloaded in order to react to it. So a reaction corpus needs no
// model, no GPU, no bake, no quickbeam — the vectors are copied, not computed.
// The only thing that has to be fitted locally is `coverage`, which is eight
// centroids and is the function below. A consumer becoming a publisher is
// therefore not a tier you upgrade into; it is this file and a price.
//
// WHAT THE FREE INDEX DISCLOSES, AND WHAT IT DOES NOT
// ---------------------------------------------------
// Free: the COVERAGE CENTROIDS — where this reader's attention sits, and how
//       densely — plus which corpora they were reading in, and the month.
// Paid: which item, what it was called, and whether it was a like or a skip.
//
// A reaction row ships NO VECTOR, and that is the whole design rather than an
// omission. The first version shipped one, on the reasoning that a buyer needs
// to rank before paying. Measured against the live `games` corpus, that handed
// over everything:
//
//   5 of 5 paid rows identified EXACTLY, at cosine 1.0000
//
// because a reaction's vector is a byte-for-byte copy of the row it reacted to,
// and the source corpora are free to download. Anyone could join the two and read
// the paid column for nothing. No amount of coarsening fixes a copy — the fix is
// to not publish it.
//
// Nothing is lost, because nobody buys row 47 of a stranger's reactions. A taste
// corpus is bought WHOLE, and the question a buyer actually asks — "does this
// reader have dense signal where I am training?" — is answered by the centroids
// alone. That is already how `src/discover/directory.js` ranks a corpus nobody has
// downloaded. Per-row vectors served no buyer and leaked the entire product.
//
// The centroids are themselves averages, so `k` is capped to keep at least
// MIN_PER_CENTROID reactions behind each one. A centroid over a single reaction
// IS that reaction's vector under another name, which is the same leak wearing a
// hat, and a reader with nine reactions is exactly who most needs this to hold.

import { packVec } from "../core/embed.js";
import { lineage } from "./terms.js";

// 32, not 8: on Kingsfoil the top 3 of 23 views held 92% of the true top 10 with 32
// centroids and 86% with 8, and 8 missed whole topics (ALS → neurology).
export const COVERAGE_K = 32;
export const COVERAGE_DIM = 128;
/** Fewest reactions that may stand behind one published centroid. */
export const MIN_PER_CENTROID = 8;

const l2 = (v) => { let n = 0; for (let i = 0; i < v.length; i++) n += v[i] * v[i]; return Math.sqrt(n) || 1; };
const unit = (v) => { const n = l2(v), o = new Float32Array(v.length); for (let i = 0; i < v.length; i++) o[i] = v[i] / n; return o; };
const dot = (a, b) => { let s = 0, n = Math.min(a.length, b.length); for (let i = 0; i < n; i++) s += a[i] * b[i]; return s; };

/**
 * Spherical k-means over the corpus's own vectors — the routing summary that
 * lets a buyer rank this corpus WITHOUT downloading it.
 *
 * Mirrors quickbeam's `cdn._coverage`: fit at full width, truncate to `dim`
 * leading components (Matryoshka), then RENORMALIZE, because a truncated unit
 * vector is not unit and the client compares against a truncated query it
 * renormalizes too. Get that order wrong and routing degrades silently.
 *
 * ponytail: farthest-point init rather than k-means++, so it needs no RNG and
 * two runs over the same rows produce byte-identical centroids — a publisher
 * re-baking must not mint a new manifest that says something different. Swap in
 * k-means++ if cluster quality ever measurably matters; for choosing between
 * corpora, which sit far apart, it does not.
 */
export function coverage(vectors, { k = COVERAGE_K, dim = COVERAGE_DIM, iters = 10 } = {}) {
    const X = (vectors ?? []).filter((v) => v?.length).map(unit);
    if (!X.length) return null;
    k = Math.max(1, Math.min(k, X.length));

    // Farthest-point init: start at the first row, then repeatedly take the row
    // least similar to anything chosen so far.
    const C = [X[0]];
    const best = X.map((x) => dot(x, X[0]));
    while (C.length < k) {
        let pick = 0;
        for (let i = 1; i < X.length; i++) if (best[i] < best[pick]) pick = i;
        C.push(X[pick]);
        for (let i = 0; i < X.length; i++) best[i] = Math.max(best[i], dot(X[i], X[pick]));
    }

    const width = X.reduce((n, v) => Math.max(n, v.length), 0);
    let assign = new Int32Array(X.length);
    for (let it = 0; it < iters; it++) {
        let moved = 0;
        for (let i = 0; i < X.length; i++) {
            let bi = 0, bs = -Infinity;
            for (let c = 0; c < C.length; c++) { const s = dot(X[i], C[c]); if (s > bs) { bs = s; bi = c; } }
            if (assign[i] !== bi) { assign[i] = bi; moved++; }
        }
        const sums = C.map(() => new Float32Array(width));
        const n = new Array(C.length).fill(0);
        for (let i = 0; i < X.length; i++) {
            const s = sums[assign[i]]; n[assign[i]]++;
            for (let j = 0; j < X[i].length; j++) s[j] += X[i][j];
        }
        // An empty cluster keeps its old centroid rather than collapsing to zero.
        for (let c = 0; c < C.length; c++) if (n[c]) C[c] = unit(sums[c]);
        if (!moved) break;
    }

    const d = Math.min(dim, width);
    const counts = new Array(C.length).fill(0);
    for (const a of assign) counts[a]++;
    return {
        dim: d, sampled: X.length,
        vectors: C.map((c) => [...unit(c.slice(0, d))].map((x) => Math.round(x * 1e4) / 1e4)),
        counts,
    };
}

/** The month a reaction happened in. Coarse ON PURPOSE — an exact timestamp is
 *  a join key against any other log, and the training value of "when" is at
 *  month resolution anyway. Nothing here needs to be precise enough to re-identify. */
const month = (at) => new Date(at ?? Date.now()).toISOString().slice(0, 7);

/** What the free index shows about a reaction, versus what a sale reveals. */
export const FREE = ["event", "corpus", "label", "month"];
export const LOCKED = ["reaction", "item", "title", "text"];

/**
 * Reactions → a publishable corpus.
 *
 * `events` are `{ id, corpus, title, vector, reaction, at }` — exactly what a
 * reader already has after ranking a row and acting on it.
 *
 * `sources` maps a corpus name to the address that gets paid when this sells.
 * Upstream is paid out of the PUBLISHER's share (never the app's), split in
 * proportion to how many of these reactions each corpus produced — a corpus that
 * supplied four fifths of the signal earns four fifths of the upstream cut.
 */
export function reactionCorpus(events = [], {
    publisher, name = "reactions", description, sources = {},
    price = "250000", asset = "USDC", upstreamBps = 2000, sample = 0.01,
} = {}) {
    const rows = events.filter((e) => e?.vector?.length);
    if (!rows.length) throw new Error("a reaction corpus needs at least one reaction with a vector");
    if (!publisher) throw new Error("a reaction corpus needs a publisher address to pay");

    const byCorpus = new Map();
    for (const e of rows) byCorpus.set(e.corpus, (byCorpus.get(e.corpus) ?? 0) + 1);

    // Upstream, proportional to contribution. Every share rounds down and the
    // remainder goes to the largest contributor, so the declared total is exact
    // rather than a basis point short — `terms.lineage` refuses anything over,
    // and a buyer reconciling a receipt against the manifest must find them equal.
    const cited = [...byCorpus].filter(([c]) => sources[c]).sort((a, b) => b[1] - a[1]);
    const citedTotal = cited.reduce((s, [, n]) => s + n, 0);
    const shares = cited.map(([c, n]) => ({ to: sources[c], bps: Math.floor((upstreamBps * n) / citedTotal), note: c }));
    if (shares.length) shares[0].bps += upstreamBps - shares.reduce((s, e) => s + e.bps, 0);
    const up = lineage(shares.filter((e) => e.bps > 0));

    // The split is applied HERE, to the rows themselves, not merely declared in
    // the manifest. Declaring it and shipping the fields anyway is the exact bug
    // `src/publish/lint.js` calls "paywall names fields the free shard ships anyway",
    // and this file had it: it returned every field on every row and left the
    // withholding to a bake that does not run on this path.
    const wire = [], locked = [];
    rows.forEach((e, i) => {
        const item = String(e.id ?? i);
        // An ORDINAL, never the item. The id was `${name}:${item}`, which reads as
        // an internal detail until you notice a corpus whose identity role IS its
        // title (`games` is one), and then the free index is publishing the paid
        // column inside its own primary key. Third time this shape appeared: the
        // free thing was derived from the paid thing, and derivation is disclosure.
        //
        // ponytail: ordinals are stable while reactions only ever append, which is
        // what a reaction log does. Deleting one renumbers the rest and breaks a
        // buyer's citations — hash (name, item) if reactions ever become editable.
        const id = `${name}:${i}`;
        wire.push({
            track_id: id,
            owner: publisher,
            fields: {
                entityType: "reaction",
                event: id,
                corpus: String(e.corpus ?? "?"),
                // The free title names the corpus, never the item. A reader
                // scanning the index sees the shape of someone's attention
                // without seeing one thing they paid attention to.
                label: `a reaction in ${e.corpus ?? "?"}`,
                month: month(e.at),
            },
            // No `v`. See the header — it was a copy of the source row's vector.
        });
        locked.push({
            track_id: id,
            fields: {
                reaction: String(e.reaction ?? "like"),
                item,
                title: String(e.title ?? ""),
                text: `${e.reaction ?? "like"} · ${e.title ?? ""}`.trim(),
                v: packVec(e.vector),   // the buyer gets full fidelity, having paid
            },
        });
    });

    const manifest = {
        name,
        description: description ?? `${rows.length} reactions from one reader across ${byCorpus.size} corpora — what held their attention, and what did not.`,
        count: rows.length,
        dim: rows[0].vector.length,
        model: "nomic-ai/nomic-embed-text-v1.5",
        distance: "Cosine",
        role_map: {
            identity: "event", title: "label", subtitle: "corpus", temporal: "month",
            spatial: null, media: null, tags: ["corpus"], measures: [], relations: [],
            text: ["text"],
        },
        entity_types: [{ type: "reaction", count: rows.length }],
        presentation: { types: { reaction: { icon: "👍", accent: "#7a5cc9", singular: "Reaction", plural: "Reactions" } } },
        paywall: {
            free: FREE, locked: LOCKED, price: String(price), asset,
            sample: { rate: sample, count: 0 },   // filled by the caller that writes the shard
        },
        coverage: coverage(rows.map((e) => e.vector),
                           { k: Math.max(1, Math.min(COVERAGE_K, Math.floor(rows.length / MIN_PER_CENTROID))) }),
        shards: [],
    };
    return { manifest, rows: wire, locked, lineage: up, byCorpus: Object.fromEntries(byCorpus) };
}

// ── self-check: `node src/market/reactions.js` ────────────────────────────────
if (typeof process !== "undefined" && import.meta.url === `file://${process.argv[1]}` && process.argv[1].endsWith("/reactions.js")) {
    const { splitPayment } = await import("./terms.js");
    const A = (n) => `0x${String(n).repeat(40).slice(0, 40)}`;
    const vec = (a, b) => { const v = new Float32Array(256); v[0] = a; v[1] = b; return v; };

    // ── coverage: the summary a buyer ranks without downloading anything ──
    if (coverage([]) !== null) throw new Error("no vectors is no coverage, not an empty one");
    const two = coverage([vec(1, 0), vec(1, 0.01), vec(0, 1), vec(0.01, 1)], { k: 2 });
    if (two.vectors.length !== 2 || two.sampled !== 4) throw new Error("k centroids over n rows");
    if (two.counts.reduce((s, c) => s + c, 0) !== 4) throw new Error("every row is counted exactly once");
    if (two.dim !== 128 || two.vectors[0].length !== 128) throw new Error("centroids truncate to 128d like the bake");
    for (const c of two.vectors) {
        const n = Math.sqrt(c.reduce((s, x) => s + x * x, 0));
        if (Math.abs(n - 1) > 0.01) throw new Error(`a truncated centroid must be RENORMALIZED, got |c| = ${n}`);
    }
    // The two clusters are found, not averaged into one blur.
    const sims = two.vectors.map((c) => Math.abs(c[0]));
    if (Math.max(...sims) < 0.9 || Math.min(...sims) > 0.1) throw new Error(`k-means must separate the two groups: ${sims}`);
    // Deterministic: a re-publish must not mint a manifest that says something new.
    if (JSON.stringify(coverage([vec(1, 0), vec(0, 1), vec(1, 0.2)], { k: 2 }))
        !== JSON.stringify(coverage([vec(1, 0), vec(0, 1), vec(1, 0.2)], { k: 2 }))) throw new Error("two fits over the same rows must agree byte for byte");
    if (coverage([vec(1, 0)], { k: 8 }).vectors.length !== 1) throw new Error("k is capped at the number of rows");

    // ── the corpus ──
    const EV = [
        { id: "f1", corpus: "archive-films", title: "Nosferatu (1922)", vector: vec(1, 0), reaction: "like", at: "2026-08-14T10:00:00Z" },
        { id: "f2", corpus: "archive-films", title: "Metropolis 1927", vector: vec(0.9, 0.1), reaction: "like", at: "2026-08-15T10:00:00Z" },
        { id: "f3", corpus: "archive-films", title: "some sitcom", vector: vec(0, 1), reaction: "skip", at: "2026-08-16T10:00:00Z" },
        { id: "g1", corpus: "games", title: "Return of the Obra Dinn", vector: vec(0.8, 0.2), reaction: "like", at: "2026-08-17T10:00:00Z" },
    ];
    const SRC = { "archive-films": A(1), games: A(2) };
    const { manifest, rows, locked, lineage: up, byCorpus } = reactionCorpus(EV, { publisher: A(3), name: "taste-of-3", sources: SRC, price: "300000" });

    if (rows.length !== 4 || manifest.count !== 4) throw new Error("every reaction with a vector becomes a row");
    if (byCorpus["archive-films"] !== 3 || byCorpus.games !== 1) throw new Error("contribution is counted per corpus");

    // The split the free index is allowed to make — APPLIED, not just declared.
    for (const r of rows) {
        for (const f of FREE) if (!(f in r.fields)) throw new Error(`the free index must carry ${f}`);
        for (const f of LOCKED) if (f in r.fields) throw new Error(`the free index must NOT carry ${f} — declaring a split is not applying one`);
        if (r.fields.month.length !== 7) throw new Error(`time is coarse on purpose, got ${r.fields.month}`);
        if (/\d{2}T\d{2}/.test(r.fields.month)) throw new Error("an exact timestamp is a join key — never publish one");
    }
    if (LOCKED.some((f) => FREE.includes(f))) throw new Error("a field is on exactly one side");

    // Nothing paid may appear ANYWHERE in a free row, including inside a key. The
    // ids and titles below are the paid column; a substring hit is a leak however
    // it got there.
    for (const r of rows) {
        const blob = JSON.stringify(r);
        for (const e of EV) {
            for (const secret of [e.id, e.title]) {
                if (secret && blob.includes(secret)) throw new Error(`a free row leaks ${JSON.stringify(secret)}: ${blob}`);
            }
        }
    }
    if (rows.some((r) => r.v)) throw new Error("a reaction row must ship NO vector — it is a copy of the source row's, and the source corpora are free");
    if (locked.length !== rows.length) throw new Error("every free row has exactly one paid counterpart");
    if (!locked.every((r) => r.fields.v?.length)) throw new Error("the buyer, having paid, gets the true vector");
    if (new Set(rows.map((r) => r.track_id)).size !== rows.length) throw new Error("ids must be unique or the two halves cannot be joined");

    // THE JOIN ATTACK, which is what made the vectors indefensible: an attacker
    // holding the (free) source corpus matches a published vector against it and
    // reads the paid column for nothing. Measured at 5/5 exact on live `games`.
    // With no vector published there is nothing to match, so the attack needs the
    // one thing it was trying to avoid: buying the corpus.
    const sourceVectors = EV.map((e) => e.vector);
    for (const r of rows) {
        const anyMatch = sourceVectors.some((sv) => JSON.stringify([...sv]) === JSON.stringify([...(r.vector ?? [])]));
        if (anyMatch) throw new Error("a free row must not be joinable to the source corpus it came from");
    }
    // …and the centroids, which ARE published, never stand for one reaction.
    if (manifest.coverage.vectors.length > Math.floor(EV.length / MIN_PER_CENTROID) && EV.length >= MIN_PER_CENTROID) {
        throw new Error("a centroid over a single reaction is that reaction's vector with a hat on");
    }
    if (reactionCorpus(EV, { publisher: A(3), sources: {} }).manifest.coverage.vectors.length !== 1) {
        throw new Error("4 reactions cannot support 8 centroids — collapse to one rather than publish each");
    }

    // Upstream is proportional and EXACT — 3 of 4 reactions came from the films.
    const bps = Object.fromEntries(up.map((e) => [e.note, Number(e.bps)]));
    if (bps["archive-films"] !== 1500 || bps.games !== 500) throw new Error(`upstream must follow contribution: ${JSON.stringify(bps)}`);
    if (up.reduce((s, e) => s + Number(e.bps), 0) !== 2000) throw new Error("the declared upstream total must be exact, not a basis point short");

    // …and it reconciles against a real sale. This is the claim: the corpora that
    // produced the attention are paid when the attention sells.
    const TERMS = { appId: "fangorn.tv", owner: A(9), appBps: 1000 };
    const pay = splitPayment(300000n, { terms: TERMS, publisher: A(3), lineage: up });
    const got = Object.fromEntries(pay.map((p) => [p.to, p.amount]));
    if (got[A(9)] !== 30000n) throw new Error("the app's cut comes off the top and never moves");
    if (got[A(1)] !== 40500n || got[A(2)] !== 13500n) throw new Error(`upstream is paid from the publisher's share: ${JSON.stringify(got, (k, v) => typeof v === "bigint" ? String(v) : v)}`);
    if (got[A(3)] !== 216000n) throw new Error("the reader keeps the rest");
    if (pay.reduce((s, p) => s + p.amount, 0n) !== 300000n) throw new Error("money is neither invented nor destroyed");

    // A reader who cites a corpus nobody registered simply owes it nothing.
    const orphan = reactionCorpus(EV, { publisher: A(3), sources: { games: A(2) } });
    if (orphan.lineage.length !== 1 || Number(orphan.lineage[0].bps) !== 2000) throw new Error("an unregistered corpus cannot be paid, and its share does not vanish");

    if (!reactionCorpus(EV, { publisher: A(3), sources: {} }).lineage.length === 0) throw new Error("citing nobody is allowed — the reader keeps it all");
    try { reactionCorpus([], { publisher: A(3) }); throw new Error("x"); } catch (e) { if (!e.message.includes("at least one")) throw new Error("an empty corpus must be refused"); }
    try { reactionCorpus(EV, {}); throw new Error("x"); } catch (e) { if (!e.message.includes("publisher")) throw new Error("a corpus with nobody to pay must be refused"); }

    console.log("reactions.js self-check ok — reactions become a corpus with no model, coverage is deterministic and renormalized after truncation, "
        + "the free index ranks on centroids alone, publishes no per-row vector to join against and no paid string anywhere including its own keys, "
        + "time is coarse, upstream follows contribution exactly and reconciles against a real sale");
}
