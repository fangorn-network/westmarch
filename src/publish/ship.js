#!/usr/bin/env node
// westmarch-ship: one config, one command, a live Fangorn app on the free tier.
//
//   westmarch-ship app.json [--no-crawl] [--no-deploy] [--dry-run]
//   westmarch-ship app.json --local <out> [--crawl]     a view from staged records, no chain (see buildLocal)
//   westmarch-ship app.json --register                  the app alone: claim, empty site, card bound
//   westmarch-ship app.json --devnet [--only …]         the whole app on this machine (see devnetShip)
//   westmarch-ship app.json --index                     the deployed app's indexer, once, here (see indexHere)
//
// The app is one Cloudflare Worker (site/worker.js): its indexer (a cron that runs the
// embedding lens over everything the app presents, into R2), its view, its MCP endpoint
// (/mcp) and its site. Nothing is embedded here. Every step checks the chain (or
// Cloudflare) first and only acts on a difference, so re-running is how you update.
//
//   1. claim the app (first run only; the claim block becomes the card's fromBlock).
//      The claimer is the app's first member, so its own updates are accepted.
//   2. run each source, which crawls and publishes straight into the app
//   3. the stock page, the card and _headers → .ship/site
//   4. deploy the Worker: its R2 bucket, Workers AI, the cron, CONFIG (app.json's schema rides in it)
//   5. register the ERC-8004 agent and bind the card, if the chain points elsewhere
//
// The Worker picks up what 2 published on its next cron run (every few minutes),
// so the view follows the chain with nobody running anything.
//
// --register is the fast path, run before there is any data: 1, 3, 4 and 5 binding the card
// without minting. The mint copies the card's skills into its IPFS registration file and is
// never redone, so it waits for the first full ship, when the card lists what the app does.
//
// Chain writes go through the `fangorn` CLI (its configured wallet signs, and
// `fangorn wallet` shows which). Reads go through the SDK. State lives in `.ship/` next
// to app.json: the site, the Worker's config and a small state.json.

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// USDC per x402 network (CAIP-2): its address and EIP-712 domain, as each contract reports them.
// They differ: Base Sepolia's is "USDC", Base's "USD Coin", and a payment signed under the wrong
// one fails at the facilitator.
const USDC = {
    "eip155:84532": { asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", name: "USDC", version: "2" },
    "eip155:8453": { asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", name: "USD Coin", version: "2" },
    "eip155:421614": { asset: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d", name: "USD Coin", version: "2" },
    "eip155:42161": { asset: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", name: "USD Coin", version: "2" },
};
const X402_NETWORK = { "base-sepolia": "eip155:84532", base: "eip155:8453", "arbitrum-sepolia": "eip155:421614", arbitrum: "eip155:42161" };

/** How a sale settles, from `paid` or `private` in app.json: the network (`network`, else the
 *  app's own), the token and its EIP-712 domain, the payee (`payTo`, else the owner) and the facilitator. */
export function settlement(o, { network: own, owner }) {
    const network = o.network ? X402_NETWORK[o.network] ?? o.network : own;
    const usdc = o.asset ? {} : USDC[network];
    if (!usdc) throw new Error(`network ${network}: no default USDC; set asset, tokenName and tokenVersion`);
    const name = o.tokenName ?? usdc.name, version = o.tokenVersion ?? usdc.version;
    if (!name || !version) throw new Error("asset needs tokenName and tokenVersion: its EIP-712 domain");
    return { network, asset: o.asset ?? usdc.asset, name, version, decimals: o.decimals ?? 6, symbol: o.symbol ?? "USDC",
             payTo: o.payTo ?? owner, facilitator: (o.facilitator ?? "https://facilitator.payai.network").replace(/\/$/, "") };
}

/** "0.01" → "10000": a decimal price in the token's base units. */
export function units(price, decimals = 6) {
    if (!/^\d+(\.\d+)?$/.test(String(price))) throw new Error(`price must be a decimal like "0.01", got ${price}`);
    const [whole, frac = ""] = String(price).split(".");
    return (BigInt(whole) * 10n ** BigInt(decimals) + BigInt((frac + "0".repeat(decimals)).slice(0, decimals) || "0")).toString();
}
const STOCK = join(HERE, "../../site/dist");
const log = (s) => console.error(`[ship] ${s}`);

// ── config ────────────────────────────────────────────────────────────────────
//
// {
//   "app": "quorum", "name": "Quorum", "description": "…", "tags": ["civic"],
//   "site": { "project": "quorum",   // the Worker's name (and its R2 bucket's: <project>-view)
//             "account": "<cloudflare account id>",
//             "url": "https://quorum.example",   // optional: a custom domain routed to the Worker
//             "cron": "*/5 * * * *",             // optional: how often the indexer runs
//             "pages": "pages",   // optional: the app's own files, copied over the stock page
//                                 //   (pages/intro.html, a fragment, replaces the description on the front page)
//             "nav": [{ "href": "coverage.html", "label": "Coverage" }],   // optional: header links to them
//             "examples": ["…"],  // optional: questions to start from, on the front page (and a private app's gate)
//             "agent": "app/agent.js" },   // optional: the module whose registerAgent the card lists, when
//                                          // `pages` replaces the stock index.html with a page of its own
//   "types": { "<tag>": { "description": "…", "role_map": {…}, "presentation": {…} } },
//   "relations": [{ "rel": "…", "from": "<tag>", "to": "<tag>" }],
//   "sources": [{ "namespace": "…", "cwd": "…", "command": ["python", "-m", "…", …] }],
//   "network": "baseSepolia", // required: the SDK's network name. baseSepolia for a new app; an app
//                             //   already claimed on arbitrumSepolia keeps it (a different name re-claims it there)
//   "fangorn": "fangorn",     // the CLI that signs; e.g. "node ~/fangorn/fangorn/lib/cli/cli.js",
//                             //   or "env HOME=<dir> node …/cli.js" to sign with <dir>/.fangorn/config.json
//   "paid": { "price": "0.01", "description": "…" }   // settles in USDC on the app's network, or "network": "base" / "eip155:8453"…
// }
//
// `paid` sells per-record keys over x402 v2 (site/worker.js), and the price goes in the card,
// /openapi.json and /.well-known/x402. The payee is the app owner unless `paid.payTo` says
// otherwise; the asset is USDC on `paid.network` unless `paid.asset` (with `tokenName` and
// `tokenVersion`, its EIP-712 domain) does. PAID_SECRET is a Worker secret
// (`wrangler secret put PAID_SECRET`), the same value the sources encrypt with.
// The facilitator (PayAI unless `paid.facilitator`) lists POST /paid in its Bazaar on the first
// sale; each ship says whether it has.
//
//   "private": { "pass": { "price": "5", "days": 30 }, "call": "0.01", "description": "…" }
//
// `private` makes the data itself the product. Each source stages its records (it needs an
// --output-dir), ship seals every row whole (x402.js's sealRow) and commits them, so IPFS holds
// only ciphertext; the Worker opens them in its cron with PAID_SECRET (made once in
// .ship/secret, or $PAID_SECRET, and put to the Worker on every deploy) and serves the view and
// the MCP tools only with a pass (POST /pass, x402) or one x402 payment per tool call. The card,
// the catalog and `describe` stay free. Settles like `paid` (network, payTo, asset, facilitator).
//
// A source is any command that publishes into the repo `--namespace` names when given
// `--publish`. It runs with FANGORN_APP_ID set, so it uploads through this app's storage
// whatever the CLI's saved app is.

/** `{field}`, `{field|slug}` and `{field|lower}` from a row; an argv item that is exactly
 *  `{args...}` splices the row's own `args` array (for flags only some rows need). */
export function fill(template, row) {
    const one = (s) => s.replace(/\{(\w+)(?:\|(slug|lower))?\}/g, (_, k, f) => {
        if (row[k] == null) throw new Error(`template needs "${k}", which ${JSON.stringify(row)} lacks`);
        const v = String(row[k]);
        return f === "slug" ? v.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") : f === "lower" ? v.toLowerCase() : v;
    });
    return Array.isArray(template) ? template.flatMap((t) => (t === "{args...}" ? row.args ?? [] : [one(t)])) : one(template);
}

/** A source with `each: "towns.json"` is a template: one source per row of that file
 *  (rows with `"skip": true` are left out). Adding a town is adding a row. */
export function expandSources(sources, base) {
    return sources.flatMap((s) => {
        if (!s.each) return [s];
        const rows = JSON.parse(readFileSync(resolve(base, s.each), "utf8")).filter((r) => !r.skip);
        return rows.map((r) => ({ ...s, each: undefined, row: r, namespace: fill(s.namespace, r), command: fill(s.command, r),
                                  ...(s.paid_dir ? { paid_dir: fill(s.paid_dir, r) } : {}) }));
    });
}

export function loadConfig(path) {
    const c = JSON.parse(readFileSync(path, "utf8"));
    c.sources = expandSources(c.sources ?? [], dirname(resolve(path)));
    for (const k of ["app", "name", "description", "site"])   // types and sources can come after --register
        if (!c[k]) throw new Error(`${path}: missing "${k}"`);
    if (!c.site.project) throw new Error(`${path}: site.project names the Cloudflare Worker`);
    for (const s of c.sources) if (!s.namespace || !Array.isArray(s.command))
        throw new Error(`${path}: each source needs a namespace and a command (an argv array)`);
    return { relations: [], tags: [], types: {}, ...c };
}

/** The Worker's wrangler config: the stock worker, the site as its assets, its bucket, the AI
 *  binding, the cron and CONFIG. `worker` is site/worker.js unless a test points elsewhere. */
export function wranglerConfig({ name, site, account, cron = "*/5 * * * *", config, url, ipfsGateway, worker = join(HERE, "../../site/worker.js") }) {
    return {
        name, main: worker, compatibility_date: "2025-09-15", compatibility_flags: ["nodejs_compat"],
        ...(account ? { account_id: account } : {}),
        assets: { directory: site, binding: "ASSETS" },
        r2_buckets: [{ binding: "VIEW", bucket_name: `${name}-view` }],
        ai: { binding: "AI" },
        triggers: { crons: [cron] },
        // ipfs.io answers a Worker's reads with 429s; the owner's gateway serves the owner's pins.
        // ponytail: a dedicated Pinata gateway serves only its account's pins unless opened up;
        // an app presenting other publishers' repos needs an open gateway here.
        vars: { CONFIG: config, ...(ipfsGateway ? { IPFS_GATEWAY: ipfsGateway } : {}) },
        // The Worker embeds with its AI binding; the in-process model is ~1.5 MB of bundle it never runs.
        alias: { "@huggingface/transformers": join(HERE, "../../site/no-model.js") },
        ...(url ? { routes: [{ pattern: new URL(url).hostname, custom_domain: true }] } : {}),
    };
}

/** Keys sorted at every depth: the chain stores dag-cbor, whose maps come back in
 *  canonical key order, not the order app.json wrote them in. */
const stable = (v) => Array.isArray(v) ? v.map(stable)
    : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])])) : v;

