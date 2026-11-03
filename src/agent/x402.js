// Buying a record over x402 (v2, scheme "fangorn"): the buyer's half.
//
//   const { fields, price, tx } = await buyRecord(quoteUrl, { privateKey, fangorn, maxPrice: 50000n });
//
// `quoteUrl` is an app's GET /paid/<publisher>/<repo>/<id> (site/worker.js). The publisher signed
// the record's price (its terms); paying is SettlementRegistry.register, sent by the facilitator.
//   1. GET → 402: the requirement (the terms, paid to the registry in USDC), the sealed fields'
//      handles, the repo's deposit, and the relay
//   2. a Semaphore identity from one wallet signature, and an ERC-3009 receiveWithAuthorization to
//      the registry for exactly the price. Its nonce binds the subject, the identity's commitment,
//      the referrer and a salt, so nobody can reuse it for anything else.
//   3. GET again with PAYMENT-SIGNATURE: the app has the facilitator verify it and send `register`
//   4. a Semaphore proof that some identity that paid names `reader` (message = reader, scope =
//      subject), sent to the relay's /relay/settle. `reader` is derived from the identity, so the
//      chain doesn't link it to the paying wallet (the relay could, by timing: PLAN.md, Known gaps).
//   5. each field's key from the deposit's key server, asked as `reader`; each field decrypted (JSON)
// A retry picks up where the last one stopped: a registered identity doesn't pay again, and a
// reader that can already read doesn't settle again.
//
// `maxPrice` (USDC base units) is checked before anything is signed.

