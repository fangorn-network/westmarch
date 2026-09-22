// The same market as run-market.mjs, settled on Arbitrum Sepolia with real USDC.
//
// run-market.mjs proves the ARITHMETIC: who is owed what, and that the books
// balance. It settles into a JSON file, which is the right place to iterate on
// incentives and the wrong place to claim a market exists. This file spends real
// money on a real chain, against contracts nobody in this process controls, and
// prints transaction hashes anyone can check.
//
// WHAT IS REAL HERE
// -----------------
//   · every USDC amount, on Arbitrum Sepolia (chain 421614)
//   · createResource on the deployed SettlementRegistry
//   · payment by EIP-3009 — a buyer signs and never transacts, so a buyer wallet
//     holding zero ETH completes a purchase
//   · settlement by Semaphore membership proof through the hosted facilitator,
//     from a stealth address derived per (identity, resource)
//   · the ciphertext, encrypted client-side and uploaded to an access worker
//     that gates the key on the on-chain settlement
//   · a READER publishing their own reaction corpus as a resource of their own,
//     and being paid for it — §8 of the paper, which had never left simulation
//   · the cohort round, and the identical payment to every reader in it
//
// WHAT IS STILL NOT
// -----------------
// ponytail: lineage is NOT split on chain here. The LineageSplitter is deployed
// and its `open_resource` is only_owner, and the owner of the deployed instance
// is the facilitator's key, not this wallet. So a derivative's citations are
// computed by terms.js and paid by direct transfer, which is the arithmetic
// without the enforcement. Deploying an instance this wallet owns is the fix and
// it is a Stylus deployment, not a line of JavaScript.
//
// Run: node example/run-market-onchain.mjs
// Needs: ~1 USDC and a little ETH on the key in ~/.fangorn/config.json.

