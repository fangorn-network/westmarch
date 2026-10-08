// The app's front door (Cloudflare Pages advanced mode): the static site, plus two things a
// static site cannot do. `westmarch-ship` writes this to site/_worker.js with CONFIG filled in.
//
//   GET /doc?u=<url>      a record's source document, served from this origin so the page can
//                         show it inline. Source sites forbid framing and send no CORS, so the
//                         page cannot fetch or frame them itself. Only hosts the app's own
//                         records link to (CONFIG.docHosts), only PDFs, cached for a day.
//   GET /paid/<item id>   with CONFIG.paid: 402 + the price; with a valid X-PAYMENT header, the
//                         facilitator verifies and settles it, then the record's KEY is returned
//   POST /paid {ids}      many keys for one price, paid by one payment or several (vouchers)
//   POST /key {ids, tokenId, issuedAt, signature}
//                         keys for a member: Barliman checks the signed request against the
//                         MembershipRegistry (`canRead`), and nothing is paid here
//   anything else         the static site, with the headers _headers would have set
//
// The paid records are not here. Each is already in the app's committed rows on IPFS,
// encrypted (`paid_ct`, AES-256-GCM), with the sha256 of its plaintext beside it. This worker
// sells only the key, HMAC-SHA256(PAID_SECRET, id): the buyer holds the ciphertext before
// paying, so nobody pays for a record that does not exist, and decrypts and checks it after.

const CONFIG = /*CONFIG*/ { docHosts: [], paid: null } /*END*/;

const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "X-PAYMENT, content-type", "access-control-expose-headers": "X-PAYMENT-RESPONSE" };
const json = (o, status = 200, headers = {}) =>
    new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", ...CORS, ...headers } });
const note = (msg, status) => new Response(`<!doctype html><meta charset="utf-8"><body style="font:15px system-ui;padding:24px;color:#555">${msg}</body>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } });

async function doc(request, url) {
    let src;
    try { src = new URL(url.searchParams.get("u") ?? ""); } catch { return note("No document named.", 400); }
    if (src.protocol !== "https:" || !CONFIG.docHosts.includes(src.hostname)) return note("Not one of this app's sources.", 403);
    const cache = caches.default, key = new Request(url.href);
    const hit = await cache.match(key);
    if (hit) return hit;
    const up = await fetch(src.href, { headers: { "user-agent": "Mozilla/5.0 (compatible; fangorn-app/0.1; +https://fangorn.network)" }, redirect: "follow" });
    // A redirect may not leave the allowed hosts, and only a PDF is shown: an HTML page from
    // someone else's site, served from this origin, would run as this app.
    if (!CONFIG.docHosts.includes(new URL(up.url).hostname)) return note("The source redirected elsewhere.", 403);
    if (!up.ok || !(up.headers.get("content-type") ?? "").includes("pdf"))
        return note(`This document is not a PDF. <a href="${src.href.replace(/"/g, "&quot;")}" target="_blank" rel="noopener">Open it on the source site</a>.`, 415);
    const res = new Response(up.body, { headers: { "content-type": "application/pdf", "content-disposition": "inline",
        "cache-control": "public, max-age=86400", "x-content-type-options": "nosniff" } });
    await cache.put(key, res.clone());
    return res;
}

/** A record's key: HMAC-SHA256(PAID_SECRET, id), hex. The same derivation as the sources that
 *  encrypt (and x402.js's paidKey). */
async function keyFor(env, id) {
    if (!env.PAID_SECRET) throw new Error("PAID_SECRET is not set (wrangler pages secret put PAID_SECRET)");
    const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.PAID_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(id)));
    return [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const keysFor = async (env, ids) => Object.fromEntries(await Promise.all(ids.map(async (id) => [id, await keyFor(env, id)])));

async function facilitator(path, payment, requirements) {
    // A network failure is an answer too: thrown, it would turn a half-settled batch into a 500.
    let r;
    try {
        r = await fetch(`${CONFIG.paid.facilitator}/${path}`, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ x402Version: 1, paymentPayload: payment, paymentRequirements: requirements }),
        });
    } catch (e) { return { error: `facilitator ${path}: ${e.message}` }; }
    const text = await r.text();
    try { return JSON.parse(text); } catch { return { error: `facilitator ${path}: HTTP ${r.status} ${text.slice(0, 200)}` }; }
}

