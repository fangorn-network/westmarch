// Buying an answer instead of buying everybody's rows.
//
// THE PROBLEM WITH THE OBVIOUS VERSION
// ------------------------------------
// A publisher wants to know how its catalogue landed. The obvious way is to buy
// readers' reaction corpora and add them up — which works, pays the readers, and
// ends with the publisher holding every reader's private log. That is surveillance
// with an invoice attached. The reader is paid once and watched forever, and the
// publisher now owns a liability it cannot delete from anyone else's copy.
//
// So the publisher buys the AGGREGATE and never the rows:
//
//   1. the publisher posts a question and a budget,
//   2. each reader evaluates the question against their own log, LOCALLY,
//      producing a short vector of integers — counts, and a sum of the vectors
//      of the things they reacted to,
//   3. each reader masks that vector with values that cancel across the cohort,
//   4. anyone sums the masked shares. The masks vanish; the totals remain.
//
// The publisher learns the totals. Nobody — not the publisher, not the other
// readers, not whoever does the summing — learns any individual's contribution,
// because an individual's share is their real answer plus values that are
// indistinguishable from random until every other share is added to it.
//
// HOW THE MASKS CANCEL
// --------------------
// For every pair of readers (i, j) a shared secret is derived by ECDH over their
// published keys, expanded by HKDF into a stream of 64-bit words. The reader with
// the lower public key ADDS that stream, the other SUBTRACTS it. Sum the cohort
// and every pair contributes +m and -m. This is textbook pairwise-masked secure
// aggregation; nothing here is novel and that is the point — the novel part would
// be the part that is wrong.
//
// Arithmetic is mod 2^64 so the cancellation is exact rather than approximate. A
// single share is uniform over that ring, which is what makes it safe to publish.
//
// WHAT THIS DOES NOT DO
// ---------------------
// ponytail: no dropout recovery. If a reader commits to a round and then does not
// submit, their pairs never cancel and the total is noise — the round fails and
// nobody is paid, rather than the publisher receiving a plausible wrong answer.
// That is the correct failure, and `verify` below detects it for free. Bonawitz's
// secret-shared recovery fixes it properly; add it when real readers on real
// networks start dropping, not before.
//
// ponytail: the cohort is also not protected against a publisher that colludes
// with n-1 readers to isolate the nth. MIN_COHORT bounds the damage but does not
// remove it; only differential privacy noise does, and noise costs accuracy that
// a cohort this small cannot spare. Named here rather than papered over.

const MOD = 1n << 64n;
const mod = (x) => ((x % MOD) + MOD) % MOD;

/** Fewest readers that may answer a question. A cohort of one is an interview. */
export const MIN_COHORT = 5;
/**
 * Fewest MATCHED reactions before a direction is reported.
 *
 * The masking protects WHO answered and is silent about WHAT. Six readers were
 * asked how they reacted around Nosferatu; exactly one reaction matched; the
 * centroid came back and ranked the publisher's own shelf as
 * `nosferatu-1of5`, `Grave-of-the-Vampire`, `Nosferatu_1922_Symphony_of_Horror`.
 * A perfect recovery of one reader's film, through a mechanism whose whole claim
 * is that it does not do that.
 *
 * A mean over k things is those things when k is small, however many people were
 * standing behind it. So the counts may be reported at any support — they are
 * genuinely aggregate — and the DIRECTION is withheld until enough reactions
 * stand behind it to be a direction rather than a disclosure.
 */
export const MIN_SUPPORT = 5;
/** Leading components of the attention centroid the cohort reports. */
export const STAT_DIM = 128;
/** Fixed point for the vector sum: floats live in [-1,1] and must add exactly. */
export const SCALE = 1n << 20n;

/** Slot 0 is a presence tally — every reader contributes exactly 1.
 *  It is what makes a botched round detectable: see `verify`. */
export const SLOTS = ["present", "matched", "like", "skip", "share"];
export const WIDTH = SLOTS.length + STAT_DIM;

const enc = new TextEncoder();
const bytesOf = (buf) => new Uint8Array(buf);
const hex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, "0")).join("");

/** A reader's identity for one round. Ephemeral by default — a key reused across
 *  rounds lets an observer link the same reader's answers into a profile, which
 *  is the thing the whole mechanism exists to prevent. */
export async function keypair() {
    const kp = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    const pub = bytesOf(await crypto.subtle.exportKey("raw", kp.publicKey));
    return { privateKey: kp.privateKey, publicKey: kp.publicKey, pub, id: hex(pub) };
}

