#!/usr/bin/env node
// The publisher's CLI. Everything an app's publish UI does, with a local key.
//
// WHY THIS IS NOT IN AN APP
// -------------------------
// A publisher should not have to clone the app they are publishing to. The
// browser flow costs one file-picker click and one wallet confirmation PER FILE,
// which makes seeding a library impossible and publishing from a chat message
// impossible for the same reason — but the deeper problem is that it made the
// app's repo a dependency of publishing to it.
//
// So this is a CLIENT of the relay's HTTP surface and of nothing else. The only
// app-specific thing it needs is `ns` — the namespace folded into every
// resourceId — and the relay declares that itself, so a publisher needs a URL, a
// key, and a price.
//
//   PUBLISHER_PRIVATE_KEY=0x… westmarch-publish <relay> <path…> [flags]
//
//   --ns=name          app namespace. Defaults to what the relay declares.
//                      NEVER guessed: it is folded into every resourceId, so a
//                      wrong one mints ids nobody can buy from and orphans a
//                      library that already exists.
//   --dir=sub/folder   stage under this folder instead of the library root
//   --price=1000       USDC base units per file (default: the relay's)
//   --desc="…"         description for every file in this run
//   --catalog-only     publish as FREE catalog entries: committed to the graph,
//                      searchable, but never encrypted, uploaded or minted as a
//                      resource. One commitStateRoot covers a graph of any size,
//                      so this is what makes bulk ingest cost one transaction
//                      instead of one per file.
//   --register         send the one-time, fee-paying register() tx if needed
//   --setup            onboard only — terms and registration. Publishes nothing,
//                      and without --register sends nothing at all: it reports
//                      what is missing and what it would cost. Ends with one
//                      `SETUP <json>` line for a caller to parse.
//   --selfcheck        run the offline self-check and exit
//
// A description is the highest-signal thing a file carries — for an image it is
// the ONLY thing, since nothing in a JPEG's bytes says what it is. So per-file
// descriptions come from a `<file>.txt` sidecar when one exists (--desc is the
// fallback for the rest).
//
// The key comes from the environment and never from argv — argv is visible in
// `ps` to every process on the box.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { createPublicClient, createWalletClient, defineChain, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { encryptAndUpload } from "./settle.js";
import { resourceIdFor } from "./envelope.js";
import { newUid, readManifest, writeManifest } from "./manifest.js";

// ── argv ──────────────────────────────────────────────────────────────────────

const flags = {};
const args = [];
for (const a of process.argv.slice(2)) {
    const m = /^--([^=]+)(?:=([\s\S]*))?$/.exec(a);
    if (m) flags[m[1]] = m[2] ?? true;
    else args.push(a);
}

// ── file collection ───────────────────────────────────────────────────────────

/** Sidecars and dotfiles are not products. A `.txt` NEXT TO a file it describes
 *  is a caption; an orphan `.txt` is a document someone may want to sell. */
export const skip = (name, isSidecar) =>
    name.startsWith(".") || name.endsWith(".vtt") || isSidecar;

function collect(abs, root = abs) {
    const st = statSync(abs);
    if (st.isDirectory()) {
        return readdirSync(abs).sort().flatMap((n) => collect(join(abs, n), root));
    }
    const name = basename(abs);
    const described = name.endsWith(".txt") && existsSync(abs.slice(0, -4));
    if (skip(name, described)) return [];
    const rel = (root === abs ? name : relative(root, abs)).split(sep).join("/");
    return [{ abs, rel }];
}

/** `<file>.txt` beside the file, else --desc, else nothing. */
const descFor = (abs) => {
    const side = `${abs}.txt`;
    if (existsSync(side)) return readFileSync(side, "utf8").trim().slice(0, 2000);
    return typeof flags.desc === "string" ? flags.desc : null;
};

// ── relay client ──────────────────────────────────────────────────────────────

