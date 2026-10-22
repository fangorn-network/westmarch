#!/usr/bin/env node
// The free tier end to end, on this machine: `node scripts/e2e-worker.mjs`.
//
//   anvil, with the contracts built from source (FANGORN_CONTRACTS_DIR, default
//   ../contracts/solidity) behind their proxies; an IPFS gateway on localhost that the
//   publishers write to; publishers that claim an app and publish
//   into it, and one that publishes under no app; then the app's Worker (site/worker.js)
//   under `wrangler dev`, with its real AI binding (so: logged in to wrangler, and it
//   spends a few neurons) and a local R2. It runs the cron, asks /mcp, excludes a
//   publisher, runs the cron again, and checks the view followed.
//
// Not part of `npm test`: it needs anvil, forge, wrangler and a Cloudflare login (with more
// than one account, CLOUDFLARE_ACCOUNT_ID picks the one the AI binding bills).

import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { appId as appIdOf } from "@fangorn-network/sdk";
import { wranglerConfig } from "../src/publish/ship.js";
import { devnet } from "../src/publish/devnet.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = "e2e-shop";
const log = (s) => console.error(`[e2e] ${s}`);
const check = (ok, what) => { if (!ok) throw new Error(`FAILED: ${what}`); log(`✓ ${what}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(f, what, ms = 180_000) {
    const t0 = Date.now();
    for (;;) {
        const v = await f().catch(() => null);
        if (v) return v;
        if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
        await sleep(1000);
    }
}

// ── chain, storage ────────────────────────────────────────────────────────────
const net = await devnet({ log });
const { client, deployment, rpcUrl, gatewayUrl, kids, stop } = net;

// ── publishers ────────────────────────────────────────────────────────────────
const owner = await client(APP);
await owner.getAppRegistry().registerApp();
const guest = await client(APP);
await owner.getAppRegistry().acceptPublisher(guest.getAddress());
await guest.initRepo("catalog");
await guest.uploadBatch("catalog", [
    { id: "a1", type: "shop.item.v1", payload: { sku: "a1", name: "Oak dining table", about: "A solid oak table that seats eight.", material: "oak" } },
    { id: "b2", type: "shop.item.v1", payload: { sku: "b2", name: "Brass reading lamp", about: "An adjustable brass desk lamp with a warm bulb.", material: "brass" } },
    { id: "c3", type: "shop.item.v1", payload: { sku: "c3", name: "Wool rug", about: "A thick hand-woven wool rug for a living room.", material: "wool" } },
]);
const loner = await client(undefined);
await loner.initRepo("catalog");
await loner.uploadBatch("catalog", [{ id: "z", type: "shop.item.v1", payload: { sku: "z", name: "Unaccepted chair", about: "Not in the app." } }]);
log(`published: owner ${owner.getAddress()}, guest ${guest.getAddress()}, loner ${loner.getAddress()} (no app)`);

// ── the Worker ────────────────────────────────────────────────────────────────
const dir = mkdtempSync(join(tmpdir(), "wm-e2e-"));
mkdirSync(join(dir, "site"));
writeFileSync(join(dir, "site/index.html"), "<!doctype html><title>e2e</title>");
const wcfg = wranglerConfig({ name: "wm-e2e", site: join(dir, "site"),
    config: { app: APP, name: "E2E Shop", description: "Furniture and lamps.", fromBlock: "0", repos: [], deployment,
    schema: { types: { "shop.item.v1": { description: "Furniture and lamps.", role_map: { identity: "sku", title: "name", text: ["about"], tags: ["material"] } } },
              relations: [{ rel: "matches", from: "shop.item.v1", to: "shop.item.v1" }] } } });
wcfg.vars.RPC_URL = rpcUrl;
wcfg.vars.IPFS_GATEWAY = gatewayUrl;
writeFileSync(join(dir, "wrangler.json"), JSON.stringify(wcfg, null, 1));
const port = 8700 + Math.floor(Math.random() * 200);
const wrangler = spawn("npx", ["wrangler", "dev", "--config", join(dir, "wrangler.json"), "--port", String(port), "--test-scheduled", "--ip", "127.0.0.1"],
    { cwd: resolve(HERE, ".."), stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NO_D1_WARNING: "true" } });
kids.push(wrangler);
let wlog = "", exited = null;
wrangler.on("exit", (code) => { exited = code; });
wrangler.stdout.on("data", (c) => { wlog += c; if (process.env.E2E_VERBOSE) process.stderr.write(c); });
wrangler.stderr.on("data", (c) => { wlog += c; if (process.env.E2E_VERBOSE) process.stderr.write(c); });
const base = `http://127.0.0.1:${port}`;
try {
    await until(async () => { if (exited !== null) throw new Error(`wrangler dev exited (${exited})`); return (await fetch(`${base}/`)).ok; }, "wrangler dev", 120_000)
        .catch((e) => { if (exited !== null) throw new Error(`wrangler dev exited (${exited})`); throw e; });
    log(`worker at ${base}`);

    const cron = async () => { await fetch(`${base}/__scheduled?cron=${encodeURIComponent(wcfg.triggers.crons[0])}`); };
    const catalog = async () => { const r = await fetch(`${base}/view/cdn/catalog`); return r.ok ? r.json() : null; };
    const mcp = async (method, params) => (await (await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json()).result;
    const tool = async (name, args = {}) => JSON.parse((await mcp("tools/call", { name, arguments: args })).content[0].text);

    await cron();
    const cat = await until(async () => { const c = await catalog(); return c?.domains?.length ? c : null; }, "the first index run");
    const guestDomain = `${appIdOf(APP).slice(2, 10)}-${guest.getAddress().slice(2, 10).toLowerCase()}-catalog`;
    check(JSON.stringify(cat.domains.map((d) => [d.name, d.count])) === JSON.stringify([[guestDomain, 3]]),
        "the cron indexed the guest's accepted repo, and not the loner's (no app)");
    const m = await (await fetch(`${base}/view/cdn/domains/${guestDomain}/manifest`)).json();
    check(m.embedder.runtime === "workers-ai" && m.dim === 256 && m.role_map.title === "name", "the manifest names the Worker's encoder, 256 dims, and the declared roles");

    // E2E_PARITY=1: the reader's runtime (transformers.js q8, in a tab) against the Worker's, on
    // the same rows. A reader ranks the Worker's vectors with its own query vector, so the two
    // must agree closely. Downloads the model (~300 MB) once.
    if (process.env.E2E_PARITY) {
        const [{ gunzipSync }, { composeText, completeRoles }, { embedDocumentDirect, unpackVec }, { env }] = await Promise.all([
            import("node:zlib"), import("../src/publish/view.js"), import("../src/core/embed.js"), import("@huggingface/transformers")]);
        env.cacheDir = `${process.env.HOME}/.cache/fangorn-mcp/models`;
        const shard = Buffer.from(await (await fetch(`${base}/view/cdn/domains/${guestDomain}/shards/${m.shards[0].file}`)).arrayBuffer());
        const rows = gunzipSync(shard).toString().trim().split("\n").map((l) => JSON.parse(l));
        const roles = completeRoles({ identity: "sku", title: "name", text: ["about"], tags: ["material"] });
        const cos = [];
        for (const r of rows) {
            const here = await embedDocumentDirect(composeText(r.fields, roles)), there = unpackVec(r.v);
            cos.push(here.reduce((s, x, i) => s + x * there[i], 0));
        }
        log(`parity: transformers.js q8 vs Workers AI, cosine per row ${cos.map((c) => c.toFixed(3)).join(", ")}`);
        check(Math.min(...cos) > 0.95, "the reader's runtime and the Worker's agree on every row (cosine > 0.95)");
    }

    check((await mcp("initialize", {})).serverInfo.name === "E2E Shop", "/mcp initializes as the app");
    const found = await tool("search", { query: "something to light my desk", limit: 1 });
    check(found.ranked_by === "meaning" && found.hits[0]?.title === "Brass reading lamp", `/mcp search ranks by meaning (top hit: ${found.hits[0]?.title})`);
    const rug = await tool("search", { query: "soft floor covering", limit: 1 });
    check(rug.hits[0]?.title === "Wool rug", `a second query finds a different record (top hit: ${rug.hits[0]?.title})`);

    // The guest publishes more; the next run embeds only that.
    await guest.uploadBatch("catalog", [{ id: "d4", type: "shop.item.v1", payload: { sku: "d4", name: "Linen curtains", about: "Light linen curtains for a bright window.", material: "linen" } }]);
    await cron();
    await until(async () => (await catalog())?.domains?.[0]?.count === 4, "the second index run");
    check(true, "a new update is indexed on the next run");

    // The owner excludes the guest: the view drops it on the next run.
    await owner.getRegistry().exclude(owner.getAppId(), { publisher: guest.getAddress() });
    await cron();
    await until(async () => (await catalog())?.domains?.length === 0, "the exclusion to land");
    check(true, "an excluded publisher's domain is dropped from the view");
    const after = await tool("describe");
    check(after.views[0].rows === 0, "and /mcp no longer serves it");
    log("all good");
} catch (e) {
    console.error(wlog.split("\n").slice(-60).join("\n"));
    throw e;
} finally {
    stop();
}
process.exit(0);