/**
 * What one reader answers, before masking.
 *
 * `query` is `{ corpus, items, near, minScore }` — any of them. It runs on the
 * reader's own machine against their own log, so the question is answered without
 * the log ever moving. A question that matches nothing still produces a share, and
 * must: a reader who only replies when they have something to say has disclosed
 * that they have something to say.
 */
export function statistics(reactions = [], query = {}) {
    const out = new Array(WIDTH).fill(0n);
    out[0] = 1n;                                   // present
    const items = query.items ? new Set(query.items.map(String)) : null;
    const near = query.near ? unit(query.near) : null;
    const floor = query.minScore ?? 0.35;

    for (const r of reactions) {
        if (query.corpus && r.corpus !== query.corpus) continue;
        if (items && !items.has(String(r.id))) continue;
        const v = r.vector ?? (r.v ? Float32Array.from(r.v) : null);
        if (near) {
            if (!v) continue;
            let s = 0; const u = unit(v);
            for (let i = 0; i < Math.min(u.length, near.length); i++) s += u[i] * near[i];
            if (s < floor) continue;
        }
        out[1] += 1n;                              // matched
        const k = SLOTS.indexOf(String(r.reaction ?? "like"));
        if (k > 1) out[k] += 1n;
        if (v) {
            const u = unit(v);
            for (let i = 0; i < Math.min(STAT_DIM, u.length); i++) {
                out[SLOTS.length + i] += BigInt(Math.round(u[i] * Number(SCALE)));
            }
        }
    }
    return out;
}

const unit = (v) => {
    let n = 0; for (let i = 0; i < v.length; i++) n += v[i] * v[i];
    n = Math.sqrt(n) || 1;
    const o = new Float32Array(v.length);
    for (let i = 0; i < v.length; i++) o[i] = v[i] / n;
    return o;
};

/** The pairwise mask stream between two readers, as WIDTH 64-bit words. */
async function pairMask(priv, peerPubRaw, round) {
    const peer = await crypto.subtle.importKey("raw", peerPubRaw, { name: "ECDH", namedCurve: "P-256" }, false, []);
    const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: peer }, priv, 256);
    const key = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits(
        { name: "HKDF", hash: "SHA-256", salt: enc.encode("westmarch-cohort-v1"), info: enc.encode(String(round)) },
        key, WIDTH * 64);
    const dv = new DataView(bits);
    return Array.from({ length: WIDTH }, (_, i) => dv.getBigUint64(i * 8));
}

/**
 * One reader's share: their real answer, made uniform.
 *
 * `peers` are every OTHER reader's raw public key in the round. Direction is
 * decided by comparing public keys, so the two sides of a pair agree without
 * talking to each other.
 */
export async function contribute(stats, me, peers, round = 0) {
    const share = stats.map(mod);
    for (const p of peers) {
        const peerHex = hex(p);
        if (peerHex === me.id) continue;
        const m = await pairMask(me.privateKey, p, round);
        const add = me.id < peerHex;
        for (let i = 0; i < WIDTH; i++) share[i] = mod(add ? share[i] + m[i] : share[i] - m[i]);
    }
    return share;
}

/**
 * Sum the shares. The masks cancel; the answer is exact.
 *
 * Refuses below `minCohort` — the guard is on the number of PEOPLE, not rows,
 * because an aggregate over two readers is two readers' data with a total sign on
 * it. This is the same floor that shows up everywhere else in this codebase, and
 * it is the only line between "an aggregate" and "a dossier".
 */
export function aggregate(shares, { minCohort = MIN_COHORT } = {}) {
    if (shares.length < minCohort) {
        throw new Error(`a cohort of ${shares.length} is not an aggregate — ${minCohort} readers minimum`);
    }
    const total = new Array(WIDTH).fill(0n);
    for (const s of shares) for (let i = 0; i < WIDTH; i++) total[i] = mod(total[i] + s[i]);
    return total;
}

/** Signed read-back: counts are small positives, vector sums straddle zero. */
const signed = (x) => (x >= MOD / 2n ? x - MOD : x);

/**
 * Did the masks cancel?
 *
 * Slot 0 is 1 per reader, so the total must equal the cohort size exactly. If any
 * reader dropped out or sent a share from the wrong round, slot 0 lands somewhere
 * uniform in 2^64 and this catches it. One integer comparison, and it turns a
 * silently wrong answer into a failed round.
 */