// ── processes ─────────────────────────────────────────────────────────────────

/** `${VAR}` and `${VAR:-default}` from the environment, so one app.json runs on a laptop
 *  and in CI (e.g. `"${PYTHON:-python3}"`). */
export const expandEnv = (s) => s.replace(/\$\{(\w+)(?::-([^}]*))?\}/g, (_, k, d) => process.env[k] ?? d ?? "");

function run(cmd, args, { cwd, env, capture = false, dry = false, input } = {}) {
    cmd = expandEnv(cmd); args = args.map(expandEnv);
    log(`$ ${[cmd, ...args].join(" ")}${cwd ? `   (in ${cwd})` : ""}`);
    if (dry) return "";
    // `input`: what the command reads on stdin (a secret: never on the command line, never logged).
    const r = spawnSync(cmd, args, { cwd, env: { ...process.env, ...env }, encoding: "utf8", input,
        stdio: [input != null ? "pipe" : capture ? "ignore" : "inherit", capture ? "pipe" : "inherit", "inherit"] });
    if (r.status !== 0) throw new Error(`${cmd} ${args[0]} failed (exit ${r.status})`);
    return r.stdout ?? "";
}
const expand = (p) => p.replace(/^~(?=\/|$)/, homedir());
const cliArgv = (cfg) => expandEnv(process.env.FANGORN_CLI ?? cfg.fangorn ?? "fangorn").split(/\s+/).filter(Boolean).map(expand);
let CLI = ["fangorn"];
const fangornCli = (app, args, opts = {}) => run(CLI[0], [...CLI.slice(1), "--app", app, ...args], { capture: true, ...opts });

