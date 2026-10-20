// Paying for a resource over x402 (v2, "exact" scheme on an EVM chain): the buyer's half.
//
//   const { body, receipt, price } = await payAndFetch(url, { privateKey, maxPrice: 50000n });
//
// 1. GET url → 402 with its PaymentRequired in the PAYMENT-REQUIRED header (base64 JSON):
//    `accepts` says what it costs, in which token, on which chain ("eip155:84532"), to whom.
// 2. Sign an EIP-3009 transferWithAuthorization for exactly that (EIP-712, the token's own
//    domain, named in `extra`). Nothing is sent on chain by the buyer: the seller's facilitator
//    submits it.
// 3. GET url again with PAYMENT-SIGNATURE: the seller verifies, settles, and returns the
//    resource, with the settlement (the tx hash) in PAYMENT-RESPONSE.
//
// `maxPrice` (token base units) is checked BEFORE signing: a seller cannot ask for more
// than the caller agreed to, whatever its 402 says.

const b64 = (s) => (typeof btoa === "function" ? btoa(s) : Buffer.from(s, "utf8").toString("base64"));
const unb64 = (s) => (typeof atob === "function" ? atob(s) : Buffer.from(s, "base64").toString("utf8"));
const EVM = /^eip155:(\d+)$/;

/** The one requirement we can pay: exact scheme, an EVM chain, within `maxPrice`. */
export function choose(accepts = [], { maxPrice } = {}) {
    const ok = accepts.filter((a) => a.scheme === "exact" && EVM.test(a.network));
    if (!ok.length) throw new Error(`no payable option: ${JSON.stringify(accepts.map((a) => `${a.scheme}/${a.network}`))}`);
    const cheapest = ok.sort((a, b) => (BigInt(a.amount) < BigInt(b.amount) ? -1 : 1))[0];
    if (maxPrice != null && BigInt(cheapest.amount) > BigInt(maxPrice))
        throw new Error(`price ${cheapest.amount} exceeds the cap ${maxPrice} (token base units)`);
    return cheapest;
}

/** A 402's PaymentRequired, from its PAYMENT-REQUIRED header. */
export function paymentRequired(res) {
    const h = res.headers.get("PAYMENT-REQUIRED");
    if (!h) throw new Error(`HTTP ${res.status} has no PAYMENT-REQUIRED header (not x402 v2)`);
    return JSON.parse(unb64(h));
}

/** The PAYMENT-SIGNATURE header value for requirement `req`, signed by `account` (a viem account). */
export async function paymentHeader(req, account, opts) {
    return b64(JSON.stringify(await signPayment(req, account, opts)));
}