import { concat, createPublicClient, http, keccak256, parseAbiItem, parseSignature, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { openField, recordKey, registerNonce, repoId, subjectOf } from "@fangorn-network/sdk";

const b64 = (s) => (typeof btoa === "function" ? btoa(s) : Buffer.from(s, "utf8").toString("base64"));
const unb64 = (s) => (typeof atob === "function" ? atob(s) : Buffer.from(s, "base64").toString("utf8"));
const semaphore = () => import("@semaphore-protocol/core").catch(() => {
    throw new Error("buying needs @semaphore-protocol/core: npm i @semaphore-protocol/core");
});

/** A 402's PaymentRequired, from its PAYMENT-REQUIRED header. */
export function paymentRequired(res) {
    const h = res.headers.get("PAYMENT-REQUIRED");
    if (!h) throw new Error(`HTTP ${res.status} has no PAYMENT-REQUIRED header (not x402 v2)`);
    return JSON.parse(unb64(h));
}

/** The requirement we can pay: scheme "fangorn" on an EVM chain, within `maxPrice`. */
export function choose(accepts = [], { maxPrice } = {}) {
    const r = accepts.find((a) => a.scheme === "fangorn" && /^eip155:\d+$/.test(a.network));
    if (!r) throw new Error(`no payable option: ${JSON.stringify(accepts.map((a) => `${a.scheme}/${a.network}`))}`);
    if (maxPrice != null && BigInt(r.amount) > BigInt(maxPrice)) throw new Error(`price ${r.amount} exceeds the cap ${maxPrice} (USDC base units)`);
    return r;
}

/** The Semaphore identity and reading account a wallet derives: the same on any machine, from one signature. */
export async function identityOf(account) {
    const sig = await account.signMessage({ message: "fangorn:identity:v1" });
    const { Identity } = await semaphore();
    return { identity: new Identity(sig), reader: privateKeyToAccount(keccak256(concat([toHex("fangorn:reader:v1"), sig]))) };
}

/** An ERC-3009 receiveWithAuthorization from `account` to `req.payTo` for exactly `req.amount`, bound to this purchase. */
export async function signPayment(req, account, { subject, commitment, salt, now = Math.floor(Date.now() / 1000) }) {
    const message = { from: account.address, to: req.payTo, value: BigInt(req.amount), validAfter: 0n,
                      validBefore: BigInt(now + (req.maxTimeoutSeconds ?? 300)), nonce: registerNonce(subject, commitment, req.extra.referrer, salt) };
    const signature = await account.signTypedData({
        domain: { name: req.extra.name, version: req.extra.version, chainId: Number(req.network.split(":")[1]), verifyingContract: req.asset },
        types: { ReceiveWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
            { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] },
        primaryType: "ReceiveWithAuthorization", message,
    });
    const { v, r, s, yParity } = parseSignature(signature);
    return { from: message.from, value: req.amount, validAfter: "0", validBefore: String(message.validBefore), nonce: message.nonce,
             v: Number(v ?? 27n + BigInt(yParity)), r, s };
}

const REGISTERED = parseAbiItem("event Registered(bytes32 indexed subject, address indexed publisher, address indexed referrer, uint256 commitment, uint256 price, uint256 referrer_cut)");

/** Every commitment registered for `subject`, in the order the contract added them to its group. */
async function membersOf(pub, registry, subject, { fromBlock, window = 1000n }) {
    const head = await pub.getBlockNumber(), out = [];
    for (let from = BigInt(fromBlock); from <= head; from += window) {
        const to = from + window - 1n < head ? from + window - 1n : head;
        out.push(...await pub.getLogs({ address: registry, event: REGISTERED, args: { subject }, fromBlock: from, toBlock: to }));
    }
    return out.map((l) => l.args.commitment);
}

/** A Semaphore proof that `identity` is in the group, naming `reader`, scoped to `subject`, as `settle` checks it. */
async function prove({ identity, members, reader, subject }) {
    const { Group, generateProof } = await semaphore();
    const p = await generateProof(identity, new Group(members), BigInt(reader), BigInt(subject));
    return { merkleTreeDepth: String(p.merkleTreeDepth), merkleTreeRoot: String(p.merkleTreeRoot), nullifier: String(p.nullifier), points: p.points.map(String) };
}

/**
 * Buy one record and open its sealed fields. `fangorn` is an SDK client on the record's chain:
 * it reads the registry and the ciphertext. `deps` replaces the chain reads and the proof in tests.
 */
export async function buyRecord(quoteUrl, { privateKey, account = privateKeyToAccount(privateKey), fangorn, maxPrice, fetchImpl = fetch, deps = {} } = {}) {
    const first = await fetchImpl(quoteUrl);
    if (first.status !== 402) throw new Error(`${quoteUrl}: expected a 402 quote, got HTTP ${first.status} ${(await first.text()).slice(0, 200)}`);
    const req = choose(paymentRequired(first).accepts, { maxPrice });
    const { record, fields, deposit, relay } = await first.json();
    const terms = req.extra.terms;
    // The quote is the app's word; the terms are the publisher's, and must be this record's.
    if (terms.publisher.toLowerCase() !== record.publisher.toLowerCase() || terms.repo !== repoId(record.repo) || terms.key !== recordKey(record.id))
        throw new Error("the quote's terms are for another record");
    const subject = subjectOf(terms.publisher, terms.repo, terms.key);

    const config = fangorn.getConfig(), settlement = fangorn.getSettlementRegistry();
    const pub = deps.pub ?? createPublicClient({ transport: http(config.rpcUrl) });
    const members = deps.members ?? ((s) => membersOf(pub, settlement.getAddress(), s, { fromBlock: config.fromBlock, window: config.logWindow ?? 1000n }));
    const { identity, reader } = await identityOf(account);

    let tx = null;
    if (!(await settlement.canRead(reader.address, terms.publisher, terms.repo, terms.key))) {
        if (!(await settlement.isRegistered(subject, identity.commitment))) {
            const salt = toHex(crypto.getRandomValues(new Uint8Array(32)));
            const payment = await signPayment(req, account, { subject, commitment: identity.commitment, salt });
            const payload = { commitment: identity.commitment.toString(), salt, payment };
            const paid = await fetchImpl(quoteUrl, { headers: { "PAYMENT-SIGNATURE": b64(JSON.stringify({ x402Version: 2, accepted: req, payload })) } });
            if (!paid.ok) throw new Error(`payment refused: ${(await paid.json().catch(() => ({}))).error ?? `HTTP ${paid.status}`}`);
            tx = JSON.parse(unb64(paid.headers.get("PAYMENT-RESPONSE") ?? b64("{}"))).transaction || null;
            if (tx) await pub.waitForTransactionReceipt({ hash: tx });
        }
        // A load-balanced RPC can answer getLogs from a node behind the one that mined `register`:
        // our commitment is registered, so read until it shows up.
        const has = (g) => !!deps.members || g.some((c) => BigInt(c) === identity.commitment);
        let group = await members(subject);
        for (let i = 0; i < 10 && !has(group); i++) {
            await new Promise((r) => setTimeout(r, 3000));
            group = await members(subject);
        }
        if (!has(group)) throw new Error("our commitment is registered but the RPC's logs don't show it yet; retry the purchase");
        const proof = await (deps.prove ?? prove)({ identity, members: group, reader: reader.address, subject });
        const res = await fetchImpl(`${relay}/relay/settle`, { method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ subject, reader: reader.address, ...proof }) });
        const out = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(`settle refused: ${out.error ?? `HTTP ${res.status}`}`);
        await pub.waitForTransactionReceipt({ hash: out.tx });
    }

    const opened = {};
    for (const [field, handle] of Object.entries(fields)) {
        const bytes = await openField({ handle, deposit, key: terms.key, field, signer: reader, storage: fangorn.getStorage(), fetch: fetchImpl });
        opened[field] = JSON.parse(new TextDecoder().decode(bytes));
    }
    return { record, fields: opened, price: req.amount, tx };
}