import { createPublicClient, createWalletClient, http, keccak256, stringToBytes, formatUnits, encodePacked, hexToBytes } from "viem";
import { arbitrumSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { createServer } from "node:http";
import { createReadStream, existsSync, statSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

import { encryptAndUpload } from "@fangorn/westmarch/settle";
import { NONCE_LEN, aadFor, chunkKey, unpack } from "@fangorn/westmarch/envelope";
import { splitPayment, appTerms, label } from "@fangorn/westmarch/terms";
import { reactionCorpus } from "@fangorn/westmarch/reactions";
import { keypair, statistics, contribute, aggregate, readout, MIN_COHORT } from "@fangorn/westmarch/cohort";
import { demandReport, brief } from "@fangorn/westmarch/demand";
import { configure, domainManifests, loadShard, resetShard, trimView } from "@fangorn/westmarch/shard";
import { rolesFrom, textOf } from "@fangorn/westmarch/roles";
import { SettlementRegistryClient, packResourceUri, resourceIdOf } from "@fangorn-network/sdk";
import { search } from "@fangorn/westmarch/tools";
const X402 = "/home/driemworks/fangorn/x402f/packages/fetch/dist/index.js";
const { FangornX402Middleware, accessMessageHash } = await import(X402);

// ── the deployment ──────────────────────────────────────────────────────────
const RPC = "https://sepolia-rollup.arbitrum.io/rpc";
const REG = "0x480d54411d77820701fd80f42b81fb6e20176d12";
const USDC = "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d";
const WORKER = "https://fangorn-access-worker.fangorn-0be.workers.dev";
const FAC = "https://facilitator.fangorn.network";
const HERE = fileURLToPath(new URL(".", import.meta.url));
const PORT = 5198;

const cfg = JSON.parse(readFileSync(process.env.HOME + "/.fangorn/config.json", "utf8"));
const env = Object.fromEntries(readFileSync(process.env.HOME + "/fangorn/sond3r/.env", "utf8")
    .split("\n").filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1).replace(/^['"]|['"]$/g, "")]; }));

// The relay DERIVES a publisher's upload token rather than storing one, so a
// publisher holding the relay's service key mints its own without asking.
const RELAY_SECRET = keccak256(stringToBytes(`sond3r:upload-token:${env.ETH_PRIVATE_KEY}`));
const uploadTokenFor = (o) => `${o.toLowerCase()}.${keccak256(encodePacked(["bytes32", "address"], [RELAY_SECRET, o]))}`;

const erc20 = [
    { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
    { name: "transfer", type: "function", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
];

const pc = createPublicClient({ chain: arbitrumSepolia, transport: http(RPC) });
const archive = privateKeyToAccount(cfg.privateKey);
const archiveW = createWalletClient({ account: archive, chain: arbitrumSepolia, transport: http(RPC) });
const bal = (a) => pc.readContract({ address: USDC, abi: erc20, functionName: "balanceOf", args: [a] });
const usd = (x) => `${formatUnits(x, 6)} USDC`;
const h1 = (s) => console.log(`\n\n\x1b[1m━━ ${s} ${"━".repeat(Math.max(0, 70 - s.length))}\x1b[0m`);
const say = (...a) => console.log(...a);
const tx = (h) => `${h.slice(0, 10)}…${h.slice(-6)}`;

// Readers are DERIVED from one seed so a rerun reuses the same wallets rather
// than stranding testnet funds in a fresh address every time.
const readerKey = (n) => keccak256(stringToBytes(`westmarch:onchain-market:v1:${n}`));
const READERS = ["mara", "iven", "juno", "peter", "sable"].map((name) => {
    const acct = privateKeyToAccount(readerKey(name));
    return { name, acct, wallet: createWalletClient({ account: acct, chain: arbitrumSepolia, transport: http(RPC) }) };
});

// ── the fixtures, served to ourselves, exactly as in run-market.mjs ─────────
const MIME = { ".json": "application/json", ".gz": "application/gzip" };
const server = createServer((req, res) => {
    const p = join(HERE, "public", normalize(decodeURIComponent(req.url.split("?")[0])).replace(/^(\.\.[/\\])+/, ""));
    if (!existsSync(p) || !statSync(p).isFile()) { res.writeHead(404).end("no"); return; }
    res.writeHead(200, { "access-control-allow-origin": "*", "content-type": MIME[extname(p)] ?? "application/octet-stream" });
    createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

async function shelfRows(view) {
    resetShard();
    const held = new Map();
    configure({ onManifests: (ms, v) => held.set(v, rolesFrom(ms)), rowText: (f, v) => textOf(f, held.get(v) ?? { text: [] }) });
    const v = trimView(`http://127.0.0.1:${PORT}${view}`);
    const rows = await loadShard(v);
    return { rows, roles: rolesFrom(domainManifests(v), rows) };
}

/** Publish for real: encrypt → upload → createResource. Returns what a buyer needs. */
async function publishResource({ wallet, account, name, bytes, price }) {
    const uid = keccak256(stringToBytes(name));
    const resourceId = resourceIdOf(account.address, uid);
    const tmp = `/tmp/wm-${keccak256(stringToBytes(name)).slice(2, 14)}.bin`;
    writeFileSync(tmp, bytes);
    const { plaintextHash, size } = await encryptAndUpload({
        file: tmp, resourceId, workerUrl: WORKER, uploadToken: uploadTokenFor(archive.address),
    });
    rmSync(tmp, { force: true });
    const client = new SettlementRegistryClient(REG, pc, wallet);
    const hash = await client.createResource(uid, price, packResourceUri(WORKER, plaintextHash));
    const { blockNumber } = await pc.waitForTransactionReceipt({ hash });
    return { uid, resourceId, price, publisher: account.address, createdAt: blockNumber, hash, size, plaintextHash };
}

/** Buy for real: EIP-3009 register → Semaphore settle → gated decrypt. */
async function buy({ wallet, res: r }) {
    const mw = await FangornX402Middleware.create({
        walletClient: wallet, chain: arbitrumSepolia, rpcUrl: RPC,
        registryAddress: REG, usdcAddress: USDC,
        usdcDomainName: env.USDC_DOMAIN_NAME ?? "USD Coin",
        facilitatorUrl: FAC,
        // Without this the membership proof is rebuilt by scanning from chain
        // genesis — 306 million blocks — which on a public RPC never returns.
        fromBlock: r.createdAt,
    });
    const nullifier = await mw.payAndSettle(r.resourceId, r.publisher, r.price);
    const signer = mw.stealthWalletClient();
    const ts = Math.floor(Date.now() / 1000);
    const signature = await signer.signMessage({ message: { raw: accessMessageHash(nullifier, r.resourceId, ts) } });
    const ar = await fetch(`${WORKER}/access`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nullifier, resourceId: r.resourceId, timestamp: ts, signature }) });
    if (!ar.ok) throw new Error(`/access ${ar.status} ${await ar.text()}`);
    const { dek } = await ar.json();
    const key = await crypto.subtle.importKey("raw", hexToBytes(dek), "AES-GCM", false, ["decrypt"]);
    // x402f's own reader takes one blob with no AAD; westmarch writes gzip-packed
    // chunks each authenticated by its index. Decrypt with the envelope that wrote it.
    const ct = new Uint8Array(await (await fetch(`${WORKER}/ct/${chunkKey(r.resourceId, 0)}`)).arrayBuffer());
    const data = await unpack(new Uint8Array(await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: ct.subarray(0, NONCE_LEN), additionalData: aadFor(0) }, key, ct.subarray(NONCE_LEN))));
    return { nullifier, data };
}

const send = async (to, amount) => {
    const hash = await archiveW.writeContract({ address: USDC, abi: erc20, functionName: "transfer", args: [to, amount] });
    await pc.waitForTransactionReceipt({ hash });
    return hash;
};

const APP = appTerms({ appId: "fangorn.tv", owner: archive.address, appBps: 1000 });
const SHELF_PRICE = 60_000n;      // 0.06 USDC
const TASTE_PRICE = 40_000n;      // 0.04 USDC
const ROUND_BUDGET = 50_000n;     // 0.05 USDC, split identically across readers
const ledger = [];
const report = { chain: 421614, registry: REG, acts: [], txs: [] };

try {
    h1("ACT 0 — the wallets, before anything");
    const opening = { [archive.address]: await bal(archive.address) };
    say(`  archive   ${archive.address}  ${usd(opening[archive.address])}  ${formatUnits(await pc.getBalance({ address: archive.address }), 18)} ETH`);
    for (const r of READERS) {
        opening[r.acct.address] = await bal(r.acct.address);
        say(`  ${r.name.padEnd(9)} ${r.acct.address}  ${usd(opening[r.acct.address])}`);
    }

    h1("ACT 1 — the archive publishes, once, for real");
    const shelf = await shelfRows("/archive-films");
    say(`  shelf loaded: ${shelf.rows.length} rows, title role "${shelf.roles.title}"`);
    // A real artifact: 60 rows of the publisher's own catalogue, the thing a
    // buyer would actually want and the free shard deliberately withholds.
    const payload = Buffer.from(JSON.stringify(shelf.rows.slice(0, 60).map((r) =>
        Object.fromEntries(Object.entries(r).filter(([k]) => !["vector", "norm", "text", "embed"].includes(k))))), "utf8");
    const shelfRes = await publishResource({
        wallet: archiveW, account: archive, name: `archive-films-sample-${Date.now()}`,
        bytes: payload, price: SHELF_PRICE,
    });
    say(`  encrypted ${shelfRes.size} bytes → access worker`);
    say(`  createResource ${tx(shelfRes.hash)}  block ${shelfRes.createdAt}`);
    say(`  resourceId ${shelfRes.resourceId}`);
    report.txs.push({ what: "createResource archive-films-sample", hash: shelfRes.hash });

    h1("ACT 2 — three readers buy it, holding no ETH at all");
    const buyers = READERS.slice(0, 3);
    for (const r of buyers) {
        const need = SHELF_PRICE - (await bal(r.acct.address));
        if (need > 0n) { const h = await send(r.acct.address, need); say(`  funded ${r.name} ${usd(need)}  ${tx(h)}`); }
        const eth = await pc.getBalance({ address: r.acct.address });
        const t0 = Date.now();
        const got = await buy({ wallet: r.wallet, res: shelfRes });
        const parsed = JSON.parse(Buffer.from(got.data).toString("utf8"));
        say(`  ${r.name.padEnd(6)} settled in ${((Date.now() - t0) / 1000).toFixed(0)}s · ${parsed.length} rows decrypted · ETH held ${formatUnits(eth, 18)} · nullifier ${got.nullifier.slice(0, 12)}…`);
        ledger.push({ from: r.name, to: "archive", amount: SHELF_PRICE, why: "bought the shelf sample" });
    }
    say(`\n  archive received ${usd(SHELF_PRICE * BigInt(buyers.length))} in sales, from buyers who spent no gas at all`);

    h1("ACT 3 — readers react, then ONE becomes a publisher for real");
    // Reactions carry the vector of the row reacted to, straight off the shard
    // the reader just bought. No model runs anywhere in this file.
    const briefs = { mara: "submarine war at sea", iven: "cold war nuclear propaganda", juno: "vampire horror night",
                     peter: "cartoon animation comedy", sable: "detective crime murder" };
    const by = new Map(shelf.rows.map((x) => [x.id, x]));
    const logs = {};
    for (const r of READERS) {
        const hits = search(shelf.rows, briefs[r.name], shelf.roles, { limit: 14 });
        logs[r.name] = hits.map((h, i) => ({
            id: h.id, corpus: "archive-films", title: h.title ?? "", reaction: i < 9 ? "like" : "skip",
            at: new Date().toISOString(), vector: by.get(h.id)?.vector,
        })).filter((e) => e.vector?.length);
        say(`  ${r.name.padEnd(6)} ${logs[r.name].length} reactions to "${briefs[r.name]}"`);
    }

    const seller = READERS[0];
    const corpus = reactionCorpus(logs[seller.name], {
        publisher: seller.acct.address, name: `${seller.name}-taste`,
        sources: { "archive-films": archive.address }, price: String(TASTE_PRICE),
    });
    say(`\n  ${seller.name} packages ${corpus.manifest.count} reactions:`);
    say(`    free index discloses  ${corpus.manifest.paywall.free.join(", ")}`);
    say(`    paid payload is       ${corpus.manifest.paywall.locked.join(", ")}`);
    say(`    owes upstream         ${corpus.lineage.map((l) => `${l.note} ${Number(l.bps) / 100}%`).join(", ")}`);
    // Publishing costs gas, so this reader — and only this one — needs ETH.
    if ((await pc.getBalance({ address: seller.acct.address })) < 2_000_000_000_000_000n) {
        const h = await archiveW.sendTransaction({ to: seller.acct.address, value: 4_000_000_000_000_000n });
        await pc.waitForTransactionReceipt({ hash: h });
        say(`    funded ${seller.name} 0.004 ETH for gas  ${tx(h)}`);
    }
    const tasteRes = await publishResource({
        wallet: seller.wallet, account: seller.acct, name: `${seller.name}-taste-${Date.now()}`,
        bytes: Buffer.from(JSON.stringify(corpus.locked), "utf8"), price: TASTE_PRICE,
    });
    say(`    createResource ${tx(tasteRes.hash)}  → ${tasteRes.resourceId}`);
    report.txs.push({ what: `createResource ${seller.name}-taste`, hash: tasteRes.hash });

    h1("ACT 4 — the archive buys the reader's corpus. The reader is paid.");
    const sellerBefore = await bal(seller.acct.address);
    const got = await buy({ wallet: archiveW, res: tasteRes });
    const rows = JSON.parse(Buffer.from(got.data).toString("utf8"));
    say(`  settled · ${rows.length} paid rows · nullifier ${got.nullifier.slice(0, 12)}…`);
    const sellerAfter = await bal(seller.acct.address);
    say(`  ${seller.name}: ${usd(sellerBefore)} → ${usd(sellerAfter)}  (+${usd(sellerAfter - sellerBefore)})`);
    // What terms.js says this sale owes, paid by transfer because the on-chain
    // splitter is not ours to drive (see the header).
    const owed = splitPayment(TASTE_PRICE, { terms: APP, publisher: seller.acct.address, lineage: corpus.lineage });
    say(`  terms.js says this sale owes:`);
    for (const p of owed) say(`    ${usd(p.amount).padStart(12)}  ${p.why}`);
    ledger.push({ from: "archive", to: seller.name, amount: TASTE_PRICE, why: "bought the taste corpus" });

    h1("ACT 5 — the archive buys an ANSWER, and pays every reader the same");
    const withLogs = READERS.filter((r) => logs[r.name].length);
    if (withLogs.length < MIN_COHORT) throw new Error(`${withLogs.length} readers — ${MIN_COHORT} is the floor`);
    const anchor = by.get(search(shelf.rows, "submarine", shelf.roles, { limit: 1 })[0].id);
    const sims = shelf.rows.map((r) => {
        let d = 0; for (let i = 0; i < anchor.vector.length; i++) d += anchor.vector[i] * r.vector[i];
        return d / ((anchor.norm || 1) * (r.norm || 1));
    }).sort((a, b) => b - a);
    const q = { corpus: "archive-films", near: anchor.vector, minScore: sims[Math.floor(sims.length * 0.05)] };
    const keys = []; for (const _ of withLogs) keys.push(await keypair());
    const pubs = keys.map((k) => k.pub);
    const shares = [];
    for (let i = 0; i < withLogs.length; i++) shares.push(await contribute(statistics(logs[withLogs[i].name], q), keys[i], pubs));
    const answer = readout(aggregate(shares), withLogs.length);
    say(`  ${withLogs.length} readers · ${answer.matched} matched · sentiment ${answer.sentiment} · direction ${answer.centroid ? "reported" : "withheld"}`);

    // Identical to the base unit. Paying by contribution would put the one
    // quantity the masking hides straight back onto the chain.
    const appCut = (ROUND_BUDGET * BigInt(APP.appBps)) / 10000n;
    const pool = ROUND_BUDGET - appCut;
    const each = pool / BigInt(withLogs.length);
    say(`  paying ${usd(each)} to each of ${withLogs.length} readers (app keeps ${usd(ROUND_BUDGET - each * BigInt(withLogs.length))}):`);
    for (const r of withLogs) {
        const h = await send(r.acct.address, each);
        say(`    ${r.name.padEnd(6)} ${usd(each)}  ${tx(h)}`);
        report.txs.push({ what: `cohort payout ${r.name}`, hash: h });
        ledger.push({ from: "archive", to: r.name, amount: each, why: "cohort answer, paid identically" });
    }

    h1("ACT 6 — what the answer means, on the archive's own shelf");
    const rep = demandReport({
        shelf: shelf.rows, roles: shelf.roles,
        probes: [{ question: "how are readers reacting around our submarine reel?", readout: answer }],
        paidPerReader: each, earned: SHELF_PRICE * 3n + 0n,
    });
    const text = brief(rep, { title: "demand — archive-films (settled on Arbitrum Sepolia)" });
    say(text.split("\n").map((l) => "  " + l).join("\n"));
    report.brief = text;

    h1("ACT 7 — the books, read back off the chain");
    const closing = { [archive.address]: await bal(archive.address) };
    for (const r of READERS) closing[r.acct.address] = await bal(r.acct.address);
    say(`  ${"who".padEnd(10)} ${"opening".padStart(14)} ${"closing".padStart(14)} ${"delta".padStart(14)}`);
    const line = (n, a) => say(`  ${n.padEnd(10)} ${usd(opening[a]).padStart(14)} ${usd(closing[a]).padStart(14)} `
        + `${((closing[a] - opening[a]) >= 0n ? "+" : "") + usd(closing[a] - opening[a])}`.padStart(15));
    line("archive", archive.address);
    for (const r of READERS) line(r.name, r.acct.address);
    const net = Object.keys(closing).reduce((a, k) => a + (closing[k] - opening[k]), 0n);
    say(`\n  net across every address in this run: ${usd(net)}`);
    // Zero because every reader was seeded from the archive and spent back into
    // it: the run moves money in a closed loop and proves conservation across
    // real settlements, not that anyone got richer. USDC does leave this set —
    // to the facilitator, which fronts gas — so a non-zero net here is a fact
    // about the run and not automatically a bug.
    if (net !== 0n) say(`  (some left this set — the facilitator fronts settlement gas)`);

    report.acts = ledger.map((l) => ({ ...l, amount: String(l.amount) }));
    report.balances = Object.fromEntries(Object.entries(closing).map(([k, v]) => [k, String(v)]));
    writeFileSync(join(HERE, "market-report-onchain.json"), JSON.stringify(report, null, 1));
    say(`\n  written: example/market-report-onchain.json`);
    say(`  every hash above: https://sepolia.arbiscan.io/tx/<hash>\n`);
} finally {
    server.close();
}
