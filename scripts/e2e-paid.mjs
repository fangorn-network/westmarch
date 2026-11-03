#!/usr/bin/env node
// One sale, end to end, on this machine: `node scripts/e2e-paid.mjs`.
//
//   anvil with the contracts (devnet.js), the key server and Barliman from the webworker checkout,
//   and an app's Worker, each under `wrangler dev` and wired to that chain. A publisher seals a
//   record (`sealRecords`, what `fangorn commit --paid` runs) and commits it; a buyer is quoted by
//   the app, pays through Barliman, settles, and opens the field with the key server's key.
//
// Needs anvil, forge, the contracts (FANGORN_CONTRACTS_DIR, default ../contracts) and the webworker
// checkout (FANGORN_WEBWORKER_DIR, default ../webworker, `pnpm install` run). No Cloudflare login.
// USDC and Semaphore are the contracts' mocks, so the proof is a stand-in: everything else is real.

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAbi } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { sealRecords } from "@fangorn-network/sdk";
import { wranglerConfig } from "../src/publish/ship.js";
import { devnet } from "../src/publish/devnet.js";
import { buyRecord } from "../src/agent/x402.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const log = (s) => console.error(`[e2e-paid] ${s}`);
const check = (ok, what) => { if (!ok) throw new Error(`FAILED: ${what}`); log(`✓ ${what}`); };
const PRICE = 10_000n;   // 0.01 USDC

const net = await devnet({ log });
try {
    // ── the services ──────────────────────────────────────────────────────────
    const [keys, { url: relay, treasury }] = await Promise.all([net.keyServer(), net.relay()]);

    // ── a publisher sells one record ──────────────────────────────────────────
    const publisher = await net.client();
    await publisher.initRepo("notes");
    const records = await sealRecords(publisher, "notes", [
        { id: "a", type: "note", payload: { title: "Note a", body: { text: "the body of a" } } },
        { id: "b", type: "note", payload: { title: "Note b", body: { text: "the body of b" } } },
    ], { fields: ["body"], price: PRICE, shareBps: 500, deadline: 2_000_000_000n, keyServer: keys });
    await publisher.uploadBatch("notes", records);
    const P = publisher.getAddress();
    log(`published ${P}:notes with a deposit at ${keys}`);

    // ── the app's Worker: its /paid quotes, through Barliman ──────────────────
    const dir = mkdtempSync(join(tmpdir(), "e2e-paid-"));
    mkdirSync(join(dir, "site"));
    writeFileSync(join(dir, "site/index.html"), "<!doctype html><title>e2e</title>");
    const wcfg = wranglerConfig({ name: "e2e-paid", site: join(dir, "site"), config: { app: "notes-app", name: "Notes", description: "Notes for sale.",
        fromBlock: "0", repos: ["notes"], deployment: net.deployment, paid: true, facilitator: relay, schema: { types: {}, relations: [] } } });
    delete wcfg.ai;   // no cron here: no encoder, and no Cloudflare login
    wcfg.vars.RPC_URL = net.rpcUrl;
    wcfg.vars.IPFS_GATEWAY = net.gatewayUrl;
    writeFileSync(join(dir, "wrangler.json"), JSON.stringify(wcfg, null, 1));
    const app = await net.worker(resolve(HERE, ".."), {}, { config: join(dir, "wrangler.json"), name: "app worker" });

    // ── a buyer ───────────────────────────────────────────────────────────────
    const buyerKey = generatePrivateKey();
    const buyer = await net.client(buyerKey);
    const quote = `${app}/paid/${P}/notes/a`;
    const q = await fetch(quote);
    const asked = JSON.parse(atob(q.headers.get("PAYMENT-REQUIRED"))).accepts[0];
    check(q.status === 402 && asked.scheme === "fangorn" && asked.amount === String(PRICE) && asked.extra.referrer === treasury,
        "the app quotes the record from its signed terms, with Barliman's treasury as referrer");
    check((await fetch(`${app}/paid/${P}/notes/nope`)).status === 404, "a record that isn't sold is not quoted");

    // The proof is a stand-in: the devnet's Semaphore accepts any.
    const prove = async () => ({ merkleTreeDepth: "1", merkleTreeRoot: "1", nullifier: String(BigInt(generatePrivateKey())), points: Array(8).fill("0") });
    const got = await buyRecord(quote, { privateKey: buyerKey, fangorn: buyer, maxPrice: PRICE, deps: { prove } });
    check(got.fields.body.text === "the body of a" && got.tx, "paid through Barliman, settled, and the field opened with the key server's key");

    const balance = (who) => net.chain.readContract({ address: net.usdc, abi: parseAbi(["function balanceOf(address) view returns (uint256)"]), functionName: "balanceOf", args: [who] });
    check(await balance(P) === PRICE - PRICE / 20n && await balance(treasury) === PRICE / 20n, "the publisher got the price less 5%, and the treasury the 5%");

    const again = await buyRecord(quote, { privateKey: buyerKey, fangorn: buyer, deps: { prove } });
    check(again.tx === null && again.fields.body.text === "the body of a", "buying again pays nothing and opens it again");

    await buyRecord(`${app}/paid/${P}/notes/b`, { privateKey: buyerKey, fangorn: buyer, maxPrice: PRICE - 1n, deps: { prove } })
        .then(() => check(false, "over the cap"), (e) => check(/exceeds the cap/.test(e.message), "a price over the buyer's cap is refused before signing"));

    log("done");
} finally {
    net.stop();
}
process.exit(0);