/** The CLI must be the SDK version westmarch reads with. A different one signs against
 *  another deployment's contracts: its claim and commits land where nothing here looks,
 *  and every read says the app is unclaimed. (It happened: a global 2026.08.18-dev CLI
 *  claimed and published onto the previous registries.) */
function assertSameDeployment(cli) {
    // "env HOME=… node cli.js": a CLI with its own config (another wallet); find the script past the env.
    let i = cli[0] === "env" ? 1 : 0;
    while (cli[i]?.includes("=")) i++;
    cli = cli.slice(i);
    const which = (c) => spawnSync("sh", ["-c", `command -v ${c}`], { encoding: "utf8" }).stdout.trim();
    const script = cli.length > 1 && /(^|\/)node$/.test(cli[0]) ? cli[1] : which(cli[0]);
    if (!script) throw new Error(`fangorn CLI not found: ${cli.join(" ")}`);
    let d = dirname(realpathSync(script)), cliVersion = null;
    for (; d !== dirname(d); d = dirname(d)) {
        const pj = join(d, "package.json");
        if (existsSync(pj)) { const p = JSON.parse(readFileSync(pj, "utf8")); if (p.name === "@fangorn-network/sdk") { cliVersion = p.version; break; } }
    }
    const ours = createRequire(import.meta.url)("@fangorn-network/sdk/package.json").version;
    if (cliVersion !== ours) throw new Error(`the fangorn CLI (${cli.join(" ")}) is SDK ${cliVersion ?? "?"}, westmarch reads with ${ours}: ` +
        "they talk to different contracts. Point app.json's \"fangorn\" at a matching CLI.");
}

// ── the steps ─────────────────────────────────────────────────────────────────

