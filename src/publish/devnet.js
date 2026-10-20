// A Fangorn network on this machine: anvil with the contracts built from source behind their
// proxies, a content-addressed store with an IPFS gateway over it, and (optionally) an encoder
// that answers as the Worker's AI binding does. What `westmarch-ship --devnet` and
// scripts/e2e-worker.mjs run an app against, with nothing leaving the machine.
//
// Needs forge and anvil, and the contracts' source (FANGORN_CONTRACTS_DIR, default
// ../contracts/solidity next to westmarch).

import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestClient, encodeFunctionData, getAddress, http, parseEther, publicActions, walletActions } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { APP_REGISTRY_ABI, DATA_REGISTRY_ABI, Fangorn, FangornConfig } from "@fangorn-network/sdk";

const HERE = dirname(fileURLToPath(import.meta.url));
const ADMIN_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";   // anvil's first account
const listen = (server) => new Promise((ok) => server.listen(0, "127.0.0.1", () => ok(`http://127.0.0.1:${server.address().port}`)));

export async function devnet({ contracts = process.env.FANGORN_CONTRACTS_DIR ?? resolve(HERE, "../../../contracts/solidity"), log = () => {} } = {}) {
    const kids = [], servers = [];
    const stop = () => { for (const k of kids) k.kill(); for (const s of servers) s.close(); };
    process.on("exit", stop);

    // ── chain ─────────────────────────────────────────────────────────────────
    if (spawnSync("forge", ["build"], { cwd: contracts, stdio: ["ignore", "ignore", "inherit"] }).status !== 0) throw new Error(`forge build failed in ${contracts}`);
    const anvil = spawn("anvil", ["--port", "0", "--host", "127.0.0.1", "--chain-id", String(FangornConfig.chain.id)], { stdio: ["ignore", "pipe", "inherit"] });
    kids.push(anvil);
    const rpcUrl = await new Promise((ok) => { let out = ""; anvil.stdout.on("data", (c) => { out += c; const m = /Listening on (\S+)/.exec(out); if (m) ok(`http://${m[1]}`); }); });
    const chain = createTestClient({ mode: "anvil", chain: FangornConfig.chain, transport: http(rpcUrl) }).extend(publicActions).extend(walletActions);
    const admin = privateKeyToAccount(ADMIN_KEY);
    const artifact = (n) => { const j = JSON.parse(readFileSync(`${contracts}/out/${n}.sol/${n}.json`, "utf8")); return { abi: j.abi, bytecode: j.bytecode.object }; };
    const deploy = async (n, args) => getAddress((await chain.waitForTransactionReceipt({ hash: await chain.deployContract({ account: admin, ...artifact(n), args }) })).contractAddress);
    const proxied = async (n, init) => deploy("ERC1967Proxy", [await deploy(n, []), init]);
    const apps = await proxied("AppRegistry", encodeFunctionData({ abi: APP_REGISTRY_ABI, functionName: "initialize",
        args: [admin.address, "0x000000000000000000000000000000000000dEaD", 0n, 30n * 24n * 3600n] }));
    const data = await proxied("DataRegistry", encodeFunctionData({ abi: DATA_REGISTRY_ABI, functionName: "initialize", args: [admin.address, apps] }));
    await chain.waitForTransactionReceipt({ hash: await chain.writeContract({ account: admin, address: apps, abi: APP_REGISTRY_ABI, functionName: "setDataRegistry", args: [data] }) });
    // As a Worker's CONFIG.deployment takes it: strings, no BigInt.
    const deployment = { appRegistryContractAddress: apps, dataRegistryContractAddress: data, appRegistryFromBlock: "0" };
    const config = { ...FangornConfig, ...deployment, appRegistryFromBlock: 0n, rpcUrl };
    log(`anvil ${rpcUrl}, AppRegistry ${apps}, DataRegistry ${data}`);

    // ── storage: a content-addressed store, and the gateway that serves it ────
    // multiformats, from the SDK's own dependencies.
    const sdk = createRequire(createRequire(import.meta.url).resolve("@fangorn-network/sdk"));
    const [{ CID }, { sha256 }, raw] = await Promise.all(["multiformats/cid", "multiformats/hashes/sha2", "multiformats/codecs/raw"].map((m) => import(sdk.resolve(m))));
    const store = new Map();   // multihash hex → bytes
    const key = (cid) => Buffer.from(CID.parse(String(cid).replace(/^ipfs:\/\//, "")).multihash.bytes).toString("hex");
    const unused = async () => { throw new Error("unused"); };
    const backend = {
        putBlock: async (b) => { store.set(key(b.cid), b.bytes); },
        putFile: async (bytes) => { const cid = CID.createV1(raw.code, await sha256.digest(bytes)); store.set(key(cid), bytes); return `ipfs://${cid}`; },
        getFile: async (uri) => store.get(key(uri)) ?? Promise.reject(new Error(`no ${uri}`)),
        getRawBlock: async (uri) => store.get(key(uri)) ?? Promise.reject(new Error(`no ${uri}`)),
        put: unused, putMany: unused, get: unused, delete: async () => {},
    };
    const gateway = createServer((req, res) => {
        try { const b = store.get(key(req.url.replace(/^\/ipfs\//, ""))); if (!b) throw 0; res.end(Buffer.from(b)); }
        catch { res.statusCode = 404; res.end(); }
    });
    servers.push(gateway);
    const gatewayUrl = await listen(gateway);

    /** A funded publisher, under `app` (or none). */
    const client = async (app, privateKey = generatePrivateKey()) => {
        await chain.setBalance({ address: privateKeyToAccount(privateKey).address, value: parseEther("1") });
        return Fangorn.create({ privateKey, config, appId: app, storage: { backend } });
    };

    /** An encoder on localhost that answers as the AI binding does: POST {text} → {data}; GET → the embedder it is. */
    const encoder = async () => {
        const [{ embedRaw, EMBED_MODEL, EMBED_DTYPE }, { env }] = await Promise.all([import("../core/embed.js"), import("@huggingface/transformers")]);
        env.cacheDir = `${process.env.HOME}/.cache/fangorn-mcp/models`;
        const embedder = JSON.stringify({ runtime: "transformers.js", model: EMBED_MODEL, dtype: EMBED_DTYPE });
        // One at a time: the Worker sends several batches at once, and the model runs one.
        let queue = Promise.resolve();
        const server = createServer((req, res) => {
            if (req.method === "GET") return res.end(embedder);
            let body = "";
            req.on("data", (c) => { body += c; });
            req.on("end", () => { queue = queue.then(async () => {
                try { res.end(JSON.stringify({ data: await embedRaw(JSON.parse(body).text) })); }
                catch (e) { res.statusCode = 500; res.end(String(e.message)); }
            }); });
        });
        servers.push(server);
        return listen(server);
    };

    return { rpcUrl, deployment, config, chain, backend, gatewayUrl, client, encoder, stop, kids };
}
