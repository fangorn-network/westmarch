#!/usr/bin/env node
// westmarch-ship: one config, one command, a live Fangorn app.
//
//   westmarch-ship app.json [--no-crawl] [--no-deploy] [--dry-run]
//   westmarch-ship app.json --local <out> [--crawl]     a view from staged records, no chain (see buildLocal)
//
// Every step checks the chain (or Cloudflare) first and only acts on a difference, so
// re-running is how you update: new data, a changed schema, a new source, a moved site.
//
//   1. claim the app (first run only; the claim block becomes the card's fromBlock)
//   2. join it as a publisher
//   3. commit the schema, if the one on chain differs from app.json's `types`
//   4. run each source, which crawls and publishes straight into the app
//   5. westmarch-view: the app's commits → site/view
//   6. the stock page, the card and _headers → site/
//   7. deploy to Cloudflare Pages
//   8. register the ERC-8004 agent and bind the card, if the chain points elsewhere
//
// Chain writes go through the `fangorn` CLI (its configured wallet signs, and
// `fangorn wallet` shows which). Reads go through the SDK. State lives in `.ship/` next
// to app.json: the site, the view (its own state, see view.js) and a small state.json.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const USDC = { "arbitrum-sepolia": "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d", arbitrum: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
               "base-sepolia": "0x036CbD53842c5426634e7929541eC2318f3dCF7e", base: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" };
const STOCK = join(HERE, "../site/dist");
const log = (s) => console.error(`[ship] ${s}`);

// ── config ────────────────────────────────────────────────────────────────────
//
// {
//   "app": "quorum", "name": "Quorum", "description": "…", "tags": ["civic"],
//   "site": { "project": "quorum", "account": "<cloudflare account id>",
//             "pages": "pages",   // optional: the app's own files, copied over the stock page
//             "nav": [{ "href": "coverage.html", "label": "Coverage" }],   // optional: header links to them
//             "agent": "app/agent.js" },   // optional: the module whose registerAgent the card lists, when
//                                          // `pages` replaces the stock index.html with a page of its own
//   "types": { "<tag>": { "description": "…", "role_map": {…}, "presentation": {…} } },
//   "relations": [{ "rel": "…", "from": "<tag>", "to": "<tag>" }],
//   "sources": [{ "namespace": "…", "cwd": "…", "command": ["python", "-m", "…", …] }],
//   "fangorn": "fangorn",     // the CLI that signs; e.g. "node ~/fangorn/fangorn/lib/cli/cli.js"
//   "paid": { "price": "0.01", "network": "arbitrum-sepolia", "description": "…" }
// }
//
// `paid` sells per-record detail over x402 (site/worker.js): each source that names a
// `paid_dir` gets `--paid-dir` and writes one JSON per record there; they are deployed
// behind the worker, and the price goes in the card. The payee is the app owner unless
// `paid.payTo` says otherwise; the asset is USDC on `paid.network` unless `paid.asset` does.
//
// A source is any command that publishes into `--namespace` when given `--publish`:
// quickbeam's scraper harness does, so every quickbeam Source is a source here. It runs
// with FANGORN_APP_ID set, so it publishes into this app whatever the CLI's saved app is.

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
    for (const k of ["app", "name", "description", "types", "sources", "site"])
        if (!c[k]) throw new Error(`${path}: missing "${k}"`);
    if (!c.site.project) throw new Error(`${path}: site.project names the Cloudflare Pages project`);
    for (const s of c.sources) if (!s.namespace || !Array.isArray(s.command))
        throw new Error(`${path}: each source needs a namespace and a command (an argv array)`);
    return { relations: [], tags: [], ...c };
}

/** The schema commit for `types` + `relations`: one fangorn.type.v1 vertex per type,
 *  one edge per allowed relation. */
