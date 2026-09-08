// Who gets paid, and how much, when something sells.
//
// An app owner registers terms; publishers join under them; a buyer pays once.
// This file is the arithmetic in the middle, and it is the only revenue
// mechanism in the whole architecture — discovery cannot be charged for (the
// query never leaves the client and the index holds 4 KB per corpus), so a take
// at settlement is the business model or there isn't one.
//
// Two layers, because they are set by different people at different times:
//
//   app terms   the owner's cut, fixed when the app is registered and hashed so
//               a publisher can prove what they agreed to
//   lineage     what a publisher owes UPSTREAM, declared per resource when they
//               publish. Paid out of the publisher's share, never the app's:
//               a derivative's author pays their sources, and the app's cut does
//               not shrink because someone built on someone else.
//
// That second layer is the point. An agent buys three corpora, synthesises a
// fourth, publishes it with lineage naming the three, and every later sale of
// the derivative pays back up the chain. Knowledge in, concept out, concept
// becomes knowledge someone else builds on — with the money following the
// citations instead of stopping at the last hop.
//
// ponytail: BigInt base units, one level of lineage, no recursion. A derivative
// OF a derivative declares its own immediate sources and each hop settles on its
// own sale — walking the tree at settlement time would mean fetching a stranger's
// terms mid-payment, and a payment that depends on someone else's server being
// up is a payment that fails.

const BPS = 10000n;
const ADDR = /^0x[0-9a-fA-F]{40}$/;

const addr = (a) => {
    const s = String(a ?? "").toLowerCase();
    if (!ADDR.test(s)) throw new Error(`not an address: ${a}`);
    return s;
};
const bps = (n, what) => {
    const v = BigInt(n ?? 0);
    if (v < 0n || v > BPS) throw new Error(`${what} must be 0..10000 bps, got ${n}`);
    return v;
};

/**
 * An app's terms, canonical.
 *
 * Canonical because the hash is the thing a publisher agrees to and a buyer can
 * check: same terms must produce the same bytes on any machine, in any key
 * order, forever. So: fixed field order, lowercase addresses, decimal strings
 * for numbers (JSON has no integers), and nothing else in the object.
 */
export function appTerms({ appId, owner, appBps = 0, currency = "USDC", chainId = 421614 }) {
    if (!appId) throw new Error("terms need an appId");
    return {
        v: 1,
        appId: String(appId),
        owner: addr(owner),
        appBps: String(bps(appBps, "appBps")),
        currency: String(currency),
        chainId: Number(chainId),
    };
}

/** Canonical bytes → sha-256. Async because that is the only hash both node and
 *  a browser have without a dependency. */
export async function termsHash(t) {
    const canon = JSON.stringify(appTerms(t));
    const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canon));
    return `0x${[...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** What a publisher owes upstream for one resource. Deduped by payee — the same
 *  source cited twice is one debt, not two, and merging is the only reading that
 *  cannot be gamed by repeating an entry. */
export function lineage(entries = []) {
    const by = new Map();
    for (const e of entries) {
        const to = addr(e.to);
        by.set(to, { to, bps: (by.get(to)?.bps ?? 0n) + bps(e.bps, "lineage bps"), note: e.note ?? by.get(to)?.note ?? "" });
    }
    const out = [...by.values()];
    const total = out.reduce((s, e) => s + e.bps, 0n);
    if (total > BPS) throw new Error(`lineage owes ${total} bps of the publisher's share — more than all of it`);
    return out.map((e) => ({ to: e.to, bps: String(e.bps), ...(e.note ? { note: e.note } : {}) }));
}

/**
 * One payment → the payouts it becomes.
 *
 * Integer base units end to end, and the dust is given to the publisher rather
 * than rounded away: the payouts MUST sum to exactly what the buyer paid, or
 * settlement is inventing or destroying money. Every share rounds down; the
 * publisher absorbs the difference, which is at most one base unit per payee.
 */
export function splitPayment(amount, { terms, publisher, lineage: up = [] } = {}) {
    const total = BigInt(amount);
    if (total < 0n) throw new Error("amount must not be negative");
    const t = appTerms(terms);
    const pub = addr(publisher);

    const payouts = [];
    const appCut = (total * BigInt(t.appBps)) / BPS;
    if (appCut > 0n) payouts.push({ to: t.owner, amount: appCut, why: `app ${t.appId} (${t.appBps} bps)` });

    // Everything the app did not take is the publisher's, and upstream is paid
    // out of that — so a publisher who cites nobody keeps it all, and one who
    // builds on three sources pays them from their own half.
    const publisherPool = total - appCut;
    let owed = 0n;
    for (const e of lineage(up)) {
        const cut = (publisherPool * BigInt(e.bps)) / BPS;
        if (cut === 0n) continue;
        owed += cut;
        payouts.push({ to: e.to, amount: cut, why: `upstream ${e.note || e.to.slice(0, 10)} (${e.bps} bps of the publisher's share)` });
    }

    const keeps = publisherPool - owed;
    payouts.push({ to: pub, amount: keeps, why: "publisher" });

    // Merge payees — an app owner who is also the publisher gets one payout, not
    // two, and a downstream reconciliation that sees the same address twice has
    // no way to tell a split from a double-pay.
    const by = new Map();
    for (const p of payouts) {
        const at = by.get(p.to);
        by.set(p.to, at ? { ...at, amount: at.amount + p.amount, why: `${at.why} + ${p.why}` } : p);
    }
    const merged = [...by.values()];
    const sum = merged.reduce((s, p) => s + p.amount, 0n);
    if (sum !== total) throw new Error(`payouts sum to ${sum}, buyer paid ${total}`);
    return merged;
}