function client(relay) {
    let token = null;
    // Origin is sent explicitly and identically on every request: the relay
    // derives both the SIWE message's domain and the terms URL from it, so a
    // nonce issued under one origin and a terms acceptance under another would
    // sign two different documents.
    const headers = (extra = {}) => ({ Origin: relay, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra });
    const j = async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
        return body;
    };
    return {
        setToken: (t) => { token = t; },
        get: (path) => fetch(`${relay}${path}`, { headers: headers() }).then(j),
        post: (path, body) => fetch(`${relay}${path}`, {
            method: "POST", headers: headers({ "Content-Type": "application/json" }), body: JSON.stringify(body),
        }).then(j),
        prepare: (library) => fetch(`${relay}/api/publish/prepare`, {
            method: "POST", headers: headers({ "Content-Type": "application/json" }), body: JSON.stringify({ library }),
        }).then(j),
    };
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
    const [relayArg, ...paths] = args;
    if (!relayArg) {
        console.error("usage: PUBLISHER_PRIVATE_KEY=0x… westmarch-publish <relay> <path…> [--ns=] [--dir=] [--price=] [--desc=] [--register] [--setup]");
        process.exit(2);
    }
    const relay = relayArg.replace(/\/$/, "");

    const key = process.env.PUBLISHER_PRIVATE_KEY;
    if (!/^0x[0-9a-fA-F]{64}$/.test(key ?? "")) throw new Error("PUBLISHER_PRIVATE_KEY must be a 0x-prefixed 32-byte hex key (env only — never argv)");
    const account = privateKeyToAccount(key);
    const api = client(relay);

    const cfg = await api.get("/api/config");
    if (cfg.readOnly) throw new Error(`${relay} is read-only — it serves a published catalog but accepts no publishes. Point at the relay for the app you are publishing to.`);

    // Never defaulted, never guessed. `ns` is folded into every resourceId this
    // wallet mints, so the wrong one produces ids that address nobody's bytes and
    // a manifest key that reads back as an empty library.
    const ns = typeof flags.ns === "string" ? flags.ns : cfg.ns;
    if (!ns) throw new Error(`${relay} does not declare an app namespace (config.ns) — pass --ns=<name> explicitly, and be sure it is the one this app already publishes under`);

    const chain = defineChain({
        id: cfg.chainId,
        name: `chain-${cfg.chainId}`,
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        rpcUrls: { default: { http: [cfg.rpc] } },
    });
    const wallet = createWalletClient({ account, chain, transport: http(cfg.rpc) });
    const node = createPublicClient({ chain, transport: http(cfg.rpc) });
    const send = async (tx) => {
        const hash = await wallet.sendTransaction({ to: tx.to, data: tx.data, ...(tx.value ? { value: BigInt(tx.value) } : {}) });
        const rc = await node.waitForTransactionReceipt({ hash });
        if (rc.status !== "success") throw new Error(`tx reverted: ${hash}`);
        return hash;
    };

    // ── sign in ───────────────────────────────────────────────────────────────
    // This signature is also the rights attestation the relay appends to its log
    // before minting a session. Automating it does not make it mean less: the
    // key holder is asserting they are licensed to distribute what follows.
    const { nonce, message } = await api.post("/api/session/nonce", { address: account.address });
    const { token } = await api.post("/api/session", { nonce, signature: await account.signMessage({ message }) });
    api.setToken(token);
    console.log(`signed in as ${account.address} — publishing to ${relay} as "${ns}"`);

    // ── terms + registration ──────────────────────────────────────────────────
    let reg = await api.get("/api/registration");
    if (!reg.acceptedTerms) {
        const t = await api.get("/api/terms");
        await api.post("/api/terms/accept", { signature: await account.signMessage({ message: t.message }) });
        console.log(`accepted publisher terms (${t.hash.slice(0, 12)}…) — ${t.url}`);
        reg = await api.get("/api/registration");
    }
    if (!reg.registered) {
        // Registration costs a fee in ETH and is irreversible, so it is never
        // sent implicitly. Two txs, in the order the relay gave: global standing
        // in the data registry, then membership of this app. Both are needed —
        // commitStateRoot cross-calls the app registry, so stopping after the
        // first buys a revert at the end of the publish instead of an error here.
        const total = BigInt(reg.fee ?? 0) + BigInt(reg.appFee ?? 0);
        if (!flags.register) {
            if (!flags.setup) throw new Error(`${account.address} is not a registered publisher. Re-run with --register to send ${reg.txs.length} registration tx(s) (fee: ${total} wei), or register at https://fangorn.network`);
        } else {
            console.log(`registering as a publisher (${reg.txs.length} tx, fee ${total} wei)…`);
            for (const tx of reg.txs) await send(tx);
            reg = await api.get("/api/registration");
        }
    }

    // ── setup mode ────────────────────────────────────────────────────────────
    // Onboarding a publisher — terms, registration txs, and a bucket to put bytes
    // in — used to be reachable only by attempting a publish and reading the
    // error. A caller that wants to ASK "am I set up?" had nothing to call.
    //
    // Without --register it is a dry run: it says what is missing and what the
    // fees would be, and sends nothing. The last line is `SETUP <json>` so a
    // caller parses one line instead of scraping prose.
    if (flags.setup) {
        const state = { address: account.address, ns, registered: !!reg.registered, acceptedTerms: true };
        const w = await api.get("/api/worker").catch(() => null);
        // Null until this wallet is a registered publisher — the relay withholds
        // both, which is the only way storage can be "not ready" now.
        state.workerUrl = w?.workerUrl ?? null;
        state.storage = !!w?.workerUrl;
        if (!reg.registered) {
            state.fee = (BigInt(reg.fee ?? 0) + BigInt(reg.appFee ?? 0)).toString();
            state.txs = reg.txs?.length ?? 0;
        }
        console.log(`SETUP ${JSON.stringify(state)}`);
        return;
    }

    // ── stage ─────────────────────────────────────────────────────────────────
    const under = typeof flags.dir === "string" ? flags.dir.replace(/^\/+|\/+$/g, "") : "";
    const files = paths.flatMap((p) => collect(resolve(p)));
    if (paths.length && !files.length) throw new Error("nothing to upload — every path was a dotfile, a .vtt or a description sidecar");

    // The manifest lives in the bucket, not on the relay, so this client reads
    // it, edits it and writes it back. Both the worker and this wallet's upload
    // token come from the relay, which stores neither: the URL is its own config
    // and the token is derived from the address.
    const { workerUrl, uploadToken } = await api.get("/api/worker");
    if (!workerUrl) throw new Error(`${account.address} has no storage — it is not a registered Fangorn publisher yet (run with --setup --register, or sign up at https://fangorn.network)`);
    const store = { ns, workerUrl, uploadToken, owner: account.address };
    const manifest = await readManifest(store);

    for (const f of files) {
        const rel = under ? `${under}/${f.rel}` : f.rel;
        const entry = (manifest.files[rel] ??= { uid: newUid() });
        if (flags["catalog-only"]) entry.forSale = false;
        else if (flags.price) entry.price = String(flags.price);
        const desc = descFor(f.abs);
        if (desc) entry.desc = desc;

        // A free catalog entry is committed to the graph but never encrypted,
        // uploaded or minted — which is what makes bulk ingest cost one commit
        // instead of one createResource per file.
        if (entry.forSale === false) {
            console.log(`↑ ${rel} … ok (free entry)${desc ? " (described)" : ""}`);
            continue;
        }
        process.stdout.write(`↑ ${rel} … `);
        const out = await encryptAndUpload({
            file: f.abs, workerUrl, uploadToken,
            resourceId: entry.published?.resourceId ?? resourceIdFor(ns, account.address, entry.uid),
        });
        entry.published = { ...out, resourceId: entry.published?.resourceId, workerUrl, mime: entry.mime };
        // Written per file: a run that dies partway must not lose the pointers
        // already paid for in bandwidth.
        await writeManifest({ ...store, manifest });
        console.log(`ok${desc ? " (described)" : ""}`);
    }

    // ── publish ───────────────────────────────────────────────────────────────
    const library = Object.entries(manifest.files).map(([path, f]) => ({
        path, type: "video", uid: f.uid, price: f.price, mime: f.mime,
        desc: f.desc, forSale: f.forSale, cues: f.cues, published: f.published,
    }));
    const prep = await api.prepare(library);

    for (const [i, c] of prep.creates.entries()) {
        console.log(`createResource ${i + 1}/${prep.creates.length} — ${c.path}`);
        await send(c);
    }

    // No vectors. A publisher builds and publishes the graph; embedding is not
    // its job and never was. The commit route still takes a `vectors` map because
    // an app's own browser flow may fill it, and an empty one is the ordinary
    // case, not a degraded one.
    // The pin is authorized by the publisher's own signature against their own
    // storage quota. The challenge carries an Issued-At the gate only honours for
    // a few minutes, so it is fetched here and not at the start of the run.
    //
    // `storageGate: null` is not a broken relay — it is one pinning directly on
    // its own account, which ignores storageAuth entirely. Asking a gate that
    // isn't there for a challenge failed a publish the relay would have accepted,
    // and blamed a service that was never in the path.
    let storageAuth;
    if (cfg.storageGate) {
        const gate = await fetch(cfg.storageGate, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ address: account.address, size: 1 }),
        }).then((r) => r.json()).catch(() => ({}));
        if (!gate.challenge) throw new Error(`storage gate issued no challenge — ${cfg.storageGate} may be down`);
        storageAuth = { message: gate.challenge, signature: await account.signMessage({ message: gate.challenge }) };
    } else {
        console.log("relay pins on its own account — no storage gate to authorize against");
    }

    const sealed = await api.post("/api/publish/commit", { vectors: {}, storageAuth });
    console.log("commitStateRoot…");
    await send(sealed.commitTx);
    for (const [path, ptr] of Object.entries(sealed.published)) {
        manifest.files[path].published = { ...(manifest.files[path].published ?? {}), ...ptr };
    }
    await writeManifest({ ...store, manifest });
    await api.post("/api/settle", {});

    const { vertices, edges } = sealed.staged;
    console.log(`published — ${vertices} vertices, ${edges} edges`);
    for (const [path, ptr] of Object.entries(sealed.published)) console.log(`  ${path}  ${ptr.resourceId}`);
}

