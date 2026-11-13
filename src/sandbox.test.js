import { test, expect, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Fangorn, FangornConfig } from "@fangorn-network/sdk";
import { MemLedger, MemRegistry } from "@fangorn-network/sdk/lib/test/testbed.js";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { storageServer } from "./sandbox.js";
import { stitcher } from "./stitcher.js";

const dir = mkdtempSync(join(tmpdir(), "sandbox-"));
const storage = await storageServer({ dir });
afterAll(() => storage.close());

// The SDK's own signed-url backend, pointed at the local server: uploads and reads take the real path.
const ledger = new MemLedger();
const client = (sk = generatePrivateKey()) => Fangorn.create({
    privateKey: sk,
    config: { ...FangornConfig, fromBlock: 0n, signedUrlWorker: storage.worker, ipfsGateway: storage.gateway },
    storage: { signedUrl: {} },
    registry: new MemRegistry(privateKeyToAccount(sk).address, ledger),
});

test("publish, read back, and stitch through the local storage server", async () => {
    const alice = client(), reader = client();
    await alice.initRepo("shop");
    await alice.uploadBatch("shop", [{ id: "t", type: "item", payload: { name: "oak table" } }]);

    expect(await reader.engine.readRecord(alice.getAddress(), "shop", "t")).toMatchObject({ payload: { name: "oak table" } });
    const root = await stitcher(reader, { publishers: [alice.getAddress()], repos: ["shop"] }, { store: { load: async () => {}, save: async () => {} } }).update();
    expect(root).toBeTruthy();
});

test("the gateway 404s what it doesn't have", async () => {
    const res = await fetch(`${storage.gateway}/ipfs/bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy`);
    expect(res.status).toBe(404);
});
