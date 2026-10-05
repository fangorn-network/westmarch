// The app's front door (Cloudflare Pages advanced mode): the static site, plus two things a
// static site cannot do. `westmarch-ship` writes this to site/_worker.js with CONFIG filled in.
//
//   GET /doc?u=<url>      a record's source document, served from this origin so the page can
//                         show it inline. Source sites forbid framing and send no CORS, so the
//                         page cannot fetch or frame them itself. Only hosts the app's own
//                         records link to (CONFIG.docHosts), only PDFs, cached for a day.
//   GET /paid/<item id>   with CONFIG.paid: 402 + the price; with a valid X-PAYMENT header, the
//                         facilitator verifies and settles it, then the record is returned
//   GET /_paid/*          404 to everyone: the records sit here as static files, and the
//                         only way to one is through a settled payment
//   anything else         the static site, with the headers _headers would have set
//
// A record that does not exist is a 404 before any price is quoted: nobody pays for nothing.
// Each record's sha256 is in the app's public (committed) data, so a buyer can check it.

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

async function fileFor(id) {
    const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(id)));
    return [...d].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

async function facilitator(path, payment, requirements) {
    const r = await fetch(`${CONFIG.paid.facilitator}/${path}`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ x402Version: 1, paymentPayload: payment, paymentRequirements: requirements }),
    });
    const text = await r.text();
    try { return JSON.parse(text); } catch { return { error: `facilitator ${path}: HTTP ${r.status} ${text.slice(0, 200)}` }; }
}

async function sell(request, env, url) {
    const P = CONFIG.paid;
    const id = decodeURIComponent(url.pathname.slice("/paid/".length));
    const record = await env.ASSETS.fetch(new URL(`/_paid/${await fileFor(id)}.json`, url));
    // Pages answers an unknown path with index.html and a 200 (its single-page fallback), so
    // "ok" is not "exists": only a JSON body is a record. Nobody is quoted a price for nothing.
    if (!record.ok || !(record.headers.get("content-type") ?? "").includes("json")) return json({ error: `no paid record for ${id}` }, 404);
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
    return new Response(await record.text(), {
        headers: { "content-type": "application/json", "x-payment-response": btoa(JSON.stringify(settled)), ...CORS },
    });
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
        if (url.pathname.startsWith("/_paid/") || url.pathname === "/_worker.js") return new Response("not found", { status: 404 });
        if (url.pathname === "/doc") return doc(request, url);
        if (url.pathname.startsWith("/paid/")) return CONFIG.paid ? sell(request, env, url) : json({ error: "nothing is sold here" }, 404);

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