export function schemaGraph(types, relations = []) {
    const id = (tag) => `type:${tag}`;
    return {
        vertices: Object.entries(types).map(([tag, t]) => ({ id: id(tag), tag: "fangorn.type.v1", payload: {
            tag, description: t.description ?? "", role_map: t.role_map ?? {}, presentation: t.presentation ?? {} } })),
        edges: relations.map((r) => ({ rel: r.rel, from: id(r.from), to: id(r.to) })),
    };
}

/** Keys sorted at every depth: the chain stores dag-cbor, whose maps come back in
 *  canonical key order, not the order app.json wrote them in. */
const stable = (v) => Array.isArray(v) ? v.map(stable)
    : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])])) : v;

/** Same shape parseSchema returns, so a config and the chain compare directly. */
const canonical = (types, relations = []) => JSON.stringify(stable({
    types: Object.fromEntries(Object.entries(types).sort(([a], [b]) => a.localeCompare(b))
        .map(([tag, t]) => [tag, { description: t.description ?? "", role_map: t.role_map ?? {}, presentation: t.presentation ?? {} }])),
    relations: [...relations].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
}));

// ── processes ─────────────────────────────────────────────────────────────────

/** `${VAR}` and `${VAR:-default}` from the environment, so one app.json runs on a laptop
 *  and in CI (e.g. `"${PYTHON:-python3}"`). */
export const expandEnv = (s) => s.replace(/\$\{(\w+)(?::-([^}]*))?\}/g, (_, k, d) => process.env[k] ?? d ?? "");

