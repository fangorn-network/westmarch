#!/usr/bin/env node
// A local Fangorn to play in: nothing leaves the machine.
//
//   node src/sandbox.js [dir=.sandbox]
//
// - a fresh anvil with the contracts deployed from source (../contracts), via the SDK's chainNetwork;
// - a stand-in for the upload worker and the IPFS gateway, with blocks kept in <dir>/ipfs;
// - funded keys for alice, bob, carol, eve and the indexer;
// - <dir>/sandbox.json, which `"network": "sandbox"` in app.json reads, and <dir>/app.json to start from;
// - <dir>/fangorn, the fangorn CLI on the sandbox (AS=bob <dir>/fangorn … to publish as bob).
// Ctrl-C stops it. Each start is a fresh chain; old blocks on disk are harmless (content-addressed).

import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { privateKeyToAccount } from "viem/accounts";

const B32 = "abcdefghijklmnopqrstuvwxyz234567";
const b32 = (bytes) => {
    let out = "", v = 0, bits = 0;
    for (const b of bytes) { v = (v << 8) | b; bits += 8; while (bits >= 5) out += B32[(v >>> (bits -= 5)) & 31]; v &= (1 << bits) - 1; }
    return bits ? out + B32[(v << (5 - bits)) & 31] : out;
};
const unb32 = (s) => {
    const out = []; let v = 0, bits = 0;
    for (const c of s) { v = (v << 5) | B32.indexOf(c); bits += 5; if (bits >= 8) out.push((v >>> (bits -= 8)) & 255); v &= (1 << bits) - 1; }
    return Buffer.from(out);
};
// ponytail: CIDv1, base32, sha2-256 only, which is all the SDK makes. A block is kept under its digest,
// so a dag-cbor CID and the raw CID the SDK fetches it by find the same file.
export const digestOf = (cid) => /^b[a-z2-7]+$/.test(cid) ? unb32(cid.slice(1)).subarray(-32).toString("hex") : null;
const rawCid = (digest) => "b" + b32(Buffer.concat([Buffer.from([0x01, 0x55, 0x12, 0x20]), Buffer.from(digest, "hex")]));

/**
 * The hosted upload worker and gateway, locally: `POST /` is the worker's handshake (any signature
 * passes: ponytail, it's local), `POST /upload` takes the file, `GET /ipfs/<cid>` reads it back.
 */
export function storageServer({ dir, port = 0 }) {
    mkdirSync(dir, { recursive: true });
    const json = (res, code, v) => res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(v));
    const server = createServer(async (req, res) => {
        try {
            const chunks = [];
            for await (const c of req) chunks.push(c);
            const body = Buffer.concat(chunks);
            const origin = `http://${req.headers.host}`;
            if (req.method === "POST" && req.url === "/") {
                const { signature } = JSON.parse(body);
                return json(res, 200, signature ? { ok: true, uploadUrl: `${origin}/upload`, network: "public" } : { challenge: "sandbox" });
            }
            if (req.method === "POST" && req.url === "/upload") {
                const file = (await new Response(body, { headers: { "content-type": req.headers["content-type"] } }).formData()).get("file");
                const bytes = Buffer.from(await file.arrayBuffer());
                const digest = createHash("sha256").update(bytes).digest("hex");
                writeFileSync(join(dir, digest), bytes);
                return json(res, 200, { data: { cid: rawCid(digest) } });
            }
            const digest = req.method === "GET" && req.url.startsWith("/ipfs/") && digestOf(req.url.slice(6));
            if (digest) {
                let bytes; try { bytes = readFileSync(join(dir, digest)); }
                catch { return json(res, 404, { error: "not found" }); }
                return res.writeHead(200, { "access-control-allow-origin": "*" }).end(bytes); // a page on another port reads it
            }
            json(res, 404, { error: "not found" });
        } catch (e) { json(res, 500, { error: e.message }); }
    });
    return new Promise((ok) => server.listen(port, "127.0.0.1", () => {
        const url = `http://127.0.0.1:${server.address().port}`;
        ok({ worker: url, gateway: url, close: () => server.close() });
    }));
}

/** The sandbox an app.json with `"network": "sandbox"` runs on: `{ deployment, keys }`. */
export const readSandbox = (dir = ".sandbox") => JSON.parse(readFileSync(join(dir, "sandbox.json"), "utf8"));

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
    const dir = resolve(process.argv[2] ?? ".sandbox");
    process.env.FANGORN_CONTRACTS_DIR ??= fileURLToPath(new URL("../../contracts", import.meta.url));
    const { chainNetwork } = await import("@fangorn-network/sdk/lib/test/testbed.js"); // reads the env above
    const net = await chainNetwork();
    const storage = await storageServer({ dir: join(dir, "ipfs") });
    const keys = {};
    for (const who of ["alice", "bob", "carol", "eve", "indexer"]) keys[who] = await net.wallet();

    const { rpcUrl, dataRegistryContractAddress, settlementRegistryContractAddress } = net.config;
    const deployment = { rpcUrl, dataRegistryContractAddress, settlementRegistryContractAddress, fromBlock: "0",
                         signedUrlWorker: storage.worker, ipfsGateway: storage.gateway };
    writeFileSync(join(dir, "sandbox.json"), JSON.stringify({ deployment, keys }, null, 2));
    // The fangorn CLI, on the sandbox, as alice (or AS=bob …). It gets its own HOME, so it never picks up
    // ~/.fangorn (your real key and storage).
    const addr = (who) => privateKeyToAccount(keys[who]).address;
    mkdirSync(join(dir, "home"), { recursive: true });
    writeFileSync(join(dir, "fangorn"), [
        "#!/bin/sh",
        ...Object.entries(keys).map(([who, sk]) => `KEY_${who}=${sk}`),
        `eval "export ETH_PRIVATE_KEY=\\$KEY_\${AS:-alice}"`,
        `[ -n "$ETH_PRIVATE_KEY" ] || { echo "AS=\${AS}: one of ${Object.keys(keys).join(", ")}" >&2; exit 2; }`,
        `export HOME=${join(dir, "home")} CHAIN_NAME=baseSepolia FANGORN_RPC_URL=${rpcUrl}`,
        `export FANGORN_DATA_REGISTRY=${dataRegistryContractAddress} FANGORN_SETTLEMENT_REGISTRY=${settlementRegistryContractAddress}`,
        `export SIGNED_URL_WORKER_URL=${storage.worker} PINATA_GATEWAY=${storage.gateway}`,
        `exec fangorn "$@"`, "",
    ].join("\n"), { mode: 0o755 });
    // An indexer config to start from: alice's and bob's "shop".
    writeFileSync(join(dir, "app.json"), JSON.stringify({ publishers: [addr("alice"), addr("bob")], repos: ["shop"],
        network: "sandbox", sandbox: dir, db: join(dir, "index.db") }, null, 2));

    console.log(`sandbox up: chain ${rpcUrl}, storage ${storage.worker}`);
    for (const who of Object.keys(keys)) console.log(`  ${who.padEnd(8)} ${addr(who)}`);
    console.log(`\n  publish:  ${join(dir, "fangorn")} repo init shop   (AS=bob … to publish as bob)`);
    console.log(`  index:    node src/run.js ${join(dir, "app.json")}`);
    process.on("SIGINT", () => { net.stop(); storage.close(); process.exit(0); });
}
