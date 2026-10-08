// Paying for a resource over x402 (v1, "exact" scheme): the buyer's half.
//
//   const { body, receipt, price } = await payAndFetch(url, { privateKey, maxPrice: 50000n });
//
// 1. GET url → 402 with `accepts`: what it costs, in which token, on which chain, to whom.
// 2. Sign an EIP-3009 transferWithAuthorization for exactly that (EIP-712, the token's own
//    domain). Nothing is sent on chain by the buyer: the seller's facilitator submits it.
// 3. GET url again with X-PAYMENT: the seller verifies, settles, and returns the resource,
//    with the settlement (the tx hash) in X-PAYMENT-RESPONSE.
//
// `maxPrice` (token base units) is checked BEFORE signing: a seller cannot ask for more
// than the caller agreed to, whatever its 402 says.

const CHAIN_IDS = { "arbitrum-sepolia": 421614, arbitrum: 42161, "base-sepolia": 84532, base: 8453 };
const b64 = (s) => (typeof btoa === "function" ? btoa(s) : Buffer.from(s, "utf8").toString("base64"));
const unb64 = (s) => (typeof atob === "function" ? atob(s) : Buffer.from(s, "base64").toString("utf8"));

/** The one requirement we can pay: exact scheme, a chain we know, within `maxPrice`. */
export function choose(accepts = [], { maxPrice, networks = Object.keys(CHAIN_IDS) } = {}) {
    const ok = accepts.filter((a) => a.scheme === "exact" && networks.includes(a.network));
    if (!ok.length) throw new Error(`no payable option: ${JSON.stringify(accepts.map((a) => `${a.scheme}/${a.network}`))}`);
    const cheapest = ok.sort((a, b) => (BigInt(a.maxAmountRequired) < BigInt(b.maxAmountRequired) ? -1 : 1))[0];
    if (maxPrice != null && BigInt(cheapest.maxAmountRequired) > BigInt(maxPrice))
        throw new Error(`price ${cheapest.maxAmountRequired} exceeds the cap ${maxPrice} (token base units)`);
    return cheapest;
}