export async function ship(configPath, { crawl = true, deploy = true, dry = false, replace = false, only = null, register = false } = {}) {
    const cfg = loadConfig(configPath);
    // No sources is fine: the app then presents whatever its members commit (repos: [] = all of them).
    if (!register && !Object.keys(cfg.types).length)
        throw new Error(`${configPath}: no types yet, so nothing to build; --register sets up the app alone`);
    // No default: one that changed would claim every app that leaned on it again, elsewhere.
    if (!cfg.network) throw new Error(`${configPath}: "network" is required: "baseSepolia" for a new app, or the network the app was claimed on (before 2026-10-20 the default was "arbitrumSepolia")`);
    CLI = cliArgv(cfg);
    assertSameDeployment(CLI);
    const base = dirname(resolve(configPath));
    const dir = join(base, ".ship");
    const statePath = join(dir, "state.json");
    mkdirSync(dir, { recursive: true });
    const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};
    const save = () => !dry && writeFileSync(statePath, JSON.stringify(state, null, 1));
    // A private app's PAID_SECRET: $PAID_SECRET, else made once in .ship/secret. Losing it loses
    // every sealed row, so it is never made again over one that exists.
    const secretPath = join(dir, "secret");
    const secret = () => {
        if (process.env.PAID_SECRET) return process.env.PAID_SECRET;
        if (!existsSync(secretPath)) writeFileSync(secretPath, randomBytes(32).toString("hex"), { mode: 0o600 });
        return readFileSync(secretPath, "utf8").trim();
    };

    // The SDK's network name: view.js reads with it, and the CLI and the sources spawned below sign on it.
    process.env.FANGORN_NETWORK = process.env.CHAIN_NAME = cfg.network;
    const [{ createPublicClient, http }, view] = await Promise.all([import("viem"), import("./view.js")]);
    const FangornConfig = await view.network(cfg.network);
    const fangorn = await view.readOnlyFangorn();
    fangorn.setAppId(cfg.app);
    const appId = fangorn.getAppId();
    const registry = fangorn.getAppRegistry();
    const cf = cfg.site.account ? { CLOUDFLARE_ACCOUNT_ID: cfg.site.account } : {};

    // 1. claim: pays the subscription (the app sponsors its members' storage) and makes the
    // claimer the app's first member.
    const me = (fangornCli(cfg.app, ["wallet"]).match(/Address:\s+(0x[0-9a-fA-F]{40})/) ?? [])[1]?.toLowerCase();
    if (!me) throw new Error("`fangorn wallet` shows no address; run `fangorn init`");
    let owner = (await registry.getAppOwner()).toLowerCase();
    if (/^0x0+$/.test(owner)) {
        const block = await createPublicClient({ transport: http(FangornConfig.rpcUrl) }).getBlockNumber();
        state.fromBlock = String(block);
        log(`${cfg.app} is unclaimed; claiming it for ${me} (fromBlock ${block})`);
        fangornCli(cfg.app, ["app", "claim"], { dry });
        owner = me;
        save();
    } else if (owner !== me) {
        throw new Error(`${cfg.app} belongs to ${owner}, not this wallet (${me}); pick another name`);
    }
    state.fromBlock ??= String(cfg.fromBlock ?? FangornConfig.appRegistryFromBlock);
    log(`app ${cfg.app} = ${appId}, owner ${owner}, fromBlock ${state.fromBlock}`);

    // 2. sources: crawl + publish straight into the app. One source failing (a site that
    // blocks us, a feed that is down) keeps its last published data and does not stop the
    // others; the ship still exits non-zero at the end, naming it.
    const failed = [];
    if (crawl && !register) for (const s of cfg.sources.filter((s) => !only || only.includes(s.namespace))) {
        const cwd = s.cwd ? resolve(base, s.cwd.replace(/^~/, homedir())) : base;
        const paidArgs = cfg.paid && s.paid_dir ? ["--paid-dir", resolve(cwd, s.paid_dir)] : [];
        try {
            if (cfg.private) await publishSealed(cfg, base, s, { secret: secret(), dry });
            else run(s.command[0], [...s.command.slice(1), ...paidArgs, ...(replace ? ["--replace"] : []),
                                    "--publish", "--namespace", s.namespace, "--fangorn-bin", CLI.join(" ")],
                     { cwd, env: { FANGORN_APP_ID: cfg.app }, dry });
        } catch (e) {
            log(`✗ ${s.namespace}: ${e.message}; its last published records stay live`);
            failed.push(s.namespace);
        }
    }

    // 3. the page, the card, the headers
    const { site, writeCard } = await buildSite(cfg, base);
    // site.url: the app's own domain, routed to the Worker. Otherwise its workers.dev URL,
    // which is only known once it is deployed: the first deploy learns it and the card follows.
    let url = cfg.site.url?.replace(/\/$/, "") ?? state.url ?? null;
    const repos = [...new Set(cfg.sources.map((s) => s.namespace))];
    // Paid records are in the committed rows already, encrypted (`paid_ct`: AES-256-GCM under
    // HMAC-SHA256(PAID_SECRET, id), see x402.js). The Worker sells keys, never records, so the
    // data a buyer pays for is on IPFS, committed, and in their hands before they pay.
    const terms = (o) => settlement(o, { network: `eip155:${FangornConfig.caip2}`, owner });
    const sale = (u) => {
        if (!cfg.paid) return { paid: null, sale: null };
        const T = terms(cfg.paid), price = units(cfg.paid.price, T.decimals), description = cfg.paid.description ?? "";
        const paid = { url: `${u}/paid/{id}`, price, asset: T.asset, network: T.network, decimals: T.decimals, symbol: T.symbol, description };
        return { paid, sale: { ...T, price, description } };
    };
    const access = (u) => {
        const X = cfg.private;
        if (!X) return { card: null, config: null };
        if (!X.pass?.price || !X.call) throw new Error(`${configPath}: private needs pass.price and call, decimal prices like "5" and "0.01"`);
        const T = terms(X), days = X.pass.days ?? 30, description = X.description ?? "";
        const pass = { price: units(X.pass.price, T.decimals), seconds: Math.round(days * 86400) }, call = units(X.call, T.decimals);
        return { card: { pass_url: `${u}/pass`, pass: pass.price, days, call, network: T.network, asset: T.asset, symbol: T.symbol, decimals: T.decimals, description },
                 config: { ...T, pass, call, description } };
    };
    const writeSite = (u) => writeCard(u, { fromBlock: state.fromBlock, repos, paid: sale(u).paid, access: access(u).card });
    writeSite(url ?? `https://${cfg.site.project}.workers.dev`);

    // 4. the Worker
    const workerConfig = (u) => {
        const path = join(dir, "wrangler.json");
        writeFileSync(path, JSON.stringify(wranglerConfig({
            name: cfg.site.project, site, account: cfg.site.account, cron: cfg.site.cron, url: cfg.site.url, ipfsGateway: view.ipfsGateway(),
            config: { app: cfg.app, name: cfg.name, description: cfg.description, fromBlock: state.fromBlock, network: cfg.network,
                      schema: { types: cfg.types, relations: cfg.relations }, repos: register ? [] : repos, paid: sale(u).sale, private: access(u).config },
        }), null, 1));
        return path;
    };
    if (deploy) {
        const bucket = `${cfg.site.project}-view`;
        const buckets = run("npx", ["wrangler", "r2", "bucket", "list"], { env: cf, capture: true, dry });
        if (!dry && !buckets.split("\n").some((l) => l.trim() === `name:           ${bucket}` || l.includes(` ${bucket}`)))
            run("npx", ["wrangler", "r2", "bucket", "create", bucket], { env: cf });
        const out = run("npx", ["wrangler", "deploy", "--config", workerConfig(url ?? "https://pending.invalid")], { env: cf, capture: true, dry });
        const deployed = (out.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/) ?? [])[0];
        if (!url) {
            if (!deployed && !dry) throw new Error("wrangler deploy printed no workers.dev URL; set site.url");
            url = deployed ?? `https://${cfg.site.project}.workers.dev`;
            // The card and CONFIG name the URL, which the first deploy only now learned.
            writeSite(url);
            run("npx", ["wrangler", "deploy", "--config", workerConfig(url)], { env: cf, capture: true, dry });
        }
        state.url = url;
        save();
        if (cfg.private) run("npx", ["wrangler", "secret", "put", "PAID_SECRET", "--config", workerConfig(url)], { env: cf, capture: true, dry, input: secret() });
        else if (cfg.paid) log("paid: set the key secret once with `npx wrangler secret put PAID_SECRET --config .ship/wrangler.json`");
    } else workerConfig(url ?? `https://${cfg.site.project}.workers.dev`);

    // 5. ERC-8004 + the binding
    const cardUrl = `${url}/.well-known/agent-card.json`;
    const bound = await registry.appAgentUri(appId).catch(() => "");
    const mint = () => {
        const out = dry ? "" : fangornCli(cfg.app, ["app", "agent", cardUrl]);
        state.agentId = (out.match(/Agent ID:\s+(\S+)/) ?? [])[1] ?? state.agentId;
        delete state.agentPending;
        save();
    };
    if (deploy && bound !== cardUrl && register) {
        log(`binding ${cardUrl} (on chain: ${bound || "nothing"}); the agent is minted on the first full ship`);
        fangornCli(cfg.app, ["app", "agent", cardUrl, "--skip-register"], { dry });
        state.agentPending = true;
        save();
    } else if (deploy && bound !== cardUrl) {
        log(`binding ${cardUrl} (on chain: ${bound || "nothing"})`);
        mint();
    } else if (deploy && state.agentPending && !register) {
        log(`minting the ERC-8004 agent from the card as built`);
        mint();
    } else if (deploy) log("card already bound");

    // A new app has no view until the cron runs, which may be hours off: build the first one now.
    if (deploy && !dry && !register && cfg.sources.length && !await fetch(`${url}/view/cdn/catalog`).then((r) => r.ok, () => false)) {
        log("no view yet: indexing it here rather than waiting for the cron");
        await indexHere(configPath).catch((e) => log(`✗ first index: ${e.message}; the cron will build it`));
    }

    // The Bazaar: the facilitator lists POST /paid once it settles a sale (and decides to);
    // nothing here can list it sooner, so ship only says where it stands.
    if (deploy && (cfg.paid || cfg.private) && !dry) for (const [route, T] of [["paid", sale(url).sale], ["pass", access(url).config]]) {
        if (!T) continue;
        const listed = await fetch(`${T.facilitator}/discovery/resources?payTo=${T.payTo}`).then((r) => r.json())
            .then((d) => (d.items ?? []).some((i) => i.resource === `${url}/${route}`), () => null);
        log(listed ? `the Bazaar at ${T.facilitator} lists ${url}/${route}`
            : listed === false ? `the Bazaar at ${T.facilitator} does not list ${url}/${route} yet: it is listed on its first sale`
            : `could not read the Bazaar at ${T.facilitator}`);
    }

    log(`done: ${url}  ·  card ${cardUrl}  ·  MCP ${url}/mcp  ·  the view fills on the Worker's next cron run`);
    if (failed.length) throw new Error(`deployed, but these sources failed and kept their old records: ${failed.join(", ")}`);
    return { url, cardUrl, agentId: state.agentId };
}