/** Human-readable, for a receipt or a quote. 6-decimal base units — every asset
 *  this settles on is 6-decimal, and a bare "50000" on a buy button is not a
 *  price anyone reads. */
export const label = (base, currency = "USDC") => `${(Number(base) / 1e6).toFixed(2)} ${currency}`;

// ── self-check: `node publish/terms.js` ────────────────────────────────────
if (typeof process !== "undefined" && import.meta.url === `file://${process.argv[1]}`) {
    const A = "0x" + "a".repeat(40);   // app owner
    const P = "0x" + "b".repeat(40);   // publisher
    const S1 = "0x" + "c".repeat(40);  // a source
    const S2 = "0x" + "d".repeat(40);  // another
    const T = { appId: "fangorn.tv", owner: A, appBps: 1000 };
    const at = (ps, to) => ps.find((p) => p.to === to)?.amount ?? 0n;

    // The plain case: 10% to the app, the rest to whoever published it.
    let ps = splitPayment(1_000_000n, { terms: T, publisher: P });
    if (at(ps, A) !== 100_000n || at(ps, P) !== 900_000n) throw new Error(`plain split wrong: ${JSON.stringify(ps, (k, v) => typeof v === "bigint" ? String(v) : v)}`);

    // A derivative: two sources, 20% and 5% OF THE PUBLISHER'S SHARE. The app's
    // cut must not move — that is the whole reason lineage comes out of the
    // publisher's half.
    ps = splitPayment(1_000_000n, { terms: T, publisher: P, lineage: [{ to: S1, bps: 2000 }, { to: S2, bps: 500 }] });
    if (at(ps, A) !== 100_000n) throw new Error("the app's cut must not shrink because the publisher cited someone");
    if (at(ps, S1) !== 180_000n || at(ps, S2) !== 45_000n) throw new Error(`upstream is a share of 900000: ${at(ps, S1)}/${at(ps, S2)}`);
    if (at(ps, P) !== 675_000n) throw new Error(`publisher keeps the rest: ${at(ps, P)}`);

    // Money is neither created nor destroyed, at any amount.
    for (const amt of [0n, 1n, 3n, 7n, 999n, 1_000_001n, 123_456_789n]) {
        const out = splitPayment(amt, { terms: T, publisher: P, lineage: [{ to: S1, bps: 3333 }, { to: S2, bps: 3333 }] });
        const sum = out.reduce((s, p) => s + p.amount, 0n);
        if (sum !== amt) throw new Error(`${amt} split into ${sum}`);
        if (out.some((p) => p.amount < 0n)) throw new Error(`negative payout at ${amt}`);
    }

    // Dust goes to the publisher, never to rounding.
    ps = splitPayment(7n, { terms: { ...T, appBps: 3333 }, publisher: P });
    if (at(ps, A) !== 2n || at(ps, P) !== 5n) throw new Error(`dust must land on the publisher: ${JSON.stringify(ps.map((p) => [p.to.slice(0, 4), String(p.amount)]))}`);

    // One payee, one payout: an app owner who publishes under their own app.
    ps = splitPayment(1_000_000n, { terms: T, publisher: A });
    if (ps.length !== 1 || at(ps, A) !== 1_000_000n) throw new Error("the same address must be paid once, not twice");

    // Citing the same source twice is one debt.
    ps = splitPayment(1_000_000n, { terms: T, publisher: P, lineage: [{ to: S1, bps: 1000 }, { to: S1, bps: 1000 }] });
    if (at(ps, S1) !== 180_000n) throw new Error(`a repeated citation must merge, not double-pay: ${at(ps, S1)}`);

    // Terms are refused, not silently clamped.
    for (const bad of [{ ...T, appBps: 10001 }, { ...T, appBps: -1 }, { ...T, owner: "0xnope" }, { appId: "", owner: A }]) {
        let threw = false;
        try { splitPayment(1n, { terms: bad, publisher: P }); } catch { threw = true; }
        if (!threw) throw new Error(`bad terms must throw: ${JSON.stringify(bad)}`);
    }
    let threw = false;
    try { lineage([{ to: S1, bps: 6000 }, { to: S2, bps: 6000 }]); } catch { threw = true; }
    if (!threw) throw new Error("a publisher cannot owe more than they have");

    // The hash is what a publisher agreed to: stable across key order, and it
    // moves the moment a single term does.
    const h1 = await termsHash(T);
    const h2 = await termsHash({ owner: A, appBps: 1000, appId: "fangorn.tv" });
    if (h1 !== h2) throw new Error("key order must not change the hash");
    if (h1 === await termsHash({ ...T, appBps: 1001 })) throw new Error("a changed cut must change the hash");
    if (!/^0x[0-9a-f]{64}$/.test(h1)) throw new Error(`hash shape: ${h1}`);

    console.log("terms.js self-check ok — app cut fixed, lineage paid from the publisher's share, payouts always sum to what was paid, "
        + "dust to the publisher, repeated payees merged, bad terms refused, terms hash canonical");
}
