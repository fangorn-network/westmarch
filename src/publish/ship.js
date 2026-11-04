#!/usr/bin/env node
// westmarch-ship: one config, one command, a live Fangorn app on the free tier.
//
//   westmarch-ship app.json [--no-crawl] [--no-deploy] [--dry-run]
//   westmarch-ship app.json --local <out> [--crawl]     a view from staged records, no chain (see buildLocal)
//   westmarch-ship app.json --register                  the app alone: its repo, empty site, card bound
//   westmarch-ship app.json --devnet [--only …]         the whole app on this machine (see devnetShip)
//   westmarch-ship app.json --index                     the deployed app's indexer, once, here (see indexHere)
//
// The app is one Cloudflare Worker (site/worker.js): its indexer (a cron that runs the
// embedding lens over everything the app presents, into R2), its view, its MCP endpoint
// (/mcp) and its site. Nothing is embedded here. Every step checks the chain (or
// Cloudflare) first and only acts on a difference, so re-running is how you update.
//
//   1. the app's repo, `<your wallet> : app` (first run only; that block becomes the card's fromBlock)
//   2. run each source, which crawls and publishes straight into the app
//   3. the stock page, the card and _headers → .ship/site
//   4. deploy the Worker: its R2 bucket, Workers AI, the cron, CONFIG (app.json's schema rides in it)
//   5. register the ERC-8004 agent and point the repo's @card at the card, if it points elsewhere
//
// The Worker picks up what 2 published on its next cron run (every few minutes),
// so the view follows the chain with nobody running anything.
//
// --register is the fast path, run before there is any data: 1, 3, 4 and 5 pointing at the card
// without minting. The mint copies the card's skills into its IPFS registration file and is
// never redone, so it waits for the first full ship, when the card lists what the app does.
//
// Chain writes go through the `fangorn` CLI (its configured wallet signs, and
// `fangorn wallet` shows which). Reads go through the SDK. State lives in `.ship/` next
// to app.json: the site, the Worker's config and a small state.json.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
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
//             "examples": ["…"],  // optional: questions to start from, on the front page
//             "plugin": {"marketplace": "owner/repo", "name": "…"},   // optional: its Claude Code plugin (hooks), named in its card
//             "skill": "skill/SKILL.md",   // optional: the app's agent skill, served at skill/<app>/SKILL.md and named
//                                          //   in the card with its sha256; fangorn-index offers it to whoever opens the app
//             "agent": "app/agent.js" },   // optional: the module whose registerAgent the card lists, when
//                                          // `pages` replaces the stock index.html with a page of its own
//   "types": { "<tag>": { "description": "…", "role_map": {…}, "presentation": {…} } },
//   "relations": [{ "rel": "…", "from": "<tag>", "to": "<tag>" }],
//   "sources": [{ "namespace": "…", "cwd": "…", "command": ["python", "-m", "…", …] }],
//   "live": ["readings"],     // optional: namespaces members push to from their own wallets (devices,
//                             //   contributors), presented beside the sources'; true = every repo they push.
//                             //   Without sources the app already presents every member's repo.
//   "network": "baseSepolia", // required: the SDK's network name
//   "owner": "0x…",           // the wallet that publishes the app's repo; only `westmarch build` (the
//                             //   deploy button) needs it, westmarch-ship asks the CLI
//   "fangorn": "fangorn",     // the CLI that signs; e.g. "node ~/fangorn/fangorn/lib/cli/cli.js",
//                             //   or "env HOME=<dir> node …/cli.js" to sign with <dir>/.fangorn/config.json
//   "paid": true,             // optional: the app quotes its records' prices over x402
//   "facilitator": "https://…" // with paid: the x402 facilitator its quotes settle through (Barliman)
// }
//
// An app sells nothing itself: publishers seal and price their own records (`fangorn commit
// --paid body --price 0.01`), and the app presents them. With `paid`, the Worker answers
// GET /paid/<record id> with an x402 402 built from the record's signed terms, paid through
// Barliman (CONFIG.facilitator); the buyer then settles and gets the key from the key server.
//
// A source is any command that publishes into the repo `--namespace` names when given
// `--publish`.

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
    if (c.live != null && c.live !== true && !(Array.isArray(c.live) && c.live.every((n) => typeof n === "string")))
        throw new Error(`${path}: live is true (every repo members push) or a list of the namespaces they push to`);
    return { relations: [], tags: [], types: {}, ...c };
}

