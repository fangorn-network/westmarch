// A Fangorn network on this machine: anvil with the contracts built from source behind their
// proxies, a content-addressed store with an IPFS gateway over it, and (optionally) an encoder
// that answers as the Worker's AI binding does. What `westmarch-ship --devnet` and
// scripts/e2e-worker.mjs run an app against, with nothing leaving the machine.
//
// Needs forge and anvil, and the contracts' source (FANGORN_CONTRACTS_DIR, default
// ../contracts next to westmarch). USDC and Semaphore are the contracts' mocks: payments
// aren't checked and any proof is accepted.
//
// The services a deployment runs are here too, each its own Worker under `wrangler dev`, wired
// to this chain: `keyServer()` and `relay()` from the webworker checkout (FANGORN_WEBWORKER_DIR,
// default ../webworker), and `worker()` for any other, such as an app's.

import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestClient, encodeFunctionData, getAddress, http, parseEther, publicActions, walletActions } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { bytesToHex } from "viem";
import { DATA_REGISTRY_ABI, SETTLEMENT_REGISTRY_ABI, Fangorn, FangornConfig } from "@fangorn-network/sdk";

const HERE = dirname(fileURLToPath(import.meta.url));
const ADMIN_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";   // anvil's first account
/**
 * The Worker in `dir` under `wrangler dev` with `vars`, on a free port: `{ url, kill }` once `probe`
 * answers. Its own process group, so `kill` takes workerd down with wrangler. Local bindings only.
 */
export async function wranglerDev(dir, vars = {}, { config, probe = "/", name = dir, log = () => {} } = {}) {
    const free = () => new Promise((ok) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });
    // Its own inspector port too: two workers started at once both take wrangler's default (9229), and one dies.
    const [port, inspector] = await Promise.all([free(), free()]);
    const w = spawn("npx", ["wrangler", "dev", ...(config ? ["--config", config] : []), "--port", String(port), "--inspector-port", String(inspector), "--ip", "127.0.0.1",
        "--persist-to", mkdtempSync(join(tmpdir(), "devnet-wrangler-")), ...Object.entries(vars).flatMap(([k, v]) => ["--var", `${k}:${v}`])],
        { cwd: dir, detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NO_D1_WARNING: "true" } });
    let out = "";
    w.stdout.on("data", (c) => { out += c; }); w.stderr.on("data", (c) => { out += c; });
    const kill = () => { try { process.kill(-w.pid); } catch { /* gone */ } };
    process.on("exit", kill);
    const url = `http://127.0.0.1:${port}`;
    for (const t0 = Date.now(); ; await new Promise((r) => setTimeout(r, 500))) {
        if (w.exitCode !== null) throw new Error(`${name}: wrangler dev exited\n${out.slice(-2000)}`);
        if (Date.now() - t0 > 120_000) { kill(); throw new Error(`${name}: no answer at ${url}${probe} in 2 minutes\n${out.slice(-2000)}`); }
        if (await fetch(`${url}${probe}`).then(() => true, () => false)) break;
    }
    log(`${name} at ${url}`);
    return { url, kill };
}

const listen = (server) => new Promise((ok) => server.listen(0, "127.0.0.1", () => ok(`http://127.0.0.1:${server.address().port}`)));

export async function devnet({ contracts = process.env.FANGORN_CONTRACTS_DIR ?? resolve(HERE, "../../../contracts"),
                               webworker = process.env.FANGORN_WEBWORKER_DIR ?? resolve(HERE, "../../../webworker"), log = () => {} } = {}) {
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
    // `file`: the .sol it is in, when that isn't `n`.sol.
    const artifact = (n, file = n) => { const j = JSON.parse(readFileSync(`${contracts}/out/${file}.sol/${n}.json`, "utf8")); return { abi: j.abi, bytecode: j.bytecode.object }; };
    const deploy = async (n, args, file) => getAddress((await chain.waitForTransactionReceipt({ hash: await chain.deployContract({ account: admin, ...artifact(n, file), args }) })).contractAddress);
    const proxied = async (n, init) => deploy("ERC1967Proxy", [await deploy(n, []), init]);
    const data = await proxied("DataRegistry", encodeFunctionData({ abi: DATA_REGISTRY_ABI, functionName: "initialize", args: [admin.address] }));
    const usdc = await deploy("MockUSDC", [], "Mocks");
    const settlement = await proxied("SettlementRegistry", encodeFunctionData({ abi: SETTLEMENT_REGISTRY_ABI, functionName: "initialize",
        args: [admin.address, usdc, await deploy("MockSemaphore", [], "Mocks")] }));
    // As a Worker's CONFIG.deployment takes it: strings, no BigInt.
    const deployment = { dataRegistryContractAddress: data, settlementRegistryContractAddress: settlement, fromBlock: "0" };
    const config = { ...FangornConfig, ...deployment, fromBlock: 0n, rpcUrl };
    log(`anvil ${rpcUrl}, DataRegistry ${data}, SettlementRegistry ${settlement}`);

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

    /** A funded client. */
    const client = async (privateKey = generatePrivateKey()) => {
        await chain.setBalance({ address: privateKeyToAccount(privateKey).address, value: parseEther("1") });
        return Fangorn.create({ privateKey, config, storage: { backend } });
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

    // ── Workers, wired to this chain ─────────────────────────────────────────
    const worker = (dir, vars, opts) => wranglerDev(dir, vars, { log, ...opts }).then(({ url, kill }) => (kids.push({ kill }), url));

    /** The key server (fangorn-access-worker), with a fresh X25519 secret. */
    const keyServer = () => worker(join(webworker, "fangorn-access-worker"),
        { WORKER_X25519_SECRET: bytesToHex(crypto.getRandomValues(new Uint8Array(32))), SETTLEMENT_REGISTRY: settlement, RPC_URL: rpcUrl },
        { probe: "/pubkey", name: "key server" });

    /** Barliman, paying gas from a funded treasury key; `treasury` is the referrer on every register. */
    const relay = async (treasury = privateKeyToAccount(generatePrivateKey()).address) => {
        const key = generatePrivateKey();
        await chain.setBalance({ address: privateKeyToAccount(key).address, value: parseEther("10") });
        const url = await worker(join(webworker, "barliman"), { TREASURY_KEY: key, TREASURY: treasury, RPC_URL: rpcUrl,
            DATA_REGISTRY: data, SETTLEMENT_REGISTRY: settlement }, { probe: "/supported", name: "relay (Barliman)" });
        return { url, treasury };
    };

    return { rpcUrl, deployment, config, chain, usdc, backend, gatewayUrl, client, encoder, worker, keyServer, relay, stop, kids };
}