export function verify(total, expected) {
    return signed(total[0]) === BigInt(expected);
}

/**
 * The total, as the publisher reads it — and ONLY as the publisher reads it.
 *
 * There is no per-reader anything in here, because there is no per-reader
 * anything in the input. What comes back is the count, the sentiment split, and
 * the direction attention pointed: a unit vector the publisher can rank its own
 * catalogue against to see which of its rows the cohort actually leaned toward.
 */
export function readout(total, cohort, { minSupport = MIN_SUPPORT } = {}) {
    if (!verify(total, cohort)) {
        return { ok: false, why: "the masks did not cancel — a reader dropped out or answered a different round" };
    }
    const n = (i) => Number(signed(total[i]));
    const matched = n(1);
    const supported = matched >= minSupport;
    const centroid = total.slice(SLOTS.length).map((x) => Number(signed(x)) / Number(SCALE));
    const norm = Math.sqrt(centroid.reduce((s, x) => s + x * x, 0)) || 1;
    return {
        ok: true,
        readers: cohort,
        matched,
        like: n(2), skip: n(3), share: n(4),
        // Averaged over readers, so one enthusiast cannot outvote the cohort.
        perReader: +(matched / cohort).toFixed(2),
        sentiment: matched ? +((n(2) + n(4) - n(3)) / matched).toFixed(3) : null,
        // Withheld, not zeroed — a caller must be able to tell "nobody went there"
        // from "not enough people went there to say where".
        centroid: supported ? centroid.map((x) => x / norm) : null,
        ...(supported ? {} : {
            withheld: `direction withheld: ${matched} matched reaction${matched === 1 ? "" : "s"} is not a direction, `
                + `it is ${matched === 1 ? "one reader's row" : "a handful of rows"} with a mean drawn round ${matched === 1 ? "it" : "them"}. `
                + `${minSupport} needed.`,
        }),
    };
}

