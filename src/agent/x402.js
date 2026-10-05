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
    console.log("x402.js self-check ok — a signed EIP-3009 authorization the seller can verify, exactly the asked amount to the asked payee, the receipt read back, and a price over the cap refused before signing");
}