/** A PaymentPayload for `req` (one of a 402's `accepts`), for the 402's `resource`. */
export async function signPayment(req, account, { resource, now = Math.floor(Date.now() / 1000) } = {}) {
    const chainId = Number((EVM.exec(req.network) ?? [])[1]);
    if (!chainId) throw new Error(`not an EVM network: ${req.network}`);
    const nonce = `0x${[...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
    const authorization = {
        from: account.address, to: req.payTo, value: String(req.amount),
        validAfter: String(now - 600), validBefore: String(now + (req.maxTimeoutSeconds ?? 120)), nonce,
    };
    // The token's EIP-712 name differs by chain (Base Sepolia's USDC is "USDC", Base's "USD
    // Coin"), so a seller that names none is refused rather than guessed at.
    if (!req.extra?.name || !req.extra?.version) throw new Error(`${req.network}: the seller names no EIP-712 domain for ${req.asset} (extra.name, extra.version)`);
    const signature = await account.signTypedData({
        domain: { name: req.extra.name, version: req.extra.version, chainId, verifyingContract: req.asset },
        types: { TransferWithAuthorization: [
            { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
            { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] },
        primaryType: "TransferWithAuthorization",
        message: { ...authorization, value: BigInt(authorization.value), validAfter: BigInt(authorization.validAfter), validBefore: BigInt(authorization.validBefore) },
    });
    return { x402Version: 2, ...(resource ? { resource } : {}), accepted: req, payload: { signature, authorization } };
}

/** GET `url` (or `method` it), paying once if it answers 402. Returns { status, body, price, receipt }. */
export async function payAndFetch(url, { privateKey, account, maxPrice, fetchImpl = fetch, method = "GET" } = {}) {
    const first = await fetchImpl(url, { method });
    if (first.status !== 402) return { status: first.status, body: await first.text(), price: null, receipt: null };
    const offer = paymentRequired(first);
    const req = choose(offer.accepts, { maxPrice });
    if (!account) {
        if (!privateKey) throw new Error(`${url} costs ${req.amount} (base units of ${req.asset} on ${req.network}); no wallet configured to pay`);
        account = (await import("viem/accounts")).privateKeyToAccount(privateKey);
    }
    const paid = await fetchImpl(url, { method, headers: { "PAYMENT-SIGNATURE": await paymentHeader(req, account, { resource: offer.resource }) } });
    const receiptHeader = paid.headers.get("PAYMENT-RESPONSE");
    const body = await paid.text();
    if (paid.status === 402) throw new Error(`payment refused: ${paymentRequired(paid).error ?? body}`);
    return { status: paid.status, body, price: req.amount, receipt: receiptHeader ? JSON.parse(unb64(receiptHeader)) : null };
}

// ── Sealed records ────────────────────────────────────────────────────────────────────────
// An app's paid record is in its committed rows already, sealed: `paid_ct` is
// base64(nonce[12] ‖ AES-256-GCM(key, record)), with key = HMAC-SHA256(PAID_SECRET, id), and
// `paid_sha256` is the sha256 of the record itself. A purchase buys the key, never the data,
// so the buyer has the ciphertext (and so knows the record exists) before paying, and checks
// what it decrypts against the committed hash after. Sources seal with the same derivation.

const hex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, "0")).join("");
const unhex = (h) => Uint8Array.from(h.match(/../g).map((x) => parseInt(x, 16)));
const fromB64 = (s) => Uint8Array.from(unb64bytes(s));
function unb64bytes(s) { return typeof atob === "function" ? [...atob(s)].map((c) => c.charCodeAt(0)) : [...Buffer.from(s, "base64")]; }
const toB64 = (u8) => (typeof btoa === "function" ? btoa(String.fromCharCode(...u8)) : Buffer.from(u8).toString("base64"));
const sha256 = async (bytes) => hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));

/** A record's key, hex: HMAC-SHA256(secret, id). The worker's keyFor; here for sources and tests. */
export async function paidKey(secret, id) {
    const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return hex(new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(id))));
}

/** Seal `text` under `keyHex`: what a source writes as `paid_ct`. */
export async function sealPaid(keyHex, text, nonce = crypto.getRandomValues(new Uint8Array(12))) {
    const k = await crypto.subtle.importKey("raw", unhex(keyHex), "AES-GCM", false, ["encrypt"]);
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, k, new TextEncoder().encode(text)));
    const out = new Uint8Array(12 + ct.length);
    out.set(nonce); out.set(ct, 12);
    return toB64(out);
}

/** Open a sealed record and check it against the committed sha256 (`want`, if known). */
export async function openPaid(ct, keyHex, want) {
    const bytes = fromB64(ct);
    const k = await crypto.subtle.importKey("raw", unhex(keyHex), "AES-GCM", false, ["decrypt"]);
    const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12) }, k, bytes.slice(12)));
    const sha = await sha256(plain);
    return { sha256: sha, verified: want ? want === sha : null, record: JSON.parse(new TextDecoder().decode(plain)) };
}

/** A private app's pass (its card's `access`): one payment at POST `pass_url`, a bearer token back. */
export async function buyPass(access, { account, privateKey, maxPrice = access.pass, fetchImpl } = {}) {
    const r = await payAndFetch(access.pass_url, { method: "POST", account, privateKey, maxPrice, fetchImpl });
    if (r.status !== 200) throw new Error(`no pass: HTTP ${r.status} ${r.body.slice(0, 200)}`);
    return { ...JSON.parse(r.body), price: r.price, receipt: r.receipt };
}

// ── Private apps ──────────────────────────────────────────────────────────────────────────
// A private app's rows are sealed whole before they reach IPFS: the payload on chain is
// `{sealed}`, base64(nonce[12] ‖ AES-256-GCM(rowKey, JSON(payload))), with rowKey =
// HMAC-SHA256(PAID_SECRET, "fangorn.row.v1"). The app's Worker holds the secret, opens the rows
// in its cron and serves the view only to those who pay. The nonce is the first 12 bytes of
// HMAC(rowKey, plaintext): an unchanged row seals to the same bytes, so the same CID, and is not
// embedded again; two different rows never share a nonce. (Equal rows look equal: that is all.)

const ROW = "fangorn.row.v1";
async function rowNonce(keyHex, text) {
    const k = await crypto.subtle.importKey("raw", unhex(keyHex), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(text))).slice(0, 12);
}

/** The payload a private app commits for `payload`. */
export async function sealRow(secret, payload) {
    const key = await paidKey(secret, ROW), text = JSON.stringify(payload);
    return { sealed: await sealPaid(key, text, await rowNonce(key, text)) };
}

/** A row as committed, opened; a payload that is not sealed comes back as it is. */
export async function openRow(secret, payload) {
    if (typeof payload?.sealed !== "string") return payload;
    return (await openPaid(payload.sealed, await paidKey(secret, ROW))).record;
}

/** Open every record a seller sent a key for. `ct[id]` is the row's paid_ct, `want[id]` its paid_sha256. */
async function openAll(keys, ct, want) {
    const out = [];
    for (const [id, key] of Object.entries(keys ?? {})) {
        if (!ct[id]) { out.push({ id, key, error: "no sealed record for this id in the rows read" }); continue; }
        try { out.push({ id, ...(await openPaid(ct[id], key, want[id])) }); }
        catch (e) { out.push({ id, key, error: `could not open: ${e.message}` }); }
    }
    return out;
}

/** Buy one record an app sells (its agent card's `paid`): pay for its key, open `ct` (the
 *  row's paid_ct) and check it against `want` (its paid_sha256). Shared by fangorn-mcp and the page. */
export async function buyRecord(paid, key, { ct, want, account, privateKey, maxPrice = paid.price, fetchImpl } = {}) {
    if (!ct) return { id: key, error: "this row carries no sealed record (paid_ct): nothing to buy" };
    const r = await payAndFetch(paid.url.replace("{id}", encodeURIComponent(key)), { account, privateKey, maxPrice, fetchImpl });
    if (r.status !== 200) return { id: key, error: `HTTP ${r.status}: ${r.body.slice(0, 200)}` };
    const opened = await openPaid(ct, JSON.parse(r.body).key, want);
    return { id: key, price: r.price, receipt: r.receipt, digest: opened.sha256, verified: opened.verified, record: opened.record };
}

/** The typed data a reader signs to read with a membership: a copy of @fangorn-network/barliman's
 *  src/read.js, which its /check verifies. ponytail: import it once barliman is on npm. */
export const readTypedData = ({ registry, chainId, appId, tokenId, ids, issuedAt }) => ({
    domain: { name: "Fangorn Read", version: "1", chainId: Number(chainId), verifyingContract: registry },
    types: { Read: [{ name: "app", type: "bytes32" }, { name: "tokenId", type: "uint256" }, { name: "ids", type: "string[]" }, { name: "issuedAt", type: "uint256" }] },
    primaryType: "Read",
    message: { app: appId, tokenId: BigInt(tokenId), ids, issuedAt: BigInt(issuedAt) },
});

/** Read records with a membership: `reader` (the holder, or the agent it named) signs the
 *  request, the app's worker has Barliman check it, and the keys come back. Nothing is paid. */
export async function readAsMember(paid, ids, { reader, tokenId, ct = {}, want = {}, fetchImpl = fetch } = {}) {
    const m = paid.membership;
    if (!m) throw new Error("this app sells no memberships");
    const issuedAt = Math.floor(Date.now() / 1000);
    const signature = await reader.signTypedData(readTypedData({ registry: m.registry, chainId: m.chainId, appId: m.appId, tokenId, ids, issuedAt }));
    const url = paid.key_url ?? paid.url.replace(/\/paid\/\{id\}$/, "/key");
    const res = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids, tokenId: String(tokenId), issuedAt, signature }) });
    const body = await res.json();
    if (res.status !== 200) throw new Error(`membership refused: ${body.error ?? res.status}`);
    return { records: await openAll(body.keys, ct, want), until: body.until };
}

// ── Batches and vouchers ──────────────────────────────────────────────────────────────────
// `POST <app>/paid {ids}` answers 402 with one price for every record it has; PAYMENT-SIGNATURE may then
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
            out.push(await signPayment({ ...req, amount: String(ds[i]), maxTimeoutSeconds: days * 86400 }, account));
        left -= n * ds[i];
    }
    return out;
}

/** Vouchers adding up to exactly `amount`, largest first; null if they cannot. */
export function pick(vouchers, amount) {
    let left = BigInt(amount);
    const out = [];
    for (const v of [...vouchers].sort((a, b) => { const x = BigInt(a.payload.authorization.value), y = BigInt(b.payload.authorization.value); return x > y ? -1 : x < y ? 1 : 0; })) {   // largest first; equal ones keep their order
        const x = BigInt(v.payload.authorization.value);
        if (x <= left) { out.push(v); left -= x; }
    }
    return left === 0n ? out : null;   // ponytail: greedy; exact for denominations that divide each other
}

/** Run `fn` holding `<path>.lock` (Node only): two fangorn-mcp processes sharing one allowance
 *  file would otherwise pick the same vouchers and race. A lock older than `staleMs` belongs to
 *  a crashed purchase and is taken over.
 *  ponytail: a takeover can race a third process for the same stale lock; add a pid check if
 *  more than two servers ever share a file. */
export async function withLock(path, fn, { staleMs = 120_000, waitMs = 30_000 } = {}) {
    const fs = await import("node:fs"), lock = `${path}.lock`, start = Date.now();
    for (;;) {
        try { fs.closeSync(fs.openSync(lock, "wx")); break; } catch (e) {
            if (e.code !== "EEXIST") throw e;
            let age = 0;
            try { age = Date.now() - fs.statSync(lock).mtimeMs; } catch { continue; }   // released meanwhile
            if (age > staleMs) { fs.rmSync(lock, { force: true }); continue; }
            if (Date.now() - start > waitMs) throw new Error(`the allowance is in use by another purchase (${lock})`);
            await new Promise((ok) => setTimeout(ok, 100));
        }
    }
    try { return await fn(); } finally { fs.rmSync(lock, { force: true }); }
}

/** Buy many records at once. Pays from `vouchers` (spent ones are removed from the array) or
 *  signs one exact payment with `account`/`privateKey`. Each key opens `ct[id]` (the row's
 *  paid_ct), checked against `want[id]` (its paid_sha256). Returns the records and a manifest a
 *  third party can check. */
export async function buyBatch(paid, allIds, { ct = {}, want = {}, vouchers, account, privateKey, maxPrice, fetchImpl = fetch } = {}) {
    const url = paid.url.replace(/\/\{id\}$/, "");
    // Only ids whose sealed record is in hand are bought: anything else would pay for nothing.
    const ids = allIds.filter((id) => ct[id]), unsealed = allIds.filter((id) => !ct[id]);
    if (!ids.length) throw new Error(`none of these rows carries a sealed record (paid_ct): ${unsealed.join(", ")}`);
    const post = (headers = {}) => fetchImpl(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ ids }) });
    const first = await post();
    const body0 = await first.json();
    if (first.status !== 402) throw new Error(`expected a price, got HTTP ${first.status}: ${JSON.stringify(body0).slice(0, 200)}`);
    const offer = { ...body0, ...paymentRequired(first) };
    const req = choose(offer.accepts, { maxPrice });
    let payments;
    if (vouchers) {
        payments = pick(vouchers, req.amount);
        if (!payments) throw new Error(`the allowance cannot pay exactly ${req.amount} (base units); add funds or buy fewer records`);
    } else {
        account ??= privateKey ? (await import("viem/accounts")).privateKeyToAccount(privateKey) : null;
        if (!account) throw new Error(`${offer.found.length} record(s) cost ${req.amount} (base units); no wallet or allowance to pay`);
        payments = [await signPayment(req, account, { resource: offer.resource })];
    }
    const res = await post({ "PAYMENT-SIGNATURE": b64(JSON.stringify(payments)) });
    const body = await res.json();
    // Drop every voucher the seller says it settled (`paid`) or could not (`rejected`: spent, or
    // the wallet cannot cover it), on success, partial delivery and refusal alike, so a dead
    // voucher is never offered twice. A seller that names none: all of them on a 200.
    const nonce = (p) => p.payload.authorization.nonce;
    const paidNonces = new Set(body.paid ?? (res.status === 200 ? payments.map(nonce) : []));
    if (vouchers) for (const n of [...paidNonces, ...(body.rejected ?? [])]) {
        const k = vouchers.findIndex((v) => nonce(v) === n);
        if (k >= 0) vouchers.splice(k, 1);
    }
    if (res.status !== 200) throw new Error(`payment refused: ${body.error ?? JSON.stringify(body).slice(0, 200)}`);
    const spent = payments.filter((p) => paidNonces.has(nonce(p))).reduce((s, p) => s + BigInt(p.payload.authorization.value), 0n);
    const records = await openAll(body.keys, ct, want);
    // `undelivered` + `error`: a payment failed after others settled; these ids were not paid for.
    return { records, missing: [...unsealed, ...(body.missing ?? [])], undelivered: body.undelivered ?? [], error: body.error ?? null,
        manifest: { app: url, bought: new Date().toISOString(), price: String(spent),
        asset: req.asset, network: req.network, transactions: body.receipts.map((r) => r.transaction),
        records: records.map(({ id, sha256 }) => ({ id, sha256 })) } };
}

// ── self-check: `node src/agent/x402.js` — a stand-in seller that checks the signature ──
if (typeof process !== "undefined" && import.meta.url === `file://${process.argv[1]}` && process.argv[1].endsWith("/x402.js")) {
    const { privateKeyToAccount, generatePrivateKey } = await import("viem/accounts");
    const { verifyTypedData } = await import("viem");
    const buyer = privateKeyToAccount(generatePrivateKey());
    // Base Sepolia's USDC, whose EIP-712 name is "USDC" (Base's is "USD Coin").
    const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e", SELLER = `0x${"5e".repeat(20)}`, CHAIN = 84532, DOMAIN = { name: "USDC", version: "2" };
    const req = { scheme: "exact", network: `eip155:${CHAIN}`, amount: "10000", payTo: SELLER, asset: USDC, maxTimeoutSeconds: 120, extra: DOMAIN };
    let settled = null;
    const seller = async (url, init = {}) => {
        const h = init.headers?.["PAYMENT-SIGNATURE"];
        if (!h) return new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": b64(JSON.stringify({ x402Version: 2, resource: { url }, accepts: [req] })) } });
        const sent = JSON.parse(unb64(h)), p = sent.payload, a = p.authorization;
        if (sent.x402Version !== 2 || sent.resource?.url !== url || sent.accepted?.amount !== "10000") return new Response("{}", { status: 400 });
        const ok = await verifyTypedData({ address: a.from, signature: p.signature,
            domain: { ...DOMAIN, chainId: CHAIN, verifyingContract: USDC },
            types: { TransferWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
                { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] },
            primaryType: "TransferWithAuthorization",
            message: { ...a, value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore) } });
        if (!ok || a.to !== SELLER || a.value !== "10000") return new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": b64(JSON.stringify({ x402Version: 2, error: "bad payment", accepts: [req] })) } });
        settled = a;
        return new Response('{"secret":42}', { status: 200, headers: { "PAYMENT-RESPONSE": b64(JSON.stringify({ success: true, transaction: "0xabc" })) } });
    };
    const r = await payAndFetch("https://x/paid/1", { account: buyer, maxPrice: 10000n, fetchImpl: seller });
    if (r.body !== '{"secret":42}' || r.receipt.transaction !== "0xabc" || settled.from !== buyer.address) throw new Error(`paid fetch: ${JSON.stringify(r)}`);
    let refused = false;
    try { await payAndFetch("https://x/paid/1", { account: buyer, maxPrice: 9999n, fetchImpl: seller }); } catch (e) { refused = /exceeds the cap/.test(e.message); }
    if (!refused) throw new Error("a price over the cap must be refused before signing");

    // Batches through the real worker (CONFIG as ship deploys it), a stand-in facilitator
    // that checks signatures and refuses a nonce settled twice, and vouchers signed ahead.
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const membership = { registry: `0x${"12".repeat(20)}`, barliman: "https://barliman", chainId: CHAIN, appId: `0x${"ab".repeat(32)}` };
    const sale = { price: "100000", network: `eip155:${CHAIN}`, asset: USDC, payTo: SELLER, facilitator: "https://fac", ...DOMAIN, description: "", membership };
    // Not a literal: the page bundles this module, and a bundler would follow it into the Worker.
    const WORKER = "../../site/worker.js";
    const worker = (await import(/* @vite-ignore */ WORKER)).default;
    // The rows as a buyer reads them: each record sealed under its key, with the plaintext's sha256.
    const SECRET = "s3cret", ct = {}, want = {};
    for (const id of ["a", "b", "c"]) {
        const plain = JSON.stringify({ id, amount: 1 });
        ct[id] = await sealPaid(await paidKey(SECRET, id), plain);
        want[id] = await sha256(new TextEncoder().encode(plain));
    }
    const env = { PAID_SECRET: SECRET, CONFIG: { name: "Test", paid: sale } };
    const member = privateKeyToAccount(generatePrivateKey()), memberToken = "77";
    const spent = new Set(), facilitated = [];
    const realFetch = globalThis.fetch;
    const { recoverTypedDataAddress } = await import("viem");
    globalThis.fetch = async (u, init) => {
        if (u === "https://barliman/check") {   // a stand-in Barliman: the member's token reads, nobody else's
            const b = JSON.parse(init.body);
            const reader = await recoverTypedDataAddress({ ...readTypedData({ registry: membership.registry, chainId: CHAIN, ...b }), signature: b.signature });
            const ok = reader === member.address && b.tokenId === memberToken && b.appId === membership.appId;
            return new Response(JSON.stringify({ ok, reader, until: ok ? "1900000000" : "0" }));
        }
        const { x402Version, paymentPayload: p, paymentRequirements: q } = JSON.parse(init.body), a = p.payload.authorization;
        if (x402Version !== 2 || p.x402Version !== 2) throw new Error("the facilitator is spoken to in v2");
        facilitated.push(p);
        if (u.endsWith("/verify")) {
            const ok = await verifyTypedData({ address: a.from, signature: p.payload.signature,
                domain: { ...DOMAIN, chainId: CHAIN, verifyingContract: USDC },
                types: { TransferWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
                    { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] },
                primaryType: "TransferWithAuthorization",
                message: { ...a, value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore) } });
            return new Response(JSON.stringify({ isValid: ok && a.value === q.amount, invalidReason: "bad" }));
        }
        if (spent.has(a.nonce)) return new Response(JSON.stringify({ success: false, errorReason: "nonce used" }));
        spent.add(a.nonce);
        return new Response(JSON.stringify({ success: true, transaction: `0x${spent.size}` }));
    };
    const viaWorker = (u, init) => worker.fetch(new Request(u, init), env);
    const paidCard = { url: "https://x/paid/{id}", key_url: "https://x/key", price: sale.price, membership };
    try {
        // One record, one payment: the key opens the row's sealed record, which matches its hash.
        const single = await buyRecord(paidCard, "a", { ct: ct.a, want: want.a, account: buyer, maxPrice: 100000n, fetchImpl: viaWorker });
        if (single.verified !== true || single.record.id !== "a") throw new Error(`single key: ${JSON.stringify(single)}`);
        if (facilitated.some((p) => p.extensions)) throw new Error("GET /paid/<id> must not ask to be listed: its URL differs per record");
        // A probe with no body (x402scan, a Bazaar crawler) gets a 402 for one record, Bazaar extension and all.
        const probe = await viaWorker("https://x/paid", { method: "POST" });
        const asked = paymentRequired(probe);
        if (probe.status !== 402 || asked.accepts[0].amount !== sale.price || asked.extensions?.bazaar?.info?.input?.method !== "POST")
            throw new Error(`probe: ${probe.status} ${JSON.stringify(asked)}`);
        // One exact payment from a wallet: 2 of 3 ids are sealed in the rows, 2 × $0.10, the
        // third is never quoted (no ciphertext in hand, nothing to pay for).
        const one = await buyBatch(paidCard, ["a", "b", "zz"], { account: buyer, maxPrice: 200000n, ct, want, fetchImpl: viaWorker });
        if (one.records.length !== 2 || one.missing[0] !== "zz" || one.manifest.price !== "200000" || !one.records.every((r) => r.verified === true))
            throw new Error(`batch with a wallet: ${JSON.stringify(one)}`);
        // The facilitator lists what it settles with the Bazaar extension: every batch payment carries it.
        const batchSent = facilitated.slice(-2);   // its one payment: verify, settle
        if (!batchSent.every((p) => p.extensions?.bazaar && p.resource.url === "https://x/paid" && p.accepted.amount === "200000"))
            throw new Error(`batch payloads: ${JSON.stringify(batchSent.map((p) => [p.resource?.url, p.accepted?.amount, !!p.extensions]))}`);
        // $2 of vouchers in $0.10 / $1, 30 days: any multiple of $0.10 can be paid exactly.
        const vs = await signVouchers({ ...paidCard, scheme: "exact", network: sale.network, payTo: SELLER, asset: USDC, extra: DOMAIN },
            buyer, { total: 2000000n, denominations: [100000n, 1000000n] });
        if (vs.length !== 11 || pick(vs, 1700000n).length !== 8 || pick(vs, 2100000n) !== null) throw new Error(`vouchers: ${vs.length}`);
        const before = [...vs];
        const three = await buyBatch(paidCard, ["a", "b", "c"], { vouchers: vs, ct, want, fetchImpl: viaWorker });
        if (three.records.length !== 3 || vs.length !== 8 || three.manifest.transactions.length !== 3) throw new Error(`batch with vouchers: ${JSON.stringify(three.manifest)}`);
        // A spent $0.10 voucher riding along with a fresh one: both verify, settle refuses, nothing sent.
        const usedOne = before.find((v) => !vs.includes(v) && v.payload.authorization.value === "100000");
        const fresh = vs.find((v) => v.payload.authorization.value === "100000");
        const replay = await viaWorker("https://x/paid", { method: "POST", body: JSON.stringify({ ids: ["a", "b"] }), headers: { "PAYMENT-SIGNATURE": b64(JSON.stringify([usedOne, fresh])) } });
        if (replay.status !== 402 || (await replay.json()).keys) throw new Error("a spent voucher must not buy anything");
        const short = await viaWorker("https://x/paid", { method: "POST", body: JSON.stringify({ ids: ["a", "b"] }), headers: { "PAYMENT-SIGNATURE": b64(JSON.stringify([fresh])) } });
        if (short.status !== 402) throw new Error("payments short of the price must be refused");
        // A spent voucher still in the stack, behind a fresh one (a crash before the file was
        // saved): the fresh one settles and buys one record, the spent one is refused, and both
        // leave the stack so neither is offered again.
        const fresh2 = vs.find((v) => v !== fresh && v.payload.authorization.value === "100000");
        const stack = [fresh2, usedOne];
        const half = await buyBatch(paidCard, ["a", "b"], { vouchers: stack, ct, want, fetchImpl: viaWorker });
        if (half.records.length !== 1 || half.undelivered[0] !== "b" || !half.error || half.manifest.price !== "100000" || stack.length !== 0)
            throw new Error(`partial settle: ${JSON.stringify({ ...half, stack: stack.length })}`);
        // The spent voucher first: nothing settles, nothing is sent, and it is dropped.
        const stack2 = [usedOne, fresh];
        let threw = false;
        try { await buyBatch(paidCard, ["a", "b"], { vouchers: stack2, ct, want, fetchImpl: viaWorker }); } catch { threw = true; }
        if (!threw || stack2.length !== 1 || stack2[0] !== fresh) throw new Error(`refused batch must drop only the spent voucher: ${stack2.length}`);
        // A member reads for free: the signed request names the token; a stranger's is refused.
        const read = await readAsMember(paidCard, ["a", "c"], { reader: member, tokenId: memberToken, ct, want, fetchImpl: viaWorker });
        if (read.records.length !== 2 || !read.records.every((r) => r.verified === true)) throw new Error(`member read: ${JSON.stringify(read)}`);
        let stranger = false;
        try { await readAsMember(paidCard, ["a"], { reader: buyer, tokenId: memberToken, ct, want, fetchImpl: viaWorker }); } catch { stranger = true; }
        if (!stranger) throw new Error("a reader the membership does not name must be refused");
        // The allowance lock: two purchases at once take turns; a crashed one's lock is taken over.
        const vfile = `${mkdtempSync(`${tmpdir()}/wm-`)}/vouchers.json`, order = [];
        const turn = (name) => withLock(vfile, async () => { order.push(`${name}+`); await new Promise((ok) => setTimeout(ok, 50)); order.push(`${name}-`); });
        await Promise.all([turn("a"), turn("b")]);
        if (order.join() !== "a+,a-,b+,b-" && order.join() !== "b+,b-,a+,a-") throw new Error(`lock interleaved: ${order}`);
        writeFileSync(`${vfile}.lock`, "");
        const { utimesSync, existsSync } = await import("node:fs");
        utimesSync(`${vfile}.lock`, new Date(Date.now() - 300_000), new Date(Date.now() - 300_000));
        if (await withLock(vfile, async () => 7) !== 7 || existsSync(`${vfile}.lock`)) throw new Error("a stale lock must be taken over and released");
    } finally { globalThis.fetch = realFetch; }
    console.log("x402.js batch self-check ok — keys, not records: each opens the row's sealed record and matches its hash; a member reads free and a stranger is refused; one price for the ids sealed in the rows, paid by one signature or by vouchers signed ahead, spent vouchers removed and refused if replayed, short payment refused, a half-settled batch delivers what was paid and drops spent vouchers, the allowance file is locked per purchase");
    console.log("x402.js self-check ok — a signed EIP-3009 authorization the seller can verify, exactly the asked amount to the asked payee, the receipt read back, and a price over the cap refused before signing");
}