// ── self-check: `node publish/cohort.js` ──────────────────────────────────
if (typeof process !== "undefined" && import.meta.url === `file://${process.argv[1]}`) {
    const vec = (a, b) => { const v = new Float32Array(STAT_DIM); v[0] = a; v[1] = b; return v; };
    const log = (n, seed) => Array.from({ length: n }, (_, i) => ({
        id: `row-${seed}-${i}`, corpus: "films", reaction: i % 4 === 3 ? "skip" : "like",
        vector: vec(1 - (i % 3) * 0.1, (i % 3) * 0.1),
    }));

    // ── statistics run locally and always answer ──
    const s0 = statistics(log(4, "a"), { corpus: "films" });
    if (s0[0] !== 1n || s0[1] !== 4n) throw new Error("presence and matched counts");
    if (s0[2] !== 3n || s0[3] !== 1n) throw new Error(`like/skip split: ${s0[2]}/${s0[3]}`);
    const none = statistics(log(4, "a"), { corpus: "games" });
    if (none[0] !== 1n || none[1] !== 0n) throw new Error("a reader with nothing to say must still answer — silence is a disclosure");

    // ── a round of 6 readers ──
    const R = 6;
    const keys = [];
    for (let i = 0; i < R; i++) keys.push(await keypair());
    const pubs = keys.map((k) => k.pub);
    const logs = keys.map((_, i) => log(3 + i, `r${i}`));
    const truth = logs.map((l) => statistics(l, { corpus: "films" }))
        .reduce((a, b) => a.map((x, i) => x + b[i]));

    const shares = [];
    for (let i = 0; i < R; i++) shares.push(await contribute(statistics(logs[i], { corpus: "films" }), keys[i], pubs));

    // A single share must look like nothing. Slot 0 is 1 in the clear; masked it
    // must be an enormous ring element, and it must differ every round.
    const bare = statistics(logs[0], { corpus: "films" });
    if (shares[0][0] === bare[0]) throw new Error("a published share must not equal the answer it hides");
    if (shares[0][0] < (1n << 40n)) throw new Error(`a masked count must be uniform over the ring, got ${shares[0][0]}`);
    if (shares.filter((s) => s[1] < (1n << 40n)).length > 1) throw new Error("shares must not be recognisably small");

    const total = aggregate(shares);
    if (!verify(total, R)) throw new Error("the masks must cancel exactly");
    for (let i = 0; i < WIDTH; i++) {
        if (total[i] !== mod(truth[i])) throw new Error(`slot ${i} lost the sum: ${total[i]} vs ${mod(truth[i])}`);
    }
    const out = readout(total, R);
    if (!out.ok || out.readers !== R) throw new Error("the readout must be clean");
    if (out.matched !== Number(truth[1])) throw new Error(`matched: ${out.matched} vs ${truth[1]}`);
    if (out.like + out.skip !== out.matched) throw new Error("every match is a like or a skip here");
    if (out.centroid.length !== STAT_DIM) throw new Error("the publisher gets a direction to rank against");
    if (Math.abs(Math.sqrt(out.centroid.reduce((s, x) => s + x * x, 0)) - 1) > 1e-6) throw new Error("the centroid must be a unit vector");
    if (out.centroid[0] < 0.9) throw new Error(`attention pointed at the first axis: ${out.centroid[0].toFixed(3)}`);

    // ── a direction over too few reactions IS those reactions ──────────────
    // This is not hypothetical. Six readers were asked about the region around
    // Nosferatu; one reaction matched; the returned centroid ranked the
    // publisher's own catalogue and put that exact film first. The cohort floor
    // did nothing, because it counts people and the leak was in the arithmetic.
    const lonelyLogs = [[{ id: "secret", corpus: "films", reaction: "like", vector: vec(0, 1) }],
        ...Array.from({ length: 4 }, () => [{ id: "elsewhere", corpus: "games", reaction: "like", vector: vec(1, 0) }])];
    const lk = []; for (let i = 0; i < 5; i++) lk.push(await keypair());
    const lp = lk.map((k) => k.pub);
    const ls = [];
    for (let i = 0; i < 5; i++) ls.push(await contribute(statistics(lonelyLogs[i], { corpus: "films" }), lk[i], lp));
    const lonely = readout(aggregate(ls), 5);
    if (!lonely.ok) throw new Error("the round itself is fine — it is the reporting that must hold back");
    if (lonely.matched !== 1) throw new Error("one reaction matched");
    if (lonely.centroid) throw new Error("a centroid over ONE reaction is that reaction — it must be withheld");
    if (!lonely.withheld?.includes("1 matched")) throw new Error("and it must say why, so a publisher knows to widen the question");
    if (lonely.readers !== 5 || lonely.like !== 1) throw new Error("counts are genuinely aggregate and stay");
    // With support, the direction comes back.
    if (!readout(aggregate(ls), 5, { minSupport: 1 }).centroid) throw new Error("the floor is a dial, not a wall");

    // ── a dropout must FAIL, not answer plausibly ──
    const short = aggregate(shares.slice(0, R - 1), { minCohort: 2 });
    if (verify(short, R - 1)) throw new Error("a missing reader must break the sum, not shrink it");
    if (readout(short, R - 1).ok) throw new Error("a broken round must refuse to report rather than report noise");

    // ── the floor is on PEOPLE ──
    let threw = false;
    try { aggregate(shares.slice(0, MIN_COHORT - 1)); } catch { threw = true; }
    if (!threw) throw new Error(`fewer than ${MIN_COHORT} readers is an interview, not an aggregate`);

    // ── a reader's log never moves, and the share does not encode it ──
    // Two readers with IDENTICAL logs produce different shares, so a share cannot
    // be matched against a guess at what someone watched.
    const twin = [await keypair(), await keypair(), await keypair(), await keypair(), await keypair()];
    const same = log(5, "same");
    const tShares = [];
    for (let i = 0; i < 5; i++) tShares.push(await contribute(statistics(same, { corpus: "films" }), twin[i], twin.map((k) => k.pub)));
    if (tShares[0].join() === tShares[1].join()) throw new Error("identical logs must not produce identical shares");
    const tTotal = aggregate(tShares);
    if (Number(signed(tTotal[1])) !== 5 * 5) throw new Error("…and must still sum correctly");

    // ── the query runs on the reader's side: `near` selects a region ──
    const mixed = [...log(3, "x"), { id: "far", corpus: "films", reaction: "like", vector: vec(0, 1) }];
    const region = statistics(mixed, { corpus: "films", near: vec(1, 0), minScore: 0.9 });
    if (Number(region[1]) !== 3) throw new Error(`a region query must exclude what is outside it: ${region[1]}`);

    console.log("cohort.js self-check ok — a question is answered on the reader's machine, shares are uniform over 2^64 and "
        + "differ for identical logs, the masks cancel to the exact total, a dropout fails the round instead of faking it, "
        + "fewer than five readers is refused as an interview, and a direction over too few reactions is withheld "
        + "because a mean over one row IS that row however many people stood behind it");
}