/** The X-PAYMENT header value for requirement `req`, signed by `account` (a viem account). */
export async function paymentHeader(req, account, { now = Math.floor(Date.now() / 1000) } = {}) {
    const chainId = CHAIN_IDS[req.network];
    if (!chainId) throw new Error(`unknown network ${req.network}`);
    const nonce = `0x${[...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
    const authorization = {
        from: account.address, to: req.payTo, value: String(req.maxAmountRequired),
        validAfter: String(now - 600), validBefore: String(now + (req.maxTimeoutSeconds ?? 120)), nonce,
    };
    const signature = await account.signTypedData({
        domain: { name: req.extra?.name ?? "USD Coin", version: req.extra?.version ?? "2", chainId, verifyingContract: req.asset },
        types: { TransferWithAuthorization: [
            { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
            { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] },
        primaryType: "TransferWithAuthorization",
        message: { ...authorization, value: BigInt(authorization.value), validAfter: BigInt(authorization.validAfter), validBefore: BigInt(authorization.validBefore) },
    });
    return b64(JSON.stringify({ x402Version: 1, scheme: "exact", network: req.network, payload: { signature, authorization } }));
}

/** GET `url`, paying once if it answers 402. Returns { status, body, price, receipt }. */
export async function payAndFetch(url, { privateKey, account, maxPrice, fetchImpl = fetch } = {}) {
    const first = await fetchImpl(url);
    if (first.status !== 402) return { status: first.status, body: await first.text(), price: null, receipt: null };
    const offer = await first.json();
    const req = choose(offer.accepts, { maxPrice });
    if (!account) {
        if (!privateKey) throw new Error(`${url} costs ${req.maxAmountRequired} (base units of ${req.asset} on ${req.network}); no wallet configured to pay`);
        account = (await import("viem/accounts")).privateKeyToAccount(privateKey);
    }
    const paid = await fetchImpl(url, { headers: { "X-PAYMENT": await paymentHeader(req, account) } });
    const receiptHeader = paid.headers.get("X-PAYMENT-RESPONSE");
    const body = await paid.text();
    if (paid.status === 402) throw new Error(`payment refused: ${JSON.parse(body).error ?? body}`);
    return { status: paid.status, body, price: req.maxAmountRequired, receipt: receiptHeader ? JSON.parse(unb64(receiptHeader)) : null };
}

/** Buy one record an app sells (its agent card's `paid`) and check it against the sha256 the
 *  app published for it (`want`, the row's `paid_sha256`): what was paid for is what was
 *  committed. Shared by fangorn-mcp's `buy` and the stock page. */
export async function buyRecord(paid, key, { want, account, privateKey, maxPrice = paid.price, fetchImpl } = {}) {
    const r = await payAndFetch(paid.url.replace("{id}", encodeURIComponent(key)), { account, privateKey, maxPrice, fetchImpl });
    if (r.status !== 200) return { id: key, error: `HTTP ${r.status}: ${r.body.slice(0, 200)}` };
    const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(r.body)))]
        .map((b) => b.toString(16).padStart(2, "0")).join("");
    return { id: key, price: r.price, receipt: r.receipt, digest, verified: want ? want === digest : null, record: JSON.parse(r.body) };
}

// ── Batches and vouchers ──────────────────────────────────────────────────────────────────
// `POST <app>/paid {ids}` answers 402 with one price for every record it has; X-PAYMENT may then
// carry several payments (a JSON array) that add up to exactly that price. A payment signs
// payee, amount and expiry but not the resource (checked against the PayAI facilitator,
// 2026-10-07), so a person's wallet can sign a stack of them ahead of time ("vouchers") and an
// agent spends them later with no key: each pays only the app, for a fixed amount, until it
// expires. Holding them is holding the right to that much of the person's money, nothing more.

/** Sign vouchers worth `total` (base units) in `denominations` (ascending), payable to `req.payTo`
 *  for `days`. Enough of each small one to make any multiple of the smallest up to `total`. */
export async function signVouchers(req, account, { total, denominations, days = 30 } = {}) {
    const out = [], ds = denominations.map(BigInt);
    let left = BigInt(total);
    for (let i = 0; i < ds.length; i++) {
        let n = left / ds[i];
        if (i < ds.length - 1) {   // keep a full set of this size, the rest in multiples of the next
            const keep = ds[i + 1] / ds[i] - 1n;   // ponytail: assumes each denomination divides the next
            n = (left - (left - (keep < n ? keep : n) * ds[i]) / ds[i + 1] * ds[i + 1]) / ds[i];
        }
        for (let k = 0n; k < n; k++)
            out.push(JSON.parse(unb64(await paymentHeader({ ...req, maxAmountRequired: String(ds[i]), maxTimeoutSeconds: days * 86400 }, account))));
        left -= n * ds[i];
    }
    return out;
}

/** Vouchers adding up to exactly `amount`, largest first; null if they cannot. */
export function pick(vouchers, amount) {
    let left = BigInt(amount);
    const out = [];
    for (const v of [...vouchers].sort((a, b) => (BigInt(b.payload.authorization.value) > BigInt(a.payload.authorization.value) ? 1 : -1))) {
        const x = BigInt(v.payload.authorization.value);
        if (x <= left) { out.push(v); left -= x; }
    }
    return left === 0n ? out : null;   // ponytail: greedy; exact for denominations that divide each other
}

/** Buy many records at once. Pays from `vouchers` (spent ones are removed from the array) or
 *  signs one exact payment with `account`/`privateKey`. Each record is checked against
 *  `want[id]` (its published sha256). Returns the records and a manifest a third party can check. */
export async function buyBatch(paid, ids, { want = {}, vouchers, account, privateKey, maxPrice, fetchImpl = fetch } = {}) {
    const url = paid.url.replace(/\/\{id\}$/, "");
    const post = (headers = {}) => fetchImpl(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ ids }) });
    const first = await post();
    const offer = await first.json();
    if (first.status !== 402) throw new Error(`expected a price, got HTTP ${first.status}: ${JSON.stringify(offer).slice(0, 200)}`);
    const req = choose(offer.accepts, { maxPrice });
    let payments;
    if (vouchers) {
        payments = pick(vouchers, req.maxAmountRequired);
        if (!payments) throw new Error(`the allowance cannot pay exactly ${req.maxAmountRequired} (base units); add funds or buy fewer records`);
    } else {
        account ??= privateKey ? (await import("viem/accounts")).privateKeyToAccount(privateKey) : null;
        if (!account) throw new Error(`${offer.found.length} record(s) cost ${req.maxAmountRequired} (base units); no wallet or allowance to pay`);
        payments = [JSON.parse(unb64(await paymentHeader(req, account)))];
    }
    const res = await post({ "X-PAYMENT": b64(JSON.stringify(payments)) });
    const body = await res.json();
    if (res.status !== 200) throw new Error(`payment refused: ${body.error ?? JSON.stringify(body).slice(0, 200)}`);
    if (vouchers) for (const p of payments) vouchers.splice(vouchers.indexOf(p), 1);
    const records = [];
    for (const { id, body: text } of body.items) {
        const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))]
            .map((b) => b.toString(16).padStart(2, "0")).join("");
        records.push({ id, sha256: digest, verified: want[id] ? want[id] === digest : null, record: JSON.parse(text) });
    }
    return { records, missing: body.missing, manifest: { app: url, bought: new Date().toISOString(), price: req.maxAmountRequired,
        asset: req.asset, network: req.network, transactions: body.receipts.map((r) => r.transaction),
        records: records.map(({ id, sha256 }) => ({ id, sha256 })) } };
}

// ── self-check: `node src/agent/x402.js` — a stand-in seller that checks the signature ──
if (typeof process !== "undefined" && import.meta.url === `file://${process.argv[1]}` && process.argv[1].endsWith("/x402.js")) {
    const { privateKeyToAccount, generatePrivateKey } = await import("viem/accounts");
    const { verifyTypedData } = await import("viem");
    const buyer = privateKeyToAccount(generatePrivateKey());
    const USDC = "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d", SELLER = `0x${"5e".repeat(20)}`;
    const req = { scheme: "exact", network: "arbitrum-sepolia", maxAmountRequired: "10000", resource: "https://x/paid/1",
                  payTo: SELLER, asset: USDC, maxTimeoutSeconds: 120, extra: { name: "USD Coin", version: "2" } };
    let settled = null;
    const seller = async (url, init = {}) => {
        const h = init.headers?.["X-PAYMENT"];
        if (!h) return new Response(JSON.stringify({ x402Version: 1, accepts: [req] }), { status: 402 });
        const p = JSON.parse(unb64(h)).payload, a = p.authorization;
        const ok = await verifyTypedData({ address: a.from, signature: p.signature,
            domain: { name: "USD Coin", version: "2", chainId: 421614, verifyingContract: USDC },
            types: { TransferWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
                { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] },
            primaryType: "TransferWithAuthorization",
            message: { ...a, value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore) } });
        if (!ok || a.to !== SELLER || a.value !== "10000") return new Response(JSON.stringify({ error: "bad payment" }), { status: 402 });
        settled = a;
        return new Response('{"secret":42}', { status: 200, headers: { "X-PAYMENT-RESPONSE": b64(JSON.stringify({ success: true, transaction: "0xabc" })) } });
    };
    const r = await payAndFetch("https://x/paid/1", { account: buyer, maxPrice: 10000n, fetchImpl: seller });
    if (r.body !== '{"secret":42}' || r.receipt.transaction !== "0xabc" || settled.from !== buyer.address) throw new Error(`paid fetch: ${JSON.stringify(r)}`);
    let refused = false;
    try { await payAndFetch("https://x/paid/1", { account: buyer, maxPrice: 9999n, fetchImpl: seller }); } catch (e) { refused = /exceeds the cap/.test(e.message); }
    if (!refused) throw new Error("a price over the cap must be refused before signing");

    // Batches through the real worker (CONFIG filled in as ship does), a stand-in facilitator
    // that checks signatures and refuses a nonce settled twice, and vouchers signed ahead.
    const { readFileSync, writeFileSync, mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const sale = { price: "100000", network: "arbitrum-sepolia", asset: USDC, payTo: SELLER, facilitator: "https://fac", name: "USD Coin", version: "2", description: "" };
    const src = readFileSync(new URL("../../site/worker.js", import.meta.url), "utf8").replace(/\/\*CONFIG\*\/[\s\S]*?\/\*END\*\//, JSON.stringify({ docHosts: [], paid: sale }));
    const wfile = `${mkdtempSync(`${tmpdir()}/wm-`)}/worker.mjs`;
    writeFileSync(wfile, src);
    const worker = (await import(wfile)).default;
    const hex = async (s) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");
    const files = {};
    for (const id of ["a", "b", "c"]) files[`/_paid/${(await hex(id)).slice(0, 32)}.json`] = JSON.stringify({ id, amount: 1 });
    const env = { ASSETS: { fetch: async (u) => files[new URL(u).pathname] ? new Response(files[new URL(u).pathname], { headers: { "content-type": "application/json" } }) : new Response("<html>", { headers: { "content-type": "text/html" } }) } };
    const spent = new Set();
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (u, init) => {
        const { paymentPayload: p, paymentRequirements: q } = JSON.parse(init.body), a = p.payload.authorization;
        if (u.endsWith("/verify")) {
            const ok = await verifyTypedData({ address: a.from, signature: p.payload.signature,
                domain: { name: "USD Coin", version: "2", chainId: 421614, verifyingContract: USDC },
                types: { TransferWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
                    { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] },
                primaryType: "TransferWithAuthorization",
                message: { ...a, value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore) } });
            return new Response(JSON.stringify({ isValid: ok && a.value === q.maxAmountRequired, invalidReason: "bad" }));
        }
        if (spent.has(a.nonce)) return new Response(JSON.stringify({ success: false, errorReason: "nonce used" }));
        spent.add(a.nonce);
        return new Response(JSON.stringify({ success: true, transaction: `0x${spent.size}` }));
    };
    const viaWorker = (u, init) => worker.fetch(new Request(u, init), env);
    const paidCard = { url: "https://x/paid/{id}", price: sale.price };
    try {
        // One exact payment from a wallet: 2 of 3 ids exist, 2 × $0.10, the missing one not charged.
        const one = await buyBatch(paidCard, ["a", "b", "zz"], { account: buyer, maxPrice: 200000n, want: { a: await hex(files[Object.keys(files)[0]]) }, fetchImpl: viaWorker });
        if (one.records.length !== 2 || one.missing[0] !== "zz" || one.manifest.price !== "200000" || one.records[0].verified !== true)
            throw new Error(`batch with a wallet: ${JSON.stringify(one)}`);
        // $2 of vouchers in $0.10 / $1, 30 days: any multiple of $0.10 can be paid exactly.
        const vs = await signVouchers({ ...paidCard, scheme: "exact", network: sale.network, payTo: SELLER, asset: USDC, extra: { name: "USD Coin", version: "2" } },
            buyer, { total: 2000000n, denominations: [100000n, 1000000n] });
        if (vs.length !== 11 || pick(vs, 1700000n).length !== 8 || pick(vs, 2100000n) !== null) throw new Error(`vouchers: ${vs.length}`);
        const before = [...vs];
        const three = await buyBatch(paidCard, ["a", "b", "c"], { vouchers: vs, fetchImpl: viaWorker });
        if (three.records.length !== 3 || vs.length !== 8 || three.manifest.transactions.length !== 3) throw new Error(`batch with vouchers: ${JSON.stringify(three.manifest)}`);
        // A spent $0.10 voucher riding along with a fresh one: both verify, settle refuses, nothing sent.
        const usedOne = before.find((v) => !vs.includes(v) && v.payload.authorization.value === "100000");
        const fresh = vs.find((v) => v.payload.authorization.value === "100000");
        const replay = await viaWorker("https://x/paid", { method: "POST", body: JSON.stringify({ ids: ["a", "b"] }), headers: { "X-PAYMENT": b64(JSON.stringify([usedOne, fresh])) } });
        if (replay.status !== 402 || (await replay.json()).items) throw new Error("a spent voucher must not buy anything");
        const short = await viaWorker("https://x/paid", { method: "POST", body: JSON.stringify({ ids: ["a", "b"] }), headers: { "X-PAYMENT": b64(JSON.stringify([fresh])) } });
        if (short.status !== 402) throw new Error("payments short of the price must be refused");
    } finally { globalThis.fetch = realFetch; }
    console.log("x402.js batch self-check ok — one price for the ids that exist, paid by one signature or by vouchers signed ahead, spent vouchers removed and refused if replayed, short payment refused");
    console.log("x402.js self-check ok — a signed EIP-3009 authorization the seller can verify, exactly the asked amount to the asked payee, the receipt read back, and a price over the cap refused before signing");
}
