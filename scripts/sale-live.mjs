#!/usr/bin/env node
// One real sale on Base Sepolia: real USDC, a real Semaphore proof, the deployed contracts.
//
//   PUBLISHER_KEY=0x… BUYER_KEY=0x… TREASURY_KEY=0x… PINATA_JWT=… PINATA_GATEWAY=… node scripts/sale-live.mjs
//
//   PUBLISHER_KEY   pays gas to create a repo and commit a sealed record (a little Base Sepolia ETH)
//   BUYER_KEY       pays the price in USDC (https://faucet.circle.com, Base Sepolia); needs no ETH
//   TREASURY_KEY    Barliman's gas wallet (ETH) when Barliman runs here; TREASURY (the referrer)
//                   defaults to its address. Publisher, buyer and treasury must be three addresses.
//   KEY_SERVER_URL, BARLIMAN_URL   the deployed workers; unset, each runs here under `wrangler dev`
//                   (from FANGORN_WEBWORKER_DIR, default ../webworker) pointed at Base Sepolia
//   PINATA_JWT, PINATA_GATEWAY     storage; unset, the hosted upload worker
//   PRICE           in USDC, default 0.01
//
// The app's Worker (the quote) always runs here. A local key server makes a deposit only this run
// can open: fine for a test, never for a record you mean to keep selling.

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bytesToHex, createPublicClient, formatEther, formatUnits, http, parseAbi, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Fangorn, FangornConfig, sealRecords } from "@fangorn-network/sdk";
import { wranglerConfig } from "../src/publish/ship.js";
import { wranglerDev } from "../src/publish/devnet.js";
import { buyRecord } from "../src/agent/x402.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEBWORKER = process.env.FANGORN_WEBWORKER_DIR ?? resolve(HERE, "../../webworker");
const log = (s) => console.error(`[sale] ${s}`);
const check = (ok, what) => { if (!ok) throw new Error(`FAILED: ${what}`); log(`✓ ${what}`); };
const need = (k) => { const v = process.env[k]?.trim(); if (!v) throw new Error(`${k} is required (see the top of this file)`); return `0x${v.replace(/^0x/i, "")}`; };

const env = process.env, config = FangornConfig;
const PRICE = parseUnits(env.PRICE ?? "0.01", 6);
const publisherKey = need("PUBLISHER_KEY"), buyerKey = need("BUYER_KEY");
const treasuryKey = env.BARLIMAN_URL ? null : need("TREASURY_KEY");
const treasury = env.TREASURY ?? (treasuryKey && privateKeyToAccount(treasuryKey).address);
const storage = env.PINATA_JWT ? { pinata: { jwt: env.PINATA_JWT, gateway: env.PINATA_GATEWAY } } : { signedUrl: {} };
const gateway = env.PINATA_GATEWAY ? (/^https?:/.test(env.PINATA_GATEWAY) ? env.PINATA_GATEWAY : `https://${env.PINATA_GATEWAY}`) : config.ipfsGateway;

const pub = createPublicClient({ chain: config.chain, transport: http(config.rpcUrl) });
const usdc = await pub.readContract({ address: config.settlementRegistryContractAddress, abi: parseAbi(["function usdc() view returns (address)"]), functionName: "usdc" });
const usdcOf = (who) => pub.readContract({ address: usdc, abi: parseAbi(["function balanceOf(address) view returns (uint256)"]), functionName: "balanceOf", args: [who] });
const P = privateKeyToAccount(publisherKey).address, B = privateKeyToAccount(buyerKey).address;