function run(cmd, args, { cwd, env, capture = false, dry = false } = {}) {
    cmd = expandEnv(cmd); args = args.map(expandEnv);
    log(`$ ${[cmd, ...args].join(" ")}${cwd ? `   (in ${cwd})` : ""}`);
    if (dry) return "";
    const r = spawnSync(cmd, args, { cwd, env: { ...process.env, ...env }, encoding: "utf8",
        stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit" });
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

export async function ship(configPath, { crawl = true, deploy = true, dry = false, replace = false, only = null } = {}) {
    const cfg = loadConfig(configPath);
    CLI = cliArgv(cfg);
    assertSameDeployment(CLI);
    const base = dirname(resolve(configPath));
    const dir = join(base, ".ship");
    const statePath = join(dir, "state.json");
    mkdirSync(dir, { recursive: true });
    const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};
    const save = () => !dry && writeFileSync(statePath, JSON.stringify(state, null, 1));

    const [{ FangornConfig }, { createPublicClient, http }, { env }, view, card] = await Promise.all([
        import("@fangorn-network/sdk"), import("viem"),
        import("@huggingface/transformers"), import("./view.js"), import("./agent-card.js"),
    ]);
    env.cacheDir = `${homedir()}/.cache/fangorn-mcp/models`;
    const fangorn = await view.readOnlyFangorn();
    fangorn.setAppId(cfg.app);
    const appId = fangorn.getAppId();
    const registry = fangorn.getAppRegistry();

    // 1. claim
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
    state.fromBlock ??= String(cfg.fromBlock ?? 0);
    log(`app ${cfg.app} = ${appId}, owner ${owner}, fromBlock ${state.fromBlock}`);

    // 2. join
    // Both registries: claiming joins the owner to the app, but commits also need the
    // wallet's global DataRegistry standing, or every push reverts NotRegistered().
    const info = fangornCli(cfg.app, ["app", "info"]);
    if (!/DataRegistry:\s+registered/.test(info) || !/This app:\s+joined/.test(info)) fangornCli(cfg.app, ["register"], { dry });

    // 3. schema
    let onChain = null;
    try { onChain = view.parseSchema((await fangorn.readNamespace(owner, view.SCHEMA_NAMESPACE)).contents); } catch { /* none yet */ }
    if (!onChain || canonical(onChain.types, onChain.relations) !== canonical(cfg.types, cfg.relations)) {
        const sdir = join(dir, "schema");
        mkdirSync(sdir, { recursive: true });
        writeFileSync(join(sdir, "graph.json"), JSON.stringify(schemaGraph(cfg.types, cfg.relations), null, 1));
        log(`schema ${onChain ? "changed" : "is new"}: committing ${Object.keys(cfg.types).join(", ")}`);
        fangornCli(cfg.app, ["repo", "init", view.SCHEMA_NAMESPACE], { cwd: sdir, dry });
        fangornCli(cfg.app, ["commit", "graph.json", "-m", "schema", "--replace"], { cwd: sdir, dry });
        fangornCli(cfg.app, ["push"], { cwd: sdir, dry });
    } else log("schema unchanged");

    // 4. sources: crawl + publish straight into the app. One source failing (a site that
    // blocks us, a feed that is down) keeps its last published data and does not stop the
    // others; the ship still exits non-zero at the end, naming it.
    const failed = [];
    if (crawl) for (const s of cfg.sources.filter((s) => !only || only.includes(s.namespace))) {
        const cwd = s.cwd ? resolve(base, s.cwd.replace(/^~/, homedir())) : base;
        const paidArgs = cfg.paid && s.paid_dir ? ["--paid-dir", resolve(cwd, s.paid_dir)] : [];
        try {
            run(s.command[0], [...s.command.slice(1), ...paidArgs, ...(replace ? ["--replace"] : []),
                               "--publish", "--namespace", s.namespace, "--fangorn-bin", CLI.join(" ")],
                { cwd, env: { FANGORN_APP_ID: cfg.app }, dry });
        } catch (e) {
            log(`✗ ${s.namespace}: ${e.message}; its last published records stay live`);
            failed.push(s.namespace);
        }
    }

    // 5. the view. Its files are its state: on a fresh machine (CI), start from the deployed
    // copy rather than re-embed everything. shard.js checks each shard against its manifest.
    const site = join(dir, "site");
    if (!existsSync(join(site, "view/cdn/catalog")) && state.url && !dry) await mirrorView(`${state.url}/view`, join(site, "view"));
    const namespaces = [...new Set(cfg.sources.map((s) => s.namespace))];
    const report = dry ? {} : await view.publishView({ fangorn, app: cfg.app, namespaces, out: join(site, "view"),
        fromBlock: BigInt(state.fromBlock), embed: view.cachedEmbed(join(dir, "vectors.ndjson")), log });

    // 6. the page, the card, the headers
    if (!existsSync(join(STOCK, "index.html"))) throw new Error(`no stock page at ${STOCK}; run \`npx vite build\` in westmarch/site`);
    mkdirSync(site, { recursive: true });
    for (const f of readdirSync(site, { withFileTypes: true })) if (f.name !== "view" && f.name !== "_paid") rmSync(join(site, f.name), { recursive: true, force: true });
    cpSync(STOCK, site, { recursive: true });
    if (cfg.site.pages) cpSync(resolve(base, cfg.site.pages), site, { recursive: true });
    writeFileSync(join(site, "nav.json"), JSON.stringify(cfg.site.nav ?? []));
    const url = deploy && !dry ? pagesUrl(cfg) : state.url ?? `https://${cfg.site.project}.pages.dev`;
    // Paid records: every source's paid_dir → site/_paid (served only through the worker).
    let paid = null, sale = null;
    const live = view.liveFields(join(site, "view"));
    if (cfg.paid) {
        const network = cfg.paid.network ?? "arbitrum-sepolia";
        const asset = cfg.paid.asset ?? USDC[network];
        if (!asset) throw new Error(`paid.network ${network}: no default USDC address; set paid.asset`);
        const decimals = cfg.paid.decimals ?? 6;
        const [whole, frac = ""] = String(cfg.paid.price).split(".");
        const price = (BigInt(whole) * 10n ** BigInt(decimals) + BigInt((frac + "0".repeat(decimals)).slice(0, decimals) || "0")).toString();
        paid = { url: `${url}/paid/{id}`, price, asset, network, decimals, symbol: cfg.paid.symbol ?? "USDC", description: cfg.paid.description ?? "" };
        // Only records a live row vouches for (its committed paid_sha256): one left over from
        // an item since removed or re-extracted is not for sale, whatever is still on disk.
        rmSync(join(site, "_paid"), { recursive: true, force: true });
        mkdirSync(join(site, "_paid"), { recursive: true });
        const vouched = new Set(live.map((f) => f.paid_sha256).filter(Boolean));
        let n = 0;
        for (const s of cfg.sources) {
            const d = s.paid_dir && resolve(s.cwd ? resolve(base, s.cwd.replace(/^~/, homedir())) : base, s.paid_dir);
            if (d && existsSync(d)) for (const f of readdirSync(d)) {
                const bytes = readFileSync(join(d, f));
                if (!vouched.has(createHash("sha256").update(bytes).digest("hex"))) continue;
                writeFileSync(join(site, "_paid", f), bytes); n++;
            }
        }
        sale = { price, network, asset, payTo: cfg.paid.payTo ?? owner, facilitator: cfg.paid.facilitator ?? "https://facilitator.payai.network",
                 name: cfg.paid.tokenName ?? "USD Coin", version: cfg.paid.tokenVersion ?? "2", description: paid.description };
        log(`paid: ${n} record(s) at ${cfg.paid.price} ${paid.symbol} on ${network}, to ${sale.payTo}`);
    }
    // The worker: paid records if any, and each record's source document shown in the page.
    // Only the hosts the app's own records link to (their media role) are proxied.
    const media = Object.values(cfg.types).flatMap((t) => [t.role_map?.media ?? []].flat());
    const docHosts = [...new Set(live.flatMap((f) => media.map((m) => f[m])).filter((u) => typeof u === "string" && u.startsWith("https://"))
        .map((u) => { try { return new URL(u).hostname; } catch { return null; } }).filter(Boolean))].sort();
    writeFileSync(join(site, "_worker.js"), readFileSync(join(HERE, "../site/worker.js"), "utf8")
        .replace(/\/\*CONFIG\*\/[\s\S]*?\/\*END\*\//, JSON.stringify({ docHosts, paid: sale })));
    log(`documents: shown inline from ${docHosts.length} source host(s)`);
    // The card lists the tools the page at `url` registers: the stock page's, or the app's own.
    const { registerAgent } = await import(cfg.site.agent ? pathToFileURL(resolve(base, cfg.site.agent)).href : "../site/agent.js");
    const agentCard = card.agentCard({
        name: cfg.name, description: cfg.description, url: `${url}/`, version: new Date().toISOString().slice(0, 10),
        tools: await card.captureTools(() => registerAgent({})), tags: cfg.tags,
        fangorn: { app: cfg.app, fromBlock: state.fromBlock, namespaces, views: [`${url}/view`], ...(paid ? { paid } : {}) },
    });
    mkdirSync(join(site, ".well-known"), { recursive: true });
    writeFileSync(join(site, ".well-known/agent-card.json"), JSON.stringify(agentCard, null, 1));
    const immutable = "  Cache-Control: public, max-age=31536000, immutable\n";
    const domains = existsSync(join(site, "view/cdn/domains")) ? readdirSync(join(site, "view/cdn/domains")) : [];
    writeFileSync(join(site, "_headers"),
        "/.well-known/agent-card.json\n  Access-Control-Allow-Origin: *\n"
        + "/view/*\n  Access-Control-Allow-Origin: *\n"
        + `/assets/*\n${immutable}`
        // An hour, not immutable: a shard is deleted when a record is retracted (see view.js).
        + domains.map((d) => `/view/cdn/domains/${d}/shards/*\n  Cache-Control: public, max-age=3600\n`).join(""));

    // 7. deploy
    if (deploy) {
        run("npx", ["wrangler", "pages", "deploy", site, "--project-name", cfg.site.project, "--branch", "main", "--commit-dirty=true"],
            { env: cfg.site.account ? { CLOUDFLARE_ACCOUNT_ID: cfg.site.account } : {}, dry });
        state.url = url;
        save();
    }

    // 8. ERC-8004 + the binding
    const cardUrl = `${url}/.well-known/agent-card.json`;
    const bound = await registry.appAgentUri(appId).catch(() => "");
    if (deploy && bound !== cardUrl) {
        log(`binding ${cardUrl} (on chain: ${bound || "nothing"})`);
        const out = dry ? "" : fangornCli(cfg.app, ["app", "agent", cardUrl]);
        state.agentId = (out.match(/Agent ID:\s+(\S+)/) ?? [])[1] ?? state.agentId;
        save();
    } else if (deploy) log("card already bound");

    const added = Object.values(report).reduce((n, r) => n + r.added, 0);
    log(`done: ${url}  ·  card ${cardUrl}  ·  agent ${state.agentId ?? "(unchanged)"}  ·  +${added} records embedded`);
    if (failed.length) throw new Error(`deployed, but these sources failed and kept their old records: ${failed.join(", ")}`);
    return { url, cardUrl, agentId: state.agentId, report };
}

/**
 * A view from what the sources staged, with app.json's schema, touching no chain and no
 * site: what a recipe change would ship, built so it can be graded first (westmarch-eval).
 * The sources run without --publish, or not at all with crawl=false. Every build is whole
 * (a changed `text` role must reach every row, and publishView re-embeds only new CIDs);
 * `.ship/vectors.ndjson` keeps it cheap, so two recipes over the same data embed only the
 * text that differs.
 *
 * ponytail: reads every `volume_<n>_*.json` but edges in a source's --output-dir; the
 * harness publishes only the stems its source declares, so a stale file left by an older
 * shape of a source is built here and not on chain. Clear the stage dir if that bites.
 */
export async function buildLocal(configPath, out, { crawl = false, only = null, log: say = log } = {}) {
    const cfg = loadConfig(configPath);
    const base = dirname(resolve(configPath));
    const [{ env }, view] = await Promise.all([import("@huggingface/transformers"), import("./view.js")]);
    env.cacheDir = `${homedir()}/.cache/fangorn-mcp/models`;
    // Not the app's real id or owner: nothing here is compared with the chain.
    const appId = `0x${createHash("sha256").update(cfg.app).digest("hex")}`, owner = `0x${"10ca1".padStart(40, "0")}`;
    const g = schemaGraph(cfg.types, cfg.relations);
    const chain = { [`${owner}/${view.SCHEMA_NAMESPACE}`]: {
        vertices: g.vertices.map((v) => ({ cid: v.id, schemaId: v.tag, payload: v.payload })),
        edges: g.edges.map((e) => ({ relation: e.rel, sourceCid: e.from, targetCid: e.to })) } };
    for (const s of cfg.sources.filter((s) => !only || only.includes(s.namespace))) {
        const cwd = s.cwd ? resolve(base, s.cwd.replace(/^~/, homedir())) : base;
        if (crawl) run(s.command[0], s.command.slice(1), { cwd, env: { FANGORN_APP_ID: cfg.app } });
        const at = s.command.indexOf("--output-dir");
        if (at < 0) { say(`${s.namespace}: no --output-dir in its command, so nothing staged to read`); continue; }
        const dir = resolve(cwd, expandEnv(s.command[at + 1]));
        const volume = s.command.includes("--volume") ? s.command[s.command.indexOf("--volume") + 1] : "1";
        const ns = (chain[`${owner}/${s.namespace}`] ??= { vertices: [], edges: [] });
        for (const f of existsSync(dir) ? readdirSync(dir).sort() : []) {
            const m = new RegExp(`^volume_${volume}_(.+)\\.json$`).exec(f);
            if (!m || m[1] === "edges") continue;
            // The harness publishes {id: name, tag: entity, payload: fields}; the chain
            // addresses it by the payload's hash, and so does this.
            for (const n of JSON.parse(readFileSync(join(dir, f), "utf8"))) ns.vertices.push({
                cid: createHash("sha256").update(JSON.stringify(stable(n.fields))).digest("hex"),
                schemaId: n.fields?.entityType ?? m[1][0].toUpperCase() + m[1].slice(1), payload: n.fields });
        }
    }
    // An empty stage is a crawl that did not happen (or a cache that was not restored), not
    // an app with no records; a view of it would grade as a failure for the wrong reason.
    const staged = Object.entries(chain).filter(([k]) => !k.endsWith(`/${view.SCHEMA_NAMESPACE}`)).reduce((n, [, c]) => n + c.vertices.length, 0);
    if (!staged) throw new Error("no staged records under any source's --output-dir: run the sources (--crawl, or a ship) or restore .ship/stage first");
    rmSync(out, { recursive: true, force: true });
    mkdirSync(join(base, ".ship"), { recursive: true });
    const embed = view.cachedEmbed(join(base, ".ship/vectors.ndjson"));
    const namespaces = [...new Set(cfg.sources.map((s) => s.namespace))].filter((n) => !only || only.includes(n));
    const report = await view.publishView({ fangorn: view.localFangorn(chain, { appId, owner }), app: cfg.app,
        namespaces, out, embed, log: say });
    const rows = Object.values(report).reduce((n, r) => n + r.added, 0);
    say(`local view: ${out}  ·  ${rows} records, ${embed.misses} embedded, ${rows - embed.misses} from the vector cache`);
    return report;
}

/** Copy a deployed view (catalog, manifests, shards) to `dir`, so the next publish appends. */
async function mirrorView(base, dir) {
    const get = async (p) => { const r = await fetch(`${base}/${p}`); if (!r.ok) throw new Error(`${base}/${p}: HTTP ${r.status}`); return r; };
    let catalog;
    try { catalog = await (await get("cdn/catalog")).json(); } catch (e) { log(`no deployed view to start from (${e.message})`); return; }
    const { createHash } = await import("node:crypto");
    let files = 0;
    for (const d of catalog.domains ?? []) {
        const m = await (await get(`cdn/domains/${d.name}/manifest`)).json();
        mkdirSync(join(dir, "cdn/domains", d.name, "shards"), { recursive: true });
        writeFileSync(join(dir, "cdn/domains", d.name, "manifest"), JSON.stringify(m, null, 1));
        for (const s of m.shards ?? []) {
            const buf = Buffer.from(await (await get(`cdn/domains/${d.name}/shards/${s.file}`)).arrayBuffer());
            if (s.sha256 && createHash("sha256").update(buf).digest("hex") !== s.sha256) throw new Error(`${s.file} does not match its manifest`);
            writeFileSync(join(dir, "cdn/domains", d.name, "shards", s.file), buf);
            files++;
        }
    }
    writeFileSync(join(dir, "cdn/catalog"), JSON.stringify(catalog, null, 1));
    log(`started from the deployed view: ${catalog.domains?.length ?? 0} domain(s), ${files} shard(s)`);
}

/** The project's pages.dev URL, creating the project on first use. Pages appends a
 *  suffix when the name is taken elsewhere, so the URL is read back, never assumed. */
function pagesUrl(cfg) {
    const env = cfg.site.account ? { CLOUDFLARE_ACCOUNT_ID: cfg.site.account } : {};
    const find = () => {
        const out = run("npx", ["wrangler", "pages", "project", "list"], { env, capture: true });
        const row = out.split("\n").find((l) => l.split("│")[1]?.trim() === cfg.site.project);
        const host = row?.match(/([a-z0-9-]+\.pages\.dev)/)?.[1];
        return host ? `https://${host}` : null;
    };
    let url = find();
    if (!url) {
        run("npx", ["wrangler", "pages", "project", "create", cfg.site.project, "--production-branch", "main"], { env });
        url = find();
    }
    if (!url) throw new Error(`could not read the pages.dev URL of project ${cfg.site.project}`);
    return url;
}

// ── cli ───────────────────────────────────────────────────────────────────────
if (process.argv[1]?.endsWith("ship.js") || process.argv[1]?.endsWith("westmarch-ship")) {
    if (process.argv[2] === "--selfcheck") {
        // The schema as committed, read back the way the chain returns it, must compare
        // equal to the config, or every run re-commits an unchanged schema.
        const { parseSchema } = await import("./view.js");
        const types = { "t.v1": { description: "d", role_map: { title: "name", text: ["body"] }, presentation: { externalUrl: { "t.v1": "{url}" } } },
                        "u.v1": { description: "e", role_map: { title: "label" } } };
        const relations = [{ rel: "cites", from: "t.v1", to: "u.v1" }];
        const g = schemaGraph(types, relations);
        // Keys reversed at every depth, as a canonical (sorted) encoding hands them back.
        const reverse = (v) => Array.isArray(v) ? v.map(reverse)
            : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).reverse().map((k) => [k, reverse(v[k])])) : v;
        const readBack = parseSchema({
            vertices: g.vertices.map((v) => ({ cid: `cid-${v.id}`, schemaId: v.tag, payload: reverse(v.payload) })),
            edges: g.edges.map((e) => ({ relation: e.rel, sourceCid: `cid-${e.from}`, targetCid: `cid-${e.to}` })),
        });
        if (canonical(readBack.types, readBack.relations) !== canonical(types, relations)) throw new Error("schema does not round-trip");
        if (canonical(readBack.types, readBack.relations) === canonical({ ...types, "v.v1": {} }, relations)) throw new Error("a new type must count as a change");
        const row = { city: "Wisconsin Rapids", state: "WI", site: "https://x", args: ["--archive-page", "/569/A"] };
        const cmd = fill(["py", "--site", "{site}", "--city", "{city}", "{args...}", "--ns", "us-{state|lower}-{city|slug}"], row);
        if (JSON.stringify(cmd) !== JSON.stringify(["py", "--site", "https://x", "--city", "Wisconsin Rapids", "--archive-page", "/569/A", "--ns", "us-wi-wisconsin-rapids"]))
            throw new Error(`template fill: ${JSON.stringify(cmd)}`);
        console.log("ship.js self-check ok — a committed schema reads back equal to its config, a new type counts as a change, and a source template fills per row");
        process.exit(0);
    }
    const [path, ...flags] = process.argv.slice(2);
    if (!path || flags.includes("--help")) {
        console.error("usage: westmarch-ship app.json [--no-crawl] [--no-deploy] [--dry-run] [--replace] [--only ns1,ns2]\n" +
                      "       westmarch-ship app.json --local <out> [--crawl] [--only ns1,ns2]   (no chain, no deploy)");
        process.exit(path ? 0 : 2);
    }
    const only = flags.includes("--only") ? flags[flags.indexOf("--only") + 1].split(",") : null;
    if (flags.includes("--local")) {
        await buildLocal(path, resolve(flags[flags.indexOf("--local") + 1]), { crawl: flags.includes("--crawl"), only })
            .catch((e) => { console.error(`[ship] ✗ ${e.message}`); process.exit(1); });
        process.exit(0);
    }
    await ship(path, { crawl: !flags.includes("--no-crawl"), deploy: !flags.includes("--no-deploy"), dry: flags.includes("--dry-run"),
                       replace: flags.includes("--replace"),
                       only })
        .catch((e) => { console.error(`[ship] ✗ ${e.message}`); process.exit(1); });
    process.exit(0);   // a CUDA embedder keeps the process alive (and can abort in its teardown)
}