async function sell(request, env, url) {
    const P = CONFIG.paid;
    const id = decodeURIComponent(url.pathname.slice("/paid/".length));
    if (!id) return json({ error: "no id" }, 400);
    const requirements = {
        scheme: "exact", network: P.network, maxAmountRequired: P.price, resource: url.href,
        description: P.description, mimeType: "application/json", payTo: P.payTo,
        maxTimeoutSeconds: 120, asset: P.asset, extra: { name: P.name, version: P.version },
    };
    const refuse = (error) => json({ x402Version: 1, error, accepts: [requirements] }, 402);
    const header = request.headers.get("X-PAYMENT");
    if (!header) return refuse("X-PAYMENT header is required");
    let payment;
    try { payment = JSON.parse(atob(header)); } catch { return refuse("X-PAYMENT is not base64 JSON"); }
    const verified = await facilitator("verify", payment, requirements);
    if (!verified.isValid) return refuse(verified.invalidReason ?? verified.error ?? "payment did not verify");
    const settled = await facilitator("settle", payment, requirements);
    if (!settled.success) return refuse(settled.errorReason ?? settled.error ?? "settlement failed");
    return json({ id, key: await keyFor(env, id) }, 200, { "x-payment-response": btoa(JSON.stringify(settled)) });
}

// POST /paid {ids}: many keys, one price. 402 with the total; then X-PAYMENT may be one payment
// or a JSON array of them (an agent's vouchers) that add up to it. The only subrequests are the
// facilitator's (2 per payment, 50 on the free plan), hence MAX_PAYMENTS; keys cost nothing.
const MAX_BATCH = 1000, MAX_PAYMENTS = 10;
async function sellBatch(request, env, url) {
    const P = CONFIG.paid;
    let ids;
    try { ids = [...new Set((await request.json()).ids)].filter((x) => typeof x === "string"); } catch { return json({ error: "body must be {\"ids\": [...]}" }, 400); }
    if (!ids.length || ids.length > MAX_BATCH) return json({ error: `between 1 and ${MAX_BATCH} ids per purchase` }, 400);
    const found = ids, missing = [];
    const total = BigInt(P.price) * BigInt(found.length);
    const requirements = (amount) => ({
        scheme: "exact", network: P.network, maxAmountRequired: String(amount), resource: url.href,
        description: P.description, mimeType: "application/json", payTo: P.payTo,
        maxTimeoutSeconds: 120, asset: P.asset, extra: { name: P.name, version: P.version },
    });
    const refuse = (error, more = {}) => json({ x402Version: 1, error, accepts: [requirements(total)], found, missing, ...more }, 402);
    const header = request.headers.get("X-PAYMENT");
    if (!header) return refuse("X-PAYMENT header is required");
    let payments;
    try { payments = [JSON.parse(atob(header))].flat(); } catch { return refuse("X-PAYMENT is not base64 JSON"); }
    if (payments.length > MAX_PAYMENTS) return refuse(`at most ${MAX_PAYMENTS} payments per purchase`);
    const auths = payments.map((p) => p?.payload?.authorization ?? {});
    if (new Set(auths.map((a) => a.nonce)).size !== auths.length) return refuse("a payment is repeated");
    if (auths.some((a) => String(a.to).toLowerCase() !== P.payTo.toLowerCase())) return refuse("a payment is not to this app");
    let sum = 0n;
    try { for (const a of auths) sum += BigInt(a.value); } catch { return refuse("a payment has no amount"); }
    if (sum !== total) return refuse(`payments add up to ${sum}, the price is ${total}`);
    for (const [i, p] of payments.entries()) {
        const v = await facilitator("verify", p, requirements(auths[i].value));
        if (!v.isValid) return refuse(`payment ${i + 1}: ${v.invalidReason ?? v.error ?? "did not verify"}`);
    }
    // Settle one by one. A spent voucher (or one the wallet can no longer cover) passes verify
    // and fails here. If that happens after others settled, the buyer still gets what the
    // settled money pays for, never more: a spent voucher riding along with a fresh one buys
    // only what the fresh one pays for. `paid` and `rejected` name the vouchers (by nonce) so
    // the buyer's stack can drop them either way.
    const receipts = [];
    let settled = 0n;
    for (const [i, p] of payments.entries()) {
        const s = await facilitator("settle", p, requirements(auths[i].value));
        if (!s.success) {
            const error = `payment ${i + 1}: ${s.errorReason ?? s.error ?? "settlement failed"}`;
            if (!receipts.length) return refuse(error, { rejected: [auths[i].nonce] });
            const n = Number(settled / BigInt(P.price));
            return json({ keys: await keysFor(env, found.slice(0, n)), missing, undelivered: found.slice(n), receipts, error,
                paid: auths.slice(0, i).map((a) => a.nonce), rejected: [auths[i].nonce] });
        }
        receipts.push(s);
        settled += BigInt(auths[i].value);
    }
    return json({ keys: await keysFor(env, found), missing, receipts, paid: auths.map((a) => a.nonce) });
}