// ── preflight: say what is missing before anything is spent ─────────────────
const [ethP, usdcB, ethT] = await Promise.all([pub.getBalance({ address: P }), usdcOf(B), treasuryKey ? pub.getBalance({ address: privateKeyToAccount(treasuryKey).address }) : 1n]);
log(`publisher ${P}: ${formatEther(ethP)} ETH · buyer ${B}: ${formatUnits(usdcB, 6)} USDC · treasury ${treasury}`);
// One wallet in two roles pays itself, and the contract pays no referral to the publisher.
if (P === B) throw new Error("PUBLISHER_KEY and BUYER_KEY are the same wallet: the sale would pay itself");
if (treasury.toLowerCase() === P.toLowerCase()) throw new Error("the treasury (TREASURY, else TREASURY_KEY's address) is the publisher: no referral would be paid. Set TREASURY to another address");
if (!ethP) throw new Error(`the publisher ${P} has no Base Sepolia ETH for its commits`);
if (usdcB < PRICE) throw new Error(`the buyer ${B} has ${formatUnits(usdcB, 6)} USDC, under the price ${formatUnits(PRICE, 6)}: https://faucet.circle.com`);
if (!ethT) throw new Error(`Barliman's treasury key has no Base Sepolia ETH for gas`);

const kills = [];
try {
    // ── the services ──────────────────────────────────────────────────────
    const keys = env.KEY_SERVER_URL ?? await wranglerDev(join(WEBWORKER, "fangorn-access-worker"),
        { WORKER_X25519_SECRET: bytesToHex(crypto.getRandomValues(new Uint8Array(32))) }, { probe: "/pubkey", name: "key server", log })
        .then(({ url, kill }) => (kills.push(kill), url));
    const relay = env.BARLIMAN_URL ?? await wranglerDev(join(WEBWORKER, "barliman"), { TREASURY_KEY: treasuryKey, TREASURY: treasury },
        { probe: "/supported", name: "Barliman", log }).then(({ url, kill }) => (kills.push(kill), url));

    // ── the publisher seals and commits one record ───────────────────────
    const repo = `sale-${Date.now()}`;
    const publisher = Fangorn.create({ privateKey: publisherKey, storage });
    await publisher.initRepo(repo);
    const records = await sealRecords(publisher, repo, [{ id: "a", type: "note", payload: { title: "A sealed note", body: { text: `sold ${new Date().toISOString()}` } } }],
        { fields: ["body"], price: PRICE, shareBps: 500, deadline: BigInt(Math.floor(Date.now() / 1000) + 86400), keyServer: keys });
    const { txHash } = await publisher.uploadBatch(repo, records);
    log(`published ${P}:${repo} (${txHash}); key server ${keys}`);

    // ── the app's Worker, quoting through Barliman ───────────────────────
    const dir = mkdtempSync(join(tmpdir(), "sale-"));
    mkdirSync(join(dir, "site"));
    writeFileSync(join(dir, "site/index.html"), "<!doctype html><title>sale</title>");
    const wcfg = wranglerConfig({ name: "sale", site: join(dir, "site"), ipfsGateway: gateway, config: { app: repo, name: "Sale", description: "One sale.",
        fromBlock: String(config.fromBlock), repos: [repo], paid: true, facilitator: relay, schema: { types: {}, relations: [] } } });
    delete wcfg.ai;
    writeFileSync(join(dir, "wrangler.json"), JSON.stringify(wcfg, null, 1));
    const { url: app, kill } = await wranglerDev(resolve(HERE, ".."), {}, { config: join(dir, "wrangler.json"), name: "app worker", log });
    kills.push(kill);

    // ── the buyer: quote, pay, prove, open ───────────────────────────────
    const [p0, t0] = await Promise.all([usdcOf(P), usdcOf(treasury)]);
    const buyer = Fangorn.create({ privateKey: buyerKey, storage });
    const quote = `${app}/paid/${P}/${repo}/a`;
    const t = Date.now();
    const got = await buyRecord(quote, { privateKey: buyerKey, fangorn: buyer, maxPrice: PRICE });
    log(`bought in ${((Date.now() - t) / 1000).toFixed(1)}s: register ${got.tx}`);
    check(/^sold /.test(got.fields.body.text), `the field opened: "${got.fields.body.text}"`);
    const [p1, t1] = await Promise.all([usdcOf(P), usdcOf(treasury)]);
    check(p1 - p0 === PRICE - PRICE / 20n && t1 - t0 === PRICE / 20n, `the publisher got ${formatUnits(p1 - p0, 6)} USDC and the treasury ${formatUnits(t1 - t0, 6)}`);
    log(`https://sepolia.basescan.org/tx/${got.tx}`);
} finally {
    for (const k of kills) k();
}
process.exit(0);
