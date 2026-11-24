// Needs the sandbox (npm run sandbox): two repos of alice's move in one transaction, relayed by the indexer's key.
import { test, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { privateKeyToAccount } from "viem/accounts";
import { client } from "./client.js";
import { prepare } from "../worker/publisher.js";
import { relayAll } from "./multicall.js";

const dir = fileURLToPath(new URL("../.sandbox", import.meta.url));
const up = existsSync(`${dir}/sandbox.json`);

test.skipIf(!up)("relayAll: N repos' signed updates land in one Multicall3 transaction", async () => {
    const { keys } = JSON.parse(readFileSync(`${dir}/sandbox.json`, "utf8"));
    const app = client({ network: "sandbox", sandbox: dir }, keys.indexer), alice = privateKeyToAccount(keys.alice);
    const tag = Date.now().toString(36), repos = [`lb-a-${tag}`, `lb-b-${tag}`, `lb-c-${tag}`];
    const prepared = await Promise.all(repos.map((repo, i) => prepare({ fangorn: app, owner: alice.address }, repo, [{ id: "e/0", type: "event", payload: { i } }])));
    const signed = await Promise.all(prepared.map(async (p) => ({ publisher: alice.address, update: p.update, signature: await alice.signTypedData(p.typedData) })));
    const txHash = await relayAll(app, signed);
    for (const [i, repo] of repos.entries()) expect((await app.engine.readRecord(alice.address, repo, "e/0")).payload).toEqual({ i });
    const config = app.getConfig();
    const { createPublicClient, http } = await import("viem");
    const receipt = await createPublicClient({ chain: config.chain, transport: http(config.rpcUrl) }).getTransactionReceipt({ hash: txHash });
    expect(receipt.logs.filter((l) => l.address.toLowerCase() === config.dataRegistryContractAddress.toLowerCase()).length).toBeGreaterThanOrEqual(3);

    // a second round builds on the new heads; a stale one (same parent again) reverts the whole batch
    const again = await Promise.all(repos.map((repo) => prepare({ fangorn: app, owner: alice.address }, repo, [{ id: "e/1", type: "event", payload: {} }])));
    const signed2 = await Promise.all(again.map(async (p) => ({ publisher: alice.address, update: p.update, signature: await alice.signTypedData(p.typedData) })));
    await relayAll(app, signed2);
    await expect(relayAll(app, [signed2[0], signed[1]])).rejects.toThrow();
}, 60_000);