/** A private app's source: staged (it needs an --output-dir), every row sealed whole, and committed
 *  as a full snapshot. Unchanged rows seal to the same bytes, so the Worker embeds only what changed. */
async function publishSealed(cfg, base, s, { secret, dry }) {
    const { sealRow } = await import("../agent/x402.js");
    const rows = readStage({ ...cfg, sources: [s] }, base, { crawl: true })[s.namespace];
    const sdir = join(base, ".ship/sealed", s.namespace);
    mkdirSync(sdir, { recursive: true });
    const records = await Promise.all(rows.map(async (r) => ({ id: r.id, type: r.type, payload: await sealRow(secret, r.payload) })));
    writeFileSync(join(sdir, "commit.json"), JSON.stringify({ records }));
    log(`${s.namespace}: ${records.length} rows sealed`);
    try { fangornCli(cfg.app, ["status"], { cwd: sdir, dry }); } catch { fangornCli(cfg.app, ["repo", "init", s.namespace], { cwd: sdir, dry }); }
    fangornCli(cfg.app, ["commit", "commit.json", "-m", `${s.namespace}: ${records.length} rows, sealed`, "--replace"], { cwd: sdir, dry });
    fangornCli(cfg.app, ["push"], { cwd: sdir, dry });
}

/** What x402scan reads (docs/DISCOVERY.md in Merit-Systems/x402scan): /openapi.json with
 *  `x-payment-info` on each paid route, and /.well-known/x402 naming them. POST /paid (keys to
 *  sealed records) and POST /pass (a private app's pass); not GET /paid/{id}, a template no probe
 *  can call. The worker's live 402 is authoritative over both. A private app's tools, paid per
 *  call over MCP, are listed in the Bazaar instead: x402scan reads HTTP routes only.
 *  ponytail: currency "USD" assumes the asset is USDC, the only default ship knows. */
export function discovery(cfg, u, paid = null, access = null) {
    const token = paid ?? access;
    const usd = (n) => String(Number(n) / 10 ** (token.decimals ?? 6));
    const ids = { type: "array", items: { type: "string" }, minItems: 1, maxItems: 1000 };
    const sym = token.symbol ?? "USDC";
    const paths = {};
    if (paid) paths["/paid"] = { post: {
        operationId: "buyKeys",
        summary: `Keys to ${cfg.name}'s sealed records, ${usd(paid.price)} ${sym} each`,
        description: `${paid.description ? `${paid.description}. ` : ""}Each record is in the app's rows already, sealed (paid_ct, `
            + `AES-256-GCM, with paid_sha256 of the plaintext): this sells its key. Find records and their ids with the MCP server at ${u}/mcp; `
            + `the agent card is ${u}/.well-known/agent-card.json.`,
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["ids"], properties: { ids } } } } },
        responses: {
            200: { description: "A hex key per id; ids it could not sell are in missing", content: { "application/json": { schema: { type: "object", properties: {
                keys: { type: "object", additionalProperties: { type: "string" } }, missing: ids, receipts: { type: "array", items: { type: "object" } },
                paid: { type: "array", items: { type: "string" } } } } } } },
            402: { description: "Payment required: x402 v2, the PaymentRequired in the PAYMENT-REQUIRED header" },
        },
        "x-payment-info": { protocols: [{ x402: {} }], price: { mode: "dynamic", currency: "USD", min: usd(paid.price), max: usd(BigInt(paid.price) * 1000n) } },
    } };
    if (access) paths["/pass"] = { post: {
        operationId: "buyPass",
        summary: `A ${access.days}-day pass to ${cfg.name}, ${usd(access.pass)} ${sym}`,
        description: `${access.description ? `${access.description}. ` : ""}Every tool of the MCP server at ${u}/mcp (search, get, similar, count, `
            + `browse) and the view at ${u}/view, for ${access.days} days: send Authorization: Bearer <token>. Without a pass each tool call costs `
            + `${usd(access.call)} ${sym} over x402's MCP transport.`,
        responses: {
            200: { description: "The pass", content: { "application/json": { schema: { type: "object", properties: {
                token: { type: "string" }, expires: { type: "integer", description: "Unix seconds" }, use: { type: "string" } } } } } },
            402: { description: "Payment required: x402 v2, the PaymentRequired in the PAYMENT-REQUIRED header" },
        },
        "x-payment-info": { protocols: [{ x402: {} }], price: { mode: "fixed", currency: "USD", amount: usd(access.pass) } },
    } };
    const guidance = access
        ? `${cfg.name}'s data is private. describe on the MCP server at ${u}/mcp is free. Buy a pass (POST /pass, x402 v2) and send `
          + `Authorization: Bearer <token> to ${u}/mcp, or pay each tool call over x402's MCP transport (_meta["x402/payment"]).`
        : `Search ${cfg.name} with the MCP server at ${u}/mcp (free). A row with paid_ct is for sale: POST its id to /paid, `
          + `pay the 402 (x402 v2), and open paid_ct with the key that comes back (AES-256-GCM, nonce first; check paid_sha256).`;
    return {
        openapi: {
            openapi: "3.1.0",
            info: { title: cfg.name, version: new Date().toISOString().slice(0, 10), description: cfg.description, "x-guidance": guidance },
            servers: [{ url: u }],
            paths,
        },
        x402: { version: 1, resources: Object.keys(paths).map((p) => `${u}${p}`) },
    };
}