// ── self-check: `node publish/cli.js --selfcheck` (offline) ──────────────────

if (flags.selfcheck) {
    const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

    // Collection: sidecars are descriptions, not products; a .txt with no file
    // beside it still sells; nested paths keep their shape.
    const here = new Set(["/lib/a.jpg", "/lib/notes.txt", "/lib/sub/b.mp3"]);
    const survives = (name, abs) => !skip(name, name.endsWith(".txt") && here.has(abs.slice(0, -4)));
    assert(survives("a.jpg", "/lib/a.jpg"), "a real file was skipped");
    assert(!survives("a.jpg.txt", "/lib/a.jpg.txt"), "a description sidecar was published as a file");
    assert(survives("notes.txt", "/lib/notes.txt"), "an orphan .txt should publish as a text file");
    assert(!survives(".hidden", "/lib/.hidden"), "a dotfile was published");
    assert(!survives("c.mp4.vtt", "/lib/c.mp4.vtt"), "a .vtt was published — /api/upload rejects these");

    // A read-only relay and a relay that declares no namespace must both fail
    // BEFORE anything is signed, uploaded or sent — and say which it was.
    const real = globalThis.fetch;
    const runAgainst = async (config) => {
        globalThis.fetch = async (url) => String(url).endsWith("/api/config")
            ? { ok: true, json: async () => config }
            : { ok: false, json: async () => ({ error: "should never be reached" }) };
        process.env.PUBLISHER_PRIVATE_KEY = `0x${"11".repeat(32)}`;
        args.length = 0; args.push("http://relay", "/tmp");
        return main().then(() => "no error", (e) => e.message);
    };
    try {
        assert(/read-only/.test(await runAgainst({ readOnly: true })), "a read-only relay must be refused by name");
        assert(/namespace/.test(await runAgainst({ chainId: 1, rpc: "http://r" })), "a relay declaring no ns must be refused, not guessed at");
    } finally { globalThis.fetch = real; delete process.env.PUBLISHER_PRIVATE_KEY; }

    console.log("cli.js self-check ok — sidecars, read-only relay refused, missing ns refused");
} else {
    await main().catch((e) => { console.error(`✗ ${e.message}`); process.exit(1); });
}