// POST /key: keys for a member. Barliman recovers who signed the request and asks the
// MembershipRegistry whether that address may read this app now; this worker trusts its answer.
// ponytail: one Barliman call per request; cache {tokenId, reader} → until if it gets busy.
async function member(request, env) {
    const M = CONFIG.paid.membership;
    if (!M) return json({ error: "this app sells no memberships" }, 404);
    let b;
    try { b = await request.json(); } catch { return json({ error: "body must be JSON" }, 400); }
    const ids = [...new Set(b?.ids ?? [])].filter((x) => typeof x === "string");
    if (!ids.length || ids.length > MAX_BATCH) return json({ error: `between 1 and ${MAX_BATCH} ids` }, 400);
    let check;
    try {
        const r = await fetch(`${M.barliman}/check`, { method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ appId: M.appId, tokenId: String(b.tokenId), ids, issuedAt: b.issuedAt, signature: b.signature }) });
        check = await r.json();
    } catch (e) { return json({ error: `could not check the membership: ${e.message}` }, 502); }
    if (!check.ok) return json({ error: check.error ?? "this membership cannot read this app now", until: check.until ?? null }, 403);
    return json({ keys: await keysFor(env, ids), reader: check.reader, until: check.until });
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
        if (url.pathname === "/_worker.js") return new Response("not found", { status: 404 });
        if (url.pathname === "/doc") return doc(request, url);
        if (url.pathname === "/paid" && request.method === "POST") return CONFIG.paid ? sellBatch(request, env, url) : json({ error: "nothing is sold here" }, 404);
        if (url.pathname.startsWith("/paid/")) return CONFIG.paid ? sell(request, env, url) : json({ error: "nothing is sold here" }, 404);
        if (url.pathname === "/key" && request.method === "POST") return CONFIG.paid ? member(request, env) : json({ error: "nothing is sold here" }, 404);

        const res = await env.ASSETS.fetch(request);
        const out = new Response(res.body, res);
        const p = url.pathname;
        if (p === "/.well-known/agent-card.json" || p.startsWith("/view/")) out.headers.set("access-control-allow-origin", "*");
        if (p.startsWith("/assets/")) out.headers.set("cache-control", "public, max-age=31536000, immutable");
        // Shards are content-named, so a reader's browser keeps one for good: a change or a
        // retraction writes new names. `private`: pages.dev's edge cache cannot be purged, so it
        // must never hold one, and a retracted record's shard stops being served when the deploy
        // drops it. (This worker's header wins over _headers, which Pages skips for worker responses.)
        else if (/^\/view\/cdn\/domains\/[^/]+\/shards\//.test(p))
            out.headers.set("cache-control", (res.headers.get("content-type") ?? "").includes("html") ? "no-store" : "private, max-age=31536000, immutable");
        return out;
    },
};