/** The stock page with the app's own files over it, in .ship/site; `writeCard(url, …)` adds the card for where it is served. */
export async function buildSite(cfg, base) {
    if (!existsSync(join(STOCK, "index.html"))) throw new Error(`no stock page at ${STOCK}; run \`npx vite build\` in westmarch/site`);
    const site = join(base, ".ship/site");
    rmSync(site, { recursive: true, force: true });
    mkdirSync(site, { recursive: true });
    cpSync(STOCK, site, { recursive: true });
    if (cfg.site.pages) cpSync(resolve(base, cfg.site.pages), site, { recursive: true });
    writeFileSync(join(site, "nav.json"), JSON.stringify(cfg.site.nav ?? []));
    writeFileSync(join(site, "examples.json"), JSON.stringify(cfg.site.examples ?? []));
    // The card lists the tools the page at `url` registers: the stock page's, or the app's own.
    const card = await import("../agent/agent-card.js");
    const { registerAgent } = await import(cfg.site.agent ? pathToFileURL(resolve(base, cfg.site.agent)).href : "../../site/agent.js");
    const tools = await card.captureTools(() => registerAgent({}));
    const config = await (await import("./view.js")).network(cfg.network);
    const writeCard = (u, { fromBlock, repos, paid = null, access = null }) => {
        const agentCard = card.agentCard({
            name: cfg.name, description: cfg.description, url: `${u}/`, version: new Date().toISOString().slice(0, 10), tools, tags: cfg.tags,
            // What is sold, as a skill tagged x402: ERC-8004 registration reads x402Support off the tags.
            skills: [
                ...(access ? [{ id: "pass", name: "Pass", tags: [...(cfg.tags ?? []), "x402"],
                    description: `A ${access.days}-day pass to every tool and the view (POST ${u}/pass), or one x402 payment per tool call.` }] : []),
                ...(paid ? [{ id: "keys", name: "Keys", tags: [...(cfg.tags ?? []), "x402"],
                    description: `The keys to sealed records (POST ${u}/paid), per record.` }] : []),
            ],
            fangorn: { app: cfg.app, fromBlock, repos, views: [`${u}/view`], mcp: `${u}/mcp`, config, ...(paid ? { paid } : {}), ...(access ? { access } : {}) },
        });
        mkdirSync(join(site, ".well-known"), { recursive: true });
        writeFileSync(join(site, ".well-known/agent-card.json"), JSON.stringify(agentCard, null, 1));
        if (paid || access) {
            const d = discovery(cfg, u, paid, access);
            writeFileSync(join(site, "openapi.json"), JSON.stringify(d.openapi, null, 1));
            writeFileSync(join(site, ".well-known/x402"), JSON.stringify(d.x402, null, 1));
        }
        writeFileSync(join(site, "_headers"), "/.well-known/agent-card.json\n  Access-Control-Allow-Origin: *\n"
            + "/openapi.json\n  Access-Control-Allow-Origin: *\n"
            + "/.well-known/x402\n  Access-Control-Allow-Origin: *\n  Content-Type: application/json\n"
            + "/assets/*\n  Cache-Control: public, max-age=31536000, immutable\n");
    };
    return { site, writeCard };
}

/**
 * What each source staged in its --output-dir, as records: `{namespace: [{id, type, payload}]}`.
 * The sources run first (without --publish) with crawl=true.
 *
 * ponytail: reads every `volume_<n>_*.json` in a source's --output-dir; the
 * harness publishes only the stems its source declares, so a stale file left by an older
 * shape of a source is read here and not on chain. Clear the stage dir if that bites.
 */
export function readStage(cfg, base, { crawl = false, only = null, log: say = log } = {}) {
    const out = {};
    for (const s of cfg.sources.filter((s) => !only || only.includes(s.namespace))) {
        const cwd = s.cwd ? resolve(base, s.cwd.replace(/^~/, homedir())) : base;
        if (crawl) run(s.command[0], s.command.slice(1), { cwd, env: { FANGORN_APP_ID: cfg.app } });
        const at = s.command.indexOf("--output-dir");
        if (at < 0) { say(`${s.namespace}: no --output-dir in its command, so nothing staged to read`); continue; }
        const dir = resolve(cwd, expandEnv(s.command[at + 1]));
        const volume = s.command.includes("--volume") ? s.command[s.command.indexOf("--volume") + 1] : "1";
        const records = (out[s.namespace] ??= []);
        const byName = new Map();
        for (const f of existsSync(dir) ? readdirSync(dir).sort() : []) {
            const m = new RegExp(`^volume_${volume}_(.+)\\.json$`).exec(f);
            if (!m || m[1] === "edges") continue;
            // The harness stages {name, fields}: the record's id and its payload.
            for (const n of JSON.parse(readFileSync(join(dir, f), "utf8"))) {
                const r = { id: n.name, type: n.fields?.entityType ?? m[1][0].toUpperCase() + m[1].slice(1), payload: { ...n.fields } };
                byName.set(n.name, r);
                records.push(r);
            }
        }
        // Edges name records by the harness's ids: each becomes a reference on its source.
        const edges = join(dir, `volume_${volume}_edges.json`);
        for (const e of existsSync(edges) ? JSON.parse(readFileSync(edges, "utf8")) : [])
            if (byName.has(e.from) && byName.has(e.to)) byName.get(e.from).payload[e.rel] = { local: e.to };
    }
    // An empty stage is a crawl that did not happen (or a cache that was not restored), not
    // an app with no records; a view of it would grade as a failure for the wrong reason.
    if (!Object.values(out).some((rs) => rs.length))
        throw new Error("no staged records under any source's --output-dir: run the sources (--crawl, or a ship) or restore .ship/stage first");
    return out;
}

/**
 * The whole app on this machine (devnet.js): a local chain and IPFS, the app claimed there, what the sources staged published into it, and its Worker under
 * `wrangler dev` with a local R2 and an encoder on localhost (or Workers AI with ai=true).
 * Runs the indexer once, says where everything is, and stays up until interrupted.
 */
