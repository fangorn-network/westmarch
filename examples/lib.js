// What the experiments share: the running sandbox, agents on it, and a meter for what a step costs.

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, http } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { client } from "../src/client.js";
import { readSandbox } from "../src/sandbox.js";

export const SANDBOX = process.env.SANDBOX ?? ".sandbox";
export const { deployment, keys } = readSandbox(SANDBOX);
export const net = { network: "sandbox", sandbox: SANDBOX };
export const chain = createPublicClient({ transport: http(deployment.rpcUrl) });
export const say = (...a) => console.log(...a);
export const h = (s) => say(`\n── ${s}`);

const names = {};
/** Who an address is, for printing. */
export const who = (a) => names[a.toLowerCase()] ?? a.slice(0, 8);

/** A client for `name` with key `sk` (default: a fresh key), funded with 1 ETH unless `fund` is false. */
export async function agent(name, sk = keys[name] ?? generatePrivateKey(), { fund = true } = {}) {
    const address = privateKeyToAccount(sk).address;
    names[address.toLowerCase()] = name;
    if (fund && !keys[name]) await chain.request({ method: "anvil_setBalance", params: [address, "0xde0b6b3a7640000"] });
    return Object.assign(client(net, sk), { name, address: address.toLowerCase() });
}

const ipfsBytes = () => readdirSync(join(SANDBOX, "ipfs")).reduce((n, f) => n + statSync(join(SANDBOX, "ipfs", f)).size, 0);

/** Run `fn`, and measure the txs, gas, new bytes in storage and time it took. Prints a line unless `quiet`. */
export async function metered(label, fn, { quiet } = {}) {
    const [b0, s0, t0] = [await chain.getBlockNumber({ cacheTime: 0 }), ipfsBytes(), performance.now()];
    const out = await fn();
    const [b1, s1, t1] = [await chain.getBlockNumber({ cacheTime: 0 }), ipfsBytes(), performance.now()];
    const txs = [];
    for (let b = b0 + 1n; b <= b1; b++) txs.push(...(await chain.getBlock({ blockNumber: b, includeTransactions: true })).transactions);
    const receipts = await Promise.all(txs.map((t) => chain.getTransactionReceipt({ hash: t.hash })));
    const gas = receipts.reduce((g, r) => g + r.gasUsed, 0n), reverted = receipts.filter((r) => r.status !== "success").length;
    const m = { txs: txs.length, reverted, gas: Number(gas), bytes: s1 - s0, ms: Math.round(t1 - t0), payers: [...new Set(txs.map((t) => who(t.from)))] };
    if (!quiet) say(`  ${label.padEnd(36)} ${m.txs} tx${m.reverted ? ` (${m.reverted} REVERTED)` : ""}  ${String(m.gas).padStart(8)} gas  ${String(m.bytes).padStart(7)} B  ${m.ms} ms`);
    return Object.assign(m, { out });
}