/** The repo names the view presents: the sources' namespaces plus `live`'s, the ones members push
 *  to themselves (devices, contributors). [] means every repo the app presents: no sources, or live: true. */
export function presentedRepos(cfg) {
    if (cfg.live === true) return [];
    return [...new Set([...cfg.sources.map((s) => s.namespace), ...(cfg.live ?? [])])];
}

/** The Worker's wrangler config: the stock worker, the site as its assets, its bucket, the AI
 *  binding, the cron and CONFIG. `worker` is site/worker.js unless a test points elsewhere. */
export function wranglerConfig({ name, site, account, cron = "*/5 * * * *", cpuMs, config, url, ipfsGateway, worker = join(HERE, "../../site/worker.js") }) {
    return {
        name, main: worker, compatibility_date: "2025-09-15", compatibility_flags: ["nodejs_compat"],
        ...(account ? { account_id: account } : {}),
        // site.cpu_ms: the indexer's CPU per run. Reading one big commit (50k records) outlasts the
        // 30 s Workers Paid default; up to 300000. The Free plan refuses the deploy with it set.
        ...(cpuMs ? { limits: { cpu_ms: cpuMs } } : {}),
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
const fangornCli = (args, opts = {}) => run(CLI[0], [...CLI.slice(1), ...args], { capture: true, ...opts });

/** The CLI must be the SDK version westmarch reads with. A different one signs against
 *  another deployment's contracts: its commits land where nothing here looks. (It happened: a global 2026.08.18-dev CLI
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

/** The template's app.json as `app`'s: its name, its type tag `<app>.item.v1` and the Worker. */
export const TEMPLATE_APP = "my-app";
export function nameApp(cfg, app) {
    const from = `${TEMPLATE_APP}.item.v1`, tag = `${app}.item.v1`;
    const types = Object.fromEntries(Object.entries(cfg.types ?? {}).map(([k, t]) =>
        k === from ? [tag, JSON.parse(JSON.stringify(t).replaceAll(from, tag))] : [k, t]));
    return { ...cfg, app, name: cfg.name === TEMPLATE_APP ? app : cfg.name, types,
             site: { ...cfg.site, project: app.replace(/[._]/g, "-") } };   // a Worker name: letters, digits, dashes
}

/**
 * `westmarch build`: what Workers Builds runs under the deploy button. The site, with a card
 * that names ORIGIN for its own URL (the Worker fills it in), and CONFIG, into the app's own
 * wrangler.json, which `wrangler deploy` then ships with the bucket, AI and cron it declares.
 * No chain writes and no Cloudflare calls: the owner makes the repo and registers its agent
 * from fangorn.network. While app.json still names the template's app, the app is the Worker's name.
 */
export async function buildForDeploy(configPath, wranglerPath = join(dirname(resolve(configPath)), "wrangler.json")) {
    const w = JSON.parse(readFileSync(wranglerPath, "utf8"));
    let cfg = loadConfig(configPath);
    if (cfg.app === TEMPLATE_APP) cfg = nameApp(cfg, w.name);
    if (!cfg.network) throw new Error(`${configPath}: "network" is required`);
    if (!/^0x[0-9a-fA-F]{40}$/.test(cfg.owner ?? "")) throw new Error(`${configPath}: "owner" is required: the wallet that publishes the app's repo`);
    if (!w.r2_buckets?.[0]?.bucket_name?.includes(w.name))
        log(`the R2 bucket ${w.r2_buckets?.[0]?.bucket_name} doesn't name the Worker; two apps sharing one overwrite each other's view`);

    process.env.FANGORN_NETWORK = process.env.CHAIN_NAME = cfg.network;
    const view = await import("./view.js");
    const FangornConfig = await view.network(cfg.network);
    const fromBlock = String(cfg.fromBlock ?? FangornConfig.fromBlock);

    const base = dirname(resolve(configPath));
    const { site, writeCard } = await buildSite(cfg, base);
    writeCard(view.ORIGIN, { owner: cfg.owner, fromBlock, repos: [] });
    const gateway = process.env.FANGORN_IPFS_GATEWAY;
    w.assets = { ...w.assets, directory: relative(dirname(resolve(wranglerPath)), site) };
    w.vars = { ...w.vars, CONFIG: { app: cfg.app, name: cfg.name, description: cfg.description, fromBlock, network: cfg.network,
                                    schema: { types: cfg.types, relations: cfg.relations }, repos: [], paid: false },
               ...(gateway ? { IPFS_GATEWAY: gateway } : {}) };
    writeFileSync(wranglerPath, JSON.stringify(w, null, 1) + "\n");
    log(`built ${cfg.app} (fromBlock ${fromBlock}) into ${site}; wrangler deploy ships it`);
}

// ── the steps ─────────────────────────────────────────────────────────────────

export async function ship(configPath, { crawl = true, deploy = true, dry = false, replace = false, only = null, register = false } = {}) {
    const cfg = loadConfig(configPath);
    // No sources is fine: the app then presents every repo on chain (repos: [] = all of them), as the explorer does.
    if (!register && cfg.sources.length && !Object.keys(cfg.types).length)
        throw new Error(`${configPath}: no types yet, so nothing to build; --register sets up the app alone`);
    if (!cfg.network) throw new Error(`${configPath}: "network" is required, e.g. "baseSepolia"`);
    if (cfg.paid && !cfg.facilitator) throw new Error(`${configPath}: "paid" needs "facilitator", the URL of the x402 facilitator (Barliman) its quotes settle through`);
    CLI = cliArgv(cfg);
    assertSameDeployment(CLI);
    const base = dirname(resolve(configPath));
    const dir = join(base, ".ship");
    const statePath = join(dir, "state.json");
    mkdirSync(dir, { recursive: true });
    const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};
    const save = () => !dry && writeFileSync(statePath, JSON.stringify(state, null, 1));
    // The SDK's network name: view.js reads with it, and the CLI and the sources spawned below sign on it.
    process.env.FANGORN_NETWORK = process.env.CHAIN_NAME = cfg.network;
    const [{ createPublicClient, http }, view] = await Promise.all([import("viem"), import("./view.js")]);
    const FangornConfig = await view.network(cfg.network);
    const fangorn = await view.readOnlyFangorn();
    const cf = cfg.site.account ? { CLOUDFLARE_ACCOUNT_ID: cfg.site.account } : {};

    // 1. the app's repo: this wallet's `cfg.app`. Repo names are per publisher, so there is nothing to claim.
    const me = (fangornCli(["wallet"]).match(/Address:\s+(0x[0-9a-fA-F]{40})/) ?? [])[1];
    if (!me) throw new Error("`fangorn wallet` shows no address; run `fangorn init`");
    const chain = createPublicClient({ transport: http(FangornConfig.rpcUrl) });
    const repoDir = join(dir, "repo");
    if (!(await fangorn.onChainTip(me, cfg.app))) {
        // Its own records start now; an app presenting every repo (the explorer) reads from the deployment's start.
        if (presentedRepos(cfg).length) state.fromBlock = String(await chain.getBlockNumber());
        log(`creating the app's repo ${me}:${cfg.app}`);
        mkdirSync(repoDir, { recursive: true });
        fangornCli(["repo", "init", cfg.app], { cwd: repoDir, dry });
        save();
    }
    state.fromBlock ??= String(cfg.fromBlock ?? FangornConfig.fromBlock);
    log(`app ${me}:${cfg.app}, fromBlock ${state.fromBlock}`);

    // 2. sources: crawl + publish straight into the app. One source failing (a site that
    // blocks us, a feed that is down) keeps its last published data and does not stop the
    // others; the ship still exits non-zero at the end, naming it.
    const failed = [];
    if (crawl && !register) for (const s of cfg.sources.filter((s) => !only || only.includes(s.namespace))) {
        const cwd = s.cwd ? resolve(base, s.cwd.replace(/^~/, homedir())) : base;
        try {
            run(s.command[0], [...s.command.slice(1), ...(replace ? ["--replace"] : []),
                               "--publish", "--namespace", s.namespace, "--fangorn-bin", CLI.join(" ")], { cwd, dry });
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
    const repos = presentedRepos(cfg);
    const writeSite = (u) => writeCard(u, { owner: me, fromBlock: state.fromBlock, repos, paid: !!cfg.paid });
    writeSite(url ?? `https://${cfg.site.project}.workers.dev`);

    // 4. the Worker
    const workerConfig = (u) => {
        const path = join(dir, "wrangler.json");
        writeFileSync(path, JSON.stringify(wranglerConfig({
            name: cfg.site.project, site, account: cfg.site.account, cron: cfg.site.cron, cpuMs: cfg.site.cpu_ms, url: cfg.site.url, ipfsGateway: view.ipfsGateway(),
            config: { app: cfg.app, name: cfg.name, description: cfg.description, fromBlock: state.fromBlock, network: cfg.network,
                      schema: { types: cfg.types, relations: cfg.relations }, repos: register ? [] : repos, paid: !!cfg.paid,
                      ...(cfg.facilitator ? { facilitator: cfg.facilitator } : {}) },
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
    } else workerConfig(url ?? `https://${cfg.site.project}.workers.dev`);

    // 5. ERC-8004 + the repo's @card
    const cardUrl = `${url}/.well-known/agent-card.json`;
    const bound = (await fangorn.cardOf(me, cfg.app).catch(() => undefined)) ?? "";
    const mint = () => {
        const out = dry ? "" : fangornCli(["card", cardUrl, "--repo", cfg.app]);
        state.agentId = (out.match(/Agent ID:\s+(\S+)/) ?? [])[1] ?? state.agentId;
        delete state.agentPending;
        save();
    };
    if (deploy && bound !== cardUrl && register) {
        log(`binding ${cardUrl} (on chain: ${bound || "nothing"}); the agent is minted on the first full ship`);
        fangornCli(["card", cardUrl, "--repo", cfg.app, "--skip-register"], { dry });
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
    if (deploy && !dry && !register && (cfg.sources.length || cfg.live) && !await fetch(`${url}/view/cdn/catalog`).then((r) => r.ok, () => false)) {
        log("no view yet: indexing it here rather than waiting for the cron");
        await indexHere(configPath).catch((e) => log(`✗ first index: ${e.message}; the cron will build it`));
    }

    log(`done: ${url}  ·  card ${cardUrl}  ·  MCP ${url}/mcp  ·  the view fills on the Worker's next cron run`);
    if (failed.length) throw new Error(`deployed, but these sources failed and kept their old records: ${failed.join(", ")}`);
    return { url, cardUrl, agentId: state.agentId };
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
    // site.skill: the app's agent skill (a SKILL.md), served at skill/<app>/SKILL.md and named in the
    // card with its hash, so fangorn-index can offer it to whoever opens the app.
    let skill = null;
    if (cfg.site.skill) {
        const bytes = readFileSync(resolve(base, cfg.site.skill));
        mkdirSync(join(site, "skill", cfg.app), { recursive: true });
        writeFileSync(join(site, "skill", cfg.app, "SKILL.md"), bytes);
        skill = { path: `skill/${cfg.app}/SKILL.md`, sha256: createHash("sha256").update(bytes).digest("hex") };
    }
    // The card lists the tools the page at `url` registers: the stock page's, or the app's own.
    const card = await import("../agent/agent-card.js");
    const { registerAgent } = await import(cfg.site.agent ? pathToFileURL(resolve(base, cfg.site.agent)).href : "../../site/agent.js");
    const tools = await card.captureTools(() => registerAgent({}));
    const config = await (await import("./view.js")).network(cfg.network);
    const writeCard = (u, { owner, fromBlock, repos, paid = false }) => {
        const agentCard = card.agentCard({
            name: cfg.name, description: cfg.description, url: `${u}/`, version: new Date().toISOString().slice(0, 10), tools, tags: cfg.tags,
            // What is sold, as a skill tagged x402: ERC-8004 registration reads x402Support off the tags.
            skills: paid ? [{ id: "records", name: "Paid records", tags: [...(cfg.tags ?? []), "x402"],
                description: `Records whose publishers sell fields (rows with a \`sale\`): GET ${u}/paid/{publisher}/{repo}/{id} quotes one over x402 (scheme "fangorn").` }] : [],
            fangorn: { app: cfg.app, owner, fromBlock, repos, views: [`${u}/view`], mcp: `${u}/mcp`, config, ...(paid ? { paid: { url: `${u}/paid/{publisher}/{repo}/{id}` } } : {}),
                       ...(skill ? { skill: { url: `${u}/${skill.path}`, sha256: skill.sha256 } } : {}),
                       ...(cfg.site.plugin ? { plugin: cfg.site.plugin } : {}) },
        });
        mkdirSync(join(site, ".well-known"), { recursive: true });
        writeFileSync(join(site, ".well-known/agent-card.json"), JSON.stringify(agentCard, null, 1));
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
 * The whole app on this machine (devnet.js): a local chain and IPFS, what the sources staged published there, and its Worker under
 * `wrangler dev` with a local R2 and an encoder on localhost (or Workers AI with ai=true).
 * Runs the indexer once, says where everything is, and stays up until interrupted.
 */
export async function devnetShip(configPath, { crawl = false, only = null, port = 8787, ai = false } = {}) {
    const cfg = loadConfig(configPath);
    const base = dirname(resolve(configPath));
    const { devnet } = await import("./devnet.js");
    const staged = readStage(cfg, base, { crawl, only });
    const net = await devnet({ log });
    // A paid app's services, as a deployment runs them: the key server publishers deposit with,
    // and Barliman, which its quotes settle through.
    const services = cfg.paid ? await Promise.all([net.keyServer(), net.relay()]).then(([keys, r]) => ({ keys, relay: r.url })) : null;
    const owner = await net.client();
    // The owner publishes the sources, as `fangorn` does in a ship.
    for (const [ns, records] of Object.entries(staged)) {
        if (!records.length) continue;
        await owner.initRepo(ns);
        await owner.uploadBatch(ns, records);
        log(`published ${ns}: ${records.length} records`);
    }

    const url = `http://127.0.0.1:${port}`;
    const repos = Object.keys(staged);
    const { site, writeCard } = await buildSite(cfg, base);
    writeCard(url, { owner: owner.getAddress(), fromBlock: "0", repos, paid: !!services });
    const wcfg = wranglerConfig({ name: cfg.site.project, site, config: { app: cfg.app, name: cfg.name, description: cfg.description,
        fromBlock: "0", schema: { types: cfg.types, relations: cfg.relations }, repos, paid: !!services, deployment: net.deployment,
        ...(services ? { facilitator: services.relay } : {}) } });
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
    // ponytail: the devnet's IPFS is in this process's memory, so records are sold from here (sealRecords),
    // not from a separate `fangorn` CLI; scripts/e2e-paid.mjs does exactly that.
    if (services) log(`paid: key server ${services.keys}  ·  Barliman ${services.relay}`);
    await new Promise((r) => wrangler.on("exit", r));
}

/**
 * The deployed app's indexer, run once on this machine: its Worker under `wrangler dev` with
 * the app's own R2 bucket and Workers AI (remote bindings) and its CONFIG. The first view right after a
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
    const wpath = join(dir, "wrangler.index.json");
    writeFileSync(wpath, JSON.stringify(w, null, 1));
    const url = `http://127.0.0.1:${port}`, start = Math.floor(Date.now() / 1000);
    const wrangler = spawn("npx", ["wrangler", "dev", "--config", wpath, "--port", String(port), "--ip", "127.0.0.1", "--test-scheduled"],
        { cwd: join(HERE, "../.."), stdio: ["ignore", "pipe", "inherit"],
          env: { ...process.env, ...(cfg.site.account ? { CLOUDFLARE_ACCOUNT_ID: cfg.site.account } : {}) } });
    // A run already holds the lock (the deployed cron's): this one skips, and the catalog would never move.
    let skipped = false;
    wrangler.stdout.on("data", (b) => { process.stdout.write(b); if (String(b).includes("index: a run is in progress; skipped")) skipped = true; });
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
            if (skipped) throw new Error("another indexer run holds the lock (the deployed cron's, most likely); it frees within 2 minutes of that run dying. Try again then.");
            await new Promise((ok) => setTimeout(ok, 5000));
            catalog = await fetch(`${url}/view/cdn/catalog`).then((r) => (r.ok ? r.json() : null), () => null);
        }
        log(`indexed: ${catalog.domains.length} domain(s), ${catalog.domains.reduce((n, d) => n + d.count, 0)} rows`);
        return catalog;
    } finally {
        wrangler.kill();
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
    // Not the app's real owner: nothing here is compared with the chain.
    const owner = `0x${"10ca1".padStart(40, "0")}`;
    const chain = {};
    // Storage addresses a record by its content, and so does this.
    if (cfg.sources.length) for (const [ns, records] of Object.entries(readStage(cfg, base, { crawl, only, log: say })))
        chain[`${owner}/${ns}`] = { records: records.map((r) => ({ ...r, cid: createHash("sha256").update(JSON.stringify(stable(r.payload))).digest("hex") })) };
    // What members already pushed to the live namespaces, read from the chain (reads only, no gas),
    // so a recipe is graded on contributed data too, not just on what the sources staged.
    if (cfg.live) {
        if (cfg.network) process.env.FANGORN_NETWORK = process.env.CHAIN_NAME = cfg.network;
        const fangorn = await view.readOnlyFangorn();
        const statePath = join(base, ".ship/state.json");
        const fromBlock = (existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")).fromBlock : null) ?? cfg.fromBlock;
        const staged = new Set(cfg.sources.map((s) => s.namespace));
        for (const t of await fangorn.repos(fromBlock == null ? {} : { fromBlock: BigInt(fromBlock) })) {
            if (t.repo === "fangorn.schema" || staged.has(t.repo) || (only && !only.includes(t.repo))
                || (cfg.live !== true && !cfg.live.includes(t.repo))) continue;
            const { contents } = await fangorn.readRepo(t.owner, t.repo);
            chain[`${t.owner.toLowerCase()}/${t.repo}`] = { records: contents.records };
            say(`live ${t.owner}/${t.repo}: ${contents.records.length} records, from the chain`);
        }
    }
    if (!Object.keys(chain).length) throw new Error("nothing to build: no sources staged anything and no publisher has pushed to a live namespace");
    rmSync(out, { recursive: true, force: true });
    mkdirSync(join(base, ".ship"), { recursive: true });
    const embed = view.cachedEmbed(join(base, ".ship/vectors.ndjson"));
    const repos = presentedRepos(cfg).filter((n) => !only || only.includes(n));
    const report = await view.publishView({ fangorn: view.localFangorn(chain), app: cfg.app,
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
        const src = [{ namespace: "towns", command: ["py"] }];
        if (presentedRepos({ sources: src }).join() !== "towns" || presentedRepos({ sources: src, live: ["readings", "towns"] }).join() !== "towns,readings"
            || presentedRepos({ sources: src, live: true }).length || presentedRepos({ sources: [] }).length)
            throw new Error("presentedRepos: sources plus live namespaces; [] (every repo) for live: true or no sources");
        console.log("ship.js self-check ok — a source template fills per row, the Worker config binds its bucket, AI and cron, and presentedRepos merges sources and live namespaces");
        process.exit(0);
    }
    const [path, ...flags] = process.argv.slice(2);
    if (!path || flags.includes("--help")) {
        console.error("usage: westmarch-ship app.json [--no-crawl] [--no-deploy] [--dry-run] [--replace] [--only ns1,ns2]\n" +
                      "       westmarch-ship app.json --register [--dry-run]   (the app's repo, empty site, card bound: no data)\n" +
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