export async function devnetShip(configPath, { crawl = false, only = null, port = 8787, ai = false } = {}) {
    const cfg = loadConfig(configPath);
    const base = dirname(resolve(configPath));
    const { devnet } = await import("./devnet.js");
    const staged = readStage(cfg, base, { crawl, only });
    const net = await devnet({ log });
    const owner = await net.client(cfg.app);
    await owner.getAppRegistry().registerApp();
    // The claimer publishes the sources, as `fangorn` does in a ship.
    for (const [ns, records] of Object.entries(staged)) {
        if (!records.length) continue;
        await owner.initRepo(ns);
        await owner.uploadBatch(ns, records);
        log(`published ${ns}: ${records.length} records`);
    }

    const url = `http://127.0.0.1:${port}`;
    const repos = Object.keys(staged);
    const { site, writeCard } = await buildSite(cfg, base);
    writeCard(url, { fromBlock: "0", repos });
    const wcfg = wranglerConfig({ name: cfg.site.project, site, config: { app: cfg.app, name: cfg.name, description: cfg.description,
        fromBlock: "0", schema: { types: cfg.types, relations: cfg.relations }, repos, paid: null, deployment: net.deployment } });
    // Its own R2 and state, apart from a deployed app's.
    wcfg.vars.RPC_URL = net.rpcUrl;
    wcfg.vars.IPFS_GATEWAY = net.gatewayUrl;
    if (!ai) { wcfg.vars.EMBED_URL = await net.encoder(); delete wcfg.ai; }   // no binding: wrangler would reach Cloudflare for it
    delete wcfg.routes;
    const wpath = join(base, ".ship/wrangler.devnet.json");
    writeFileSync(wpath, JSON.stringify(wcfg, null, 1));
    rmSync(join(base, ".ship/devnet-state"), { recursive: true, force: true });   // a fresh chain: last run's view is of another one
    const wrangler = spawn("npx", ["wrangler", "dev", "--config", wpath, "--port", String(port), "--ip", "127.0.0.1", "--test-scheduled",
        "--persist-to", join(base, ".ship/devnet-state")], { cwd: join(HERE, "../.."), stdio: ["ignore", "inherit", "inherit"],
        env: { ...process.env, ...(ai && cfg.site.account ? { CLOUDFLARE_ACCOUNT_ID: cfg.site.account } : {}) } });
    net.kids.push(wrangler);
    const up = async () => { for (;;) { if (wrangler.exitCode !== null) throw new Error("wrangler dev exited");
        if (await fetch(url).then((r) => r.ok, () => false)) return; await new Promise((r) => setTimeout(r, 1000)); } };
    await up();
    log(`indexing (the cron, once): ${repos.length} repos`);
    await fetch(`${url}/__scheduled?cron=${encodeURIComponent(wcfg.triggers.crons[0])}`);
    const want = Object.values(staged).filter((rs) => rs.length).length;
    let catalog = null;
    while ((catalog?.domains?.length ?? 0) < want) {
        if (wrangler.exitCode !== null) throw new Error("wrangler dev exited");
        await new Promise((r) => setTimeout(r, 5000));
        catalog = await fetch(`${url}/view/cdn/catalog`).then((r) => r.ok ? r.json() : null, () => null);
    }
    log(`done: ${catalog?.domains?.length ?? 0} domains, ${(catalog?.domains ?? []).reduce((n, d) => n + d.count, 0)} rows`);
    log(`site ${url}  ·  MCP ${url}/mcp  ·  view ${url}/view  ·  reindex: curl '${url}/__scheduled'  ·  Ctrl-C stops it all`);
    log(`grade it: npx westmarch-eval ${url}/view --golden eval/golden.jsonl`);
    await new Promise((r) => wrangler.on("exit", r));
}

/**
 * The deployed app's indexer, run once on this machine: its Worker under `wrangler dev` with
 * the app's own R2 bucket and Workers AI (remote bindings), its CONFIG, and for a private app
 * its PAID_SECRET (in .ship/.dev.vars for the run, then removed). The first view right after a
 * deploy, without waiting for the cron; and a catalog too big for one cron run's limits, since
 * nothing here is capped. Writes the same view the cron would.
 * ponytail: Workers AI still embeds; an encoder on this machine (EMBED_URL) would record another
 * embedder, and the deployed Worker's queries would not match it.
 */
export async function indexHere(configPath, { port = 8791 } = {}) {
    const cfg = loadConfig(configPath);
    const base = dirname(resolve(configPath)), dir = join(base, ".ship");
    if (!existsSync(join(dir, "wrangler.json"))) throw new Error(`${dir}/wrangler.json: ship the app first`);
    const w = JSON.parse(readFileSync(join(dir, "wrangler.json"), "utf8"));
    w.r2_buckets = w.r2_buckets.map((b) => ({ ...b, remote: true }));
    w.ai = { ...w.ai, remote: true };
    delete w.routes;
    const wpath = join(dir, "wrangler.index.json"), vars = join(dir, ".dev.vars");
    writeFileSync(wpath, JSON.stringify(w, null, 1));
    const secret = process.env.PAID_SECRET ?? (existsSync(join(dir, "secret")) ? readFileSync(join(dir, "secret"), "utf8").trim() : null);
    if (cfg.private && !secret) throw new Error("a private app's rows open only with its PAID_SECRET: none in $PAID_SECRET or .ship/secret");
    if (secret) writeFileSync(vars, `PAID_SECRET=${secret}\n`, { mode: 0o600 });
    const url = `http://127.0.0.1:${port}`, start = Math.floor(Date.now() / 1000);
    const wrangler = spawn("npx", ["wrangler", "dev", "--config", wpath, "--port", String(port), "--ip", "127.0.0.1", "--test-scheduled"],
        { cwd: join(HERE, "../.."), stdio: ["ignore", "inherit", "inherit"],
          env: { ...process.env, ...(cfg.site.account ? { CLOUDFLARE_ACCOUNT_ID: cfg.site.account } : {}) } });
    try {
        for (;;) {
            if (wrangler.exitCode !== null) throw new Error("wrangler dev exited");
            if (await fetch(`${url}/.well-known/agent-card.json`).then((r) => r.ok, () => false)) break;
            await new Promise((ok) => setTimeout(ok, 1000));
        }
        log(`indexing ${cfg.app} here, into ${w.r2_buckets[0].bucket_name}`);
        await fetch(`${url}/__scheduled?cron=${encodeURIComponent(w.triggers.crons[0])}`);
        let catalog = null;
        while (!(catalog?.generated_at >= start)) {
            if (wrangler.exitCode !== null) throw new Error("wrangler dev exited");
            await new Promise((ok) => setTimeout(ok, 5000));
            catalog = await fetch(`${url}/view/cdn/catalog`).then((r) => (r.ok ? r.json() : null), () => null);
        }
        log(`indexed: ${catalog.domains.length} domain(s), ${catalog.domains.reduce((n, d) => n + d.count, 0)} rows`);
        return catalog;
    } finally {
        wrangler.kill();
        rmSync(vars, { force: true });
    }
}

/**
 * A view from what the sources staged, with app.json's schema, touching no chain and no
 * site: what a recipe change would ship, built so it can be graded first (westmarch-eval).
 * The sources run without --publish, or not at all with crawl=false. Every build is whole
 * (a changed `text` role must reach every row, and publishView re-embeds only new CIDs);
 * `.ship/vectors.ndjson` keeps it cheap, so two recipes over the same data embed only the
 * text that differs.
 */