// ── self-check: `node src/agent/x402.js` — a stand-in app, relay and key server; no chain ──
if (typeof process !== "undefined" && import.meta.url === `file://${process.argv[1]}` && process.argv[1].endsWith("/x402.js")) {
    const { x25519 } = await import("@noble/curves/ed25519");
    const { generatePrivateKey } = await import("viem/accounts");
    const { recoverTypedDataAddress } = await import("viem");
    const sdk = await import("@fangorn-network/sdk");
    const { testKeyServer } = await import("@fangorn-network/sdk/lib/test/key-server.js");
    const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); };

    const publisher = privateKeyToAccount(generatePrivateKey()), buyer = privateKeyToAccount(generatePrivateKey());
    const REGISTRY = `0x${"e0".repeat(20)}`, USDC = `0x${"aa".repeat(20)}`, REFERRER = `0x${"fe".repeat(20)}`;
    const repo = sdk.repoId("notes"), key = sdk.recordKey("a");
    const scope = { chainId: 84532, registry: REGISTRY, publisher: publisher.address, repo, generation: 0n };
    const ksSecret = x25519.utils.randomSecretKey(), kRepo = sdk.newRepoKey();
    const deposit = sdk.makeDeposit({ kRepo, keyServerPubkey: x25519.getPublicKey(ksSecret), keyServer: "https://keys.test", scope });
    const files = new Map();
    const storage = { putFile: async (b) => { const cid = `bafy${files.size}`; files.set(cid, b); return cid; }, getFile: async (cid) => files.get(cid) };
    const body = await sdk.sealField({ plaintext: new TextEncoder().encode(JSON.stringify({ text: "the body" })), kRepo, scope, key, field: "body", storage });
    const terms = { publisher: publisher.address, repo, key, price: "10000", shareBps: 500, generation: "0", deadline: "2000000000" };
    const req = { scheme: "fangorn", network: "eip155:84532", amount: "10000", asset: USDC, payTo: REGISTRY, maxTimeoutSeconds: 300,
                  extra: { terms, signature: "0x12", referrer: REFERRER, name: "USDC", version: "2" } };

    // The chain as the buyer sees it: settled once the relay has the proof.
    let settled = false, registered = false, signed = null, proven = null;
    const fangorn = { getConfig: () => ({ rpcUrl: "http://unused", fromBlock: 0n }), getStorage: () => storage,
        getSettlementRegistry: () => ({ getAddress: () => REGISTRY, canRead: async () => settled, isRegistered: async () => registered }) };
    const pub = { waitForTransactionReceipt: async () => ({}) };
    const quoteUrl = `https://app.test/paid/${publisher.address}/notes/a`;
    const fetchImpl = async (url, init = {}) => {
        if (url === quoteUrl) {
            const pay = init.headers?.["PAYMENT-SIGNATURE"];
            if (!pay) return new Response(JSON.stringify({ record: { publisher: publisher.address, repo: "notes", id: "a" }, fields: { body }, deposit, relay: "https://relay.test" }),
                { status: 402, headers: { "PAYMENT-REQUIRED": b64(JSON.stringify({ x402Version: 2, accepts: [req] })) } });
            signed = JSON.parse(unb64(pay)).payload;
            registered = true;
            return new Response("{}", { headers: { "PAYMENT-RESPONSE": b64(JSON.stringify({ success: true, transaction: "0xabc" })) } });
        }
        if (url === "https://relay.test/relay/settle") { proven = JSON.parse(init.body); settled = true; return new Response(JSON.stringify({ tx: "0xdef" })); }
        if (url === "https://keys.test/access") return testKeyServer(JSON.parse(init.body), { secret: ksSecret, chainId: 84532, registry: REGISTRY,
            canRead: async (r) => settled && r === proven.reader });
        throw new Error(`unexpected fetch ${url}`);
    };
    const deps = { pub, members: async () => [1n], prove: async ({ reader, subject }) => ({ merkleTreeDepth: "1", merkleTreeRoot: "1", nullifier: "1", points: Array(8).fill("0"), reader, subject }) };

    await buyRecord(quoteUrl, { account: buyer, fangorn, fetchImpl, deps, maxPrice: 9999n }).then(() => { throw new Error("over the cap must refuse"); },
        (e) => { if (!/exceeds the cap/.test(e.message)) throw e; });
    eq(signed, null, "nothing is signed over the cap");

    const got = await buyRecord(quoteUrl, { account: buyer, fangorn, fetchImpl, deps, maxPrice: 10000n });
    eq([got.fields, got.price, got.tx], [{ body: { text: "the body" } }, "10000", "0xabc"], "paid, settled, and the field opens as JSON");
    const { identity, reader } = await identityOf(buyer);
    eq([signed.commitment, proven.reader, proven.subject], [identity.commitment.toString(), reader.address, subjectOf(publisher.address, repo, key)], "the payment carries the identity; the proof names the reader");
    if (reader.address === buyer.address) throw new Error("the reader must not be the paying wallet");
    const p = signed.payment;
    const from = await recoverTypedDataAddress({ domain: { name: "USDC", version: "2", chainId: 84532, verifyingContract: USDC },
        types: { ReceiveWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
            { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] },
        primaryType: "ReceiveWithAuthorization", message: { from: p.from, to: p.payTo ?? REGISTRY, value: BigInt(p.value), validAfter: 0n, validBefore: BigInt(p.validBefore), nonce: p.nonce },
        signature: concat([p.r, p.s, toHex(p.v, { size: 1 })]) });
    eq([from, p.value, p.nonce], [buyer.address, "10000", registerNonce(subjectOf(publisher.address, repo, key), identity.commitment, REFERRER, signed.salt)],
        "an ERC-3009 authorization from the buyer for exactly the price, its nonce bound to this purchase and referrer");

    signed = null;
    const again = await buyRecord(quoteUrl, { account: buyer, fangorn, fetchImpl, deps });
    eq([again.fields.body.text, signed, again.tx], ["the body", null, null], "a reader that can already read pays nothing again");

    const other = { ...req, extra: { ...req.extra, terms: { ...terms, key: sdk.recordKey("b") } } };
    const lying = async (url, init) => url === quoteUrl && !init?.headers ? new Response(JSON.stringify({ record: { publisher: publisher.address, repo: "notes", id: "a" }, fields: { body }, deposit, relay: "https://relay.test" }),
        { status: 402, headers: { "PAYMENT-REQUIRED": b64(JSON.stringify({ x402Version: 2, accepts: [other] })) } }) : fetchImpl(url, init);
    await buyRecord(quoteUrl, { account: privateKeyToAccount(generatePrivateKey()), fangorn, fetchImpl: lying, deps }).then(() => { throw new Error("must refuse"); },
        (e) => { if (!/another record/.test(e.message)) throw e; });
    console.log("x402.js self-check ok — the cap holds before signing, the payment is an ERC-3009 authorization bound to this purchase, the proof names a reader that isn't the wallet, a retry pays nothing, a quote for another record is refused, and the field opens");
}