export async function buildLocal(configPath, out, { crawl = false, only = null, log: say = log } = {}) {
    const cfg = loadConfig(configPath);
    const base = dirname(resolve(configPath));
    const [{ env }, view] = await Promise.all([import("@huggingface/transformers"), import("./view.js")]);
    env.cacheDir = `${homedir()}/.cache/fangorn-mcp/models`;
    // Not the app's real id or owner: nothing here is compared with the chain.
    const appId = `0x${createHash("sha256").update(cfg.app).digest("hex")}`, owner = `0x${"10ca1".padStart(40, "0")}`;
    const chain = {};
    // Storage addresses a record by its content, and so does this.
    for (const [ns, records] of Object.entries(readStage(cfg, base, { crawl, only, log: say })))
        chain[`${owner}/${ns}`] = { records: records.map((r) => ({ ...r, cid: createHash("sha256").update(JSON.stringify(stable(r.payload))).digest("hex") })) };
    rmSync(out, { recursive: true, force: true });
    mkdirSync(join(base, ".ship"), { recursive: true });
    const embed = view.cachedEmbed(join(base, ".ship/vectors.ndjson"));
    const repos = [...new Set(cfg.sources.map((s) => s.namespace))].filter((n) => !only || only.includes(n));
    const report = await view.publishView({ fangorn: view.localFangorn(chain, { appId, owner }), app: cfg.app,
        schema: { types: cfg.types, relations: cfg.relations }, repos, out, embed, log: say });
    const rows = Object.values(report).reduce((n, r) => n + r.added, 0);
    say(`local view: ${out}  ·  ${rows} records, ${embed.misses} embedded, ${rows - embed.misses} from the vector cache`);
    return report;
}

// ── cli ───────────────────────────────────────────────────────────────────────
if (process.argv[1]?.endsWith("ship.js") || process.argv[1]?.endsWith("westmarch-ship")) {
    if (process.argv[2] === "--selfcheck") {
        const row = { city: "Wisconsin Rapids", state: "WI", site: "https://x", args: ["--archive-page", "/569/A"] };
        const cmd = fill(["py", "--site", "{site}", "--city", "{city}", "{args...}", "--ns", "us-{state|lower}-{city|slug}"], row);
        if (JSON.stringify(cmd) !== JSON.stringify(["py", "--site", "https://x", "--city", "Wisconsin Rapids", "--archive-page", "/569/A", "--ns", "us-wi-wisconsin-rapids"]))
            throw new Error(`template fill: ${JSON.stringify(cmd)}`);
        const w = wranglerConfig({ name: "quorum", site: "/s", config: { app: "quorum" }, url: "https://quorum.example" });
        if (w.r2_buckets[0].bucket_name !== "quorum-view" || !w.ai || !w.triggers.crons.length || w.routes[0].pattern !== "quorum.example"
            || !w.compatibility_flags.includes("nodejs_compat") || !existsSync(w.main) || !existsSync(w.alias["@huggingface/transformers"]))
            throw new Error(`wrangler config: ${JSON.stringify(w)}`);
        const d = discovery({ name: "Q", description: "q" }, "https://q.example", { price: "10000", decimals: 6, symbol: "USDC" });
        const op = d.openapi.paths["/paid"].post;
        if (op["x-payment-info"].price.min !== "0.01" || op["x-payment-info"].price.max !== "10" || !op.responses[402] || d.x402.resources[0] !== "https://q.example/paid")
            throw new Error(`discovery: ${JSON.stringify(d)}`);
        const dp = discovery({ name: "Q", description: "q" }, "https://q.example", null, { pass: "5000000", days: 30, call: "10000", decimals: 6 });
        if (dp.openapi.paths["/pass"].post["x-payment-info"].price.amount !== "5" || dp.x402.resources.join() !== "https://q.example/pass" || dp.openapi.paths["/paid"])
            throw new Error(`private discovery: ${JSON.stringify(dp.x402)}`);
        if (units("0.01") !== "10000" || units("5") !== "5000000" || units("1.5", 2) !== "150") throw new Error("units");
        if (USDC["eip155:84532"].name !== "USDC" || USDC["eip155:8453"].name !== "USD Coin") throw new Error("USDC's EIP-712 name differs on Base Sepolia and Base");
        console.log("ship.js self-check ok — a source template fills per row, the Worker config binds its bucket, AI and cron, and the paid route is priced per id in /openapi.json and named in /.well-known/x402");
        process.exit(0);
    }
    const [path, ...flags] = process.argv.slice(2);
    if (!path || flags.includes("--help")) {
        console.error("usage: westmarch-ship app.json [--no-crawl] [--no-deploy] [--dry-run] [--replace] [--only ns1,ns2]\n" +
                      "       westmarch-ship app.json --register [--dry-run]   (claim, empty site, card bound: no data)\n" +
                      "       westmarch-ship app.json --local <out> [--crawl] [--only ns1,ns2]   (no chain, no deploy)\n" +
                      "       westmarch-ship app.json --index   (the deployed app's indexer, once, on this machine)\n" +
                      "       westmarch-ship app.json --devnet [--crawl] [--only ns1,ns2] [--port 8787] [--ai]   (the whole app on this machine)");
        process.exit(path ? 0 : 2);
    }
    const only = flags.includes("--only") ? flags[flags.indexOf("--only") + 1].split(",") : null;
    if (flags.includes("--devnet")) {
        await devnetShip(path, { crawl: flags.includes("--crawl"), only, ai: flags.includes("--ai"),
                                 port: flags.includes("--port") ? Number(flags[flags.indexOf("--port") + 1]) : 8787 })
            .catch((e) => { console.error(`[ship] ✗ ${e.message}`); process.exit(1); });
        process.exit(0);
    }
    if (flags.includes("--index")) {
        await indexHere(path).catch((e) => { console.error(`[ship] ✗ ${e.message}`); process.exit(1); });
        process.exit(0);
    }
    if (flags.includes("--local")) {
        await buildLocal(path, resolve(flags[flags.indexOf("--local") + 1]), { crawl: flags.includes("--crawl"), only })
            .catch((e) => { console.error(`[ship] ✗ ${e.message}`); process.exit(1); });
        process.exit(0);
    }
    await ship(path, { crawl: !flags.includes("--no-crawl"), deploy: !flags.includes("--no-deploy"), dry: flags.includes("--dry-run"),
                       replace: flags.includes("--replace"), register: flags.includes("--register"), only })
        .catch((e) => { console.error(`[ship] ✗ ${e.message}`); process.exit(1); });
    process.exit(0);   // a CUDA embedder keeps the process alive (and can abort in its teardown)
}
