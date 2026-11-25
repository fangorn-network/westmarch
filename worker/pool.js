// The pool: many apps in one Worker, each app one Durable Object (`App`) with its own SQLite index. The alternative
// to worker/deploy.sh's Worker + D1 + cron per app: adding an app is a write, not a deploy, and an idle app costs
// only its storage.
//
// Each App runs worker/index.js unchanged: its `update` on an alarm (every RUN_EVERY ms) instead of a cron, and its
// `fetch` for the app's routes (/api.json, /view.json, /search, /mcp, /publish), over its own SQLite through a
// D1-shaped wrapper (worker/sql.js). Its config and gas key live in its storage; worker/tenant.js checks the one and
// seals the other. Vectors any app already made come from one shared cache (`Embeds`, worker/embeds.js).
//
//   <name>.<POOL_ZONE>/…              the app's routes, on its own Custom Domain (worker/domains.js)
//   /apps/<name>/…                    the same, by path, on any hostname the pool answers
//   GET    /_pool/apps                every app with its status, and the cache's
//   PUT    /_pool/apps/<name>         { …config } → create or update the app (and its hostname); its status, with
//                                     the gas wallet to fund if it publishes
//   GET    /_pool/apps/<name>         its status: config, wallet, hostname, paused, stitch, records, cache, last run
//   POST   /_pool/apps/<name>/pause   stop its runs; it keeps serving what it has
//   POST   /_pool/apps/<name>/resume  run again, from where it stopped
//   DELETE /_pool/apps/<name>         remove it: hostname, alarm, index and key gone (drain the wallet first)
// /_pool/* takes `Authorization: Bearer <ADMIN_TOKEN>`.
//
// Bindings: APPS (class App), DIRECTORY (class Directory), EMBEDS (class Embeds; optional), AI. Secrets ADMIN_TOKEN,
// MASTER_KEY (32 bytes, hex: seals each app's gas key), CF_API_TOKEN (optional: hostnames). Vars POOL_ZONE,
// POOL_SERVICE, CF_ACCOUNT_ID. See worker/pool.wrangler.example.json.
//
// Only handlers and classes may be exported here (the runtime reads every export as an entrypoint): helpers live in
// worker/tenant.js.

import { DurableObject } from "cloudflare:workers";
import { indexer, update } from "./index.js";
import { SCHEMA } from "../src/d1.js";
import { d1OfSql } from "./sql.js";
import { embedCache } from "./embeds.js";
import { domains, domainsOn } from "./domains.js";
import { appEnv, configOf, newKey, openKey, routeOf, NAME, RESERVED, RUN_EVERY } from "./tenant.js";

export { Embeds } from "./embeds.js";

const routes = indexer();
const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json", "access-control-allow-origin": "*" } });
const embedsOf = (env) => env.EMBEDS?.get(env.EMBEDS.idFromName("embeds"));

/** One app: its config, sealed gas key and index, its routes, and its update on an alarm. */
export class App extends DurableObject {
    constructor(ctx, env) {
        super(ctx, env);
        this.db = d1OfSql(ctx.storage);
        /** For tests: options worker/index.js's update takes (a fangorn client, step sizes). */
        this.runOpts = undefined;
        ctx.blockConcurrencyWhile(async () => { ctx.storage.sql.exec(SCHEMA); });
    }

    /** The env index.js runs this app with, or null when it isn't configured. */
    async appEnv() {
        const [config, sealed] = await Promise.all([this.ctx.storage.get("config"), this.ctx.storage.get("key")]);
        if (!config) return null;
        const store = embedsOf(this.env);
        return appEnv(this.env, { config, db: this.db, key: await openKey(this.env.MASTER_KEY, sealed), embedCache: store && ((o) => embedCache(store, o)) });
    }

    /** Create or update. A new app gets a gas key and its first run now; a changed config re-indexes on the next run. */
    async configure(name, input) {
        const config = configOf(name, input);
        this.ctx.storage.sql.exec(SCHEMA); // again after a remove: deleteAll drops the tables
        if (!(await this.ctx.storage.get("key"))) {
            const { address, sealed } = await newKey(this.env.MASTER_KEY);
            await this.ctx.storage.put({ key: sealed, address });
        }
        await this.ctx.storage.put({ name, config });
        if (!(await this.ctx.storage.get("paused")) && (await this.ctx.storage.getAlarm()) == null) await this.ctx.storage.setAlarm(Date.now());
        return this.status();
    }

    async setHostname(hostname) { hostname ? await this.ctx.storage.put("hostname", hostname) : await this.ctx.storage.delete("hostname"); }

    /** Stops its runs. It keeps serving what it has. */
    async pause() {
        if (!(await this.ctx.storage.get("config"))) return null;
        await this.ctx.storage.put("paused", true);
        await this.ctx.storage.deleteAlarm();
        return this.status();
    }

    /** Runs again now, from the saved stitch. */
    async resume() {
        if (!(await this.ctx.storage.get("config"))) return null;
        await this.ctx.storage.delete("paused");
        await this.ctx.storage.setAlarm(Date.now());
        return this.status();
    }

    async status() {
        const s = await this.ctx.storage.get(["name", "config", "address", "hostname", "paused", "lastRun", "lastError"]);
        if (!s.get("config")) return null;
        const one = (q) => this.ctx.storage.sql.exec(q).toArray()[0];
        const meta = (k) => JSON.parse(one(`SELECT v FROM meta WHERE k = '${k}'`)?.v ?? "null");
        const stitch = meta("stitch"), alarm = await this.ctx.storage.getAlarm();
        return {
            name: s.get("name"), config: s.get("config"), wallet: s.get("address"), hostname: s.get("hostname") ?? null,
            paused: Boolean(s.get("paused")), nextRun: alarm ? new Date(alarm).toISOString() : null,
            stitch: stitch && { root: stitch.root ?? null, block: stitch.t, caughtUp: stitch.caughtUp !== false },
            records: one("SELECT count(*) AS n FROM records").n, embedded: one("SELECT count(*) AS n FROM records WHERE vec IS NOT NULL").n,
            embedCache: meta("embedCache"),
            lastRun: s.get("lastRun") ?? null, lastError: s.get("lastError") ?? null,
        };
    }

    /** Gone: alarm, config, key and index. Its gas wallet's key goes with it, so drain the wallet first. */
    async remove() {
        await this.ctx.storage.deleteAlarm();
        await this.ctx.storage.deleteAll();
    }

    async fetch(req) {
        const env = await this.appEnv();
        return env ? routes.fetch(req, env) : json({ error: "no such app" }, 404);
    }

    /** One run of the app's update, then the next alarm. A removed or paused app stops here. */
    async alarm() {
        const env = await this.appEnv();
        if (!env || (await this.ctx.storage.get("paused"))) return;
        const name = await this.ctx.storage.get("name");
        try {
            await update(env, (m) => console.log(`${name}: ${m}`), this.runOpts);
            await this.ctx.storage.put("lastRun", new Date().toISOString());
            await this.ctx.storage.delete("lastError");
        } catch (e) {
            console.error(`${name}: ${e?.stack ?? e}`);
            await this.ctx.storage.put({ lastRun: new Date().toISOString(), lastError: String(e?.message ?? e) });
        } finally {
            // not if it was removed or paused while this run was out
            if ((await this.ctx.storage.get("config")) && !(await this.ctx.storage.get("paused"))) await this.ctx.storage.setAlarm(Date.now() + RUN_EVERY);
        }
    }
}

/** The app names in the pool: Durable Objects can't be listed, so this keeps the list. */
export class Directory extends DurableObject {
    constructor(ctx, env) {
        super(ctx, env);
        ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS apps (name TEXT PRIMARY KEY, created TEXT NOT NULL)");
    }
    async add(name) { this.ctx.storage.sql.exec("INSERT OR IGNORE INTO apps (name, created) VALUES (?, ?)", name, new Date().toISOString()); }
    async remove(name) { this.ctx.storage.sql.exec("DELETE FROM apps WHERE name = ?", name); }
    async list() { return this.ctx.storage.sql.exec("SELECT name, created FROM apps ORDER BY name").toArray(); }
}

const authorized = (req, env) => {
    const got = new TextEncoder().encode(req.headers.get("authorization") ?? ""), want = new TextEncoder().encode(`Bearer ${env.ADMIN_TOKEN}`);
    return Boolean(env.ADMIN_TOKEN) && got.byteLength === want.byteLength && crypto.subtle.timingSafeEqual(got, want);
};

/** The fleet: each app's status without its config, and the shared cache's size. */
async function fleet(env, directory) {
    const apps = await Promise.all((await directory.list()).map(async ({ name, created }) => {
        const s = await env.APPS.get(env.APPS.idFromName(name)).status();
        if (!s) return { name, created, missing: true };
        const { config, ...rest } = s;
        return { ...rest, created, follow: config.follow ?? config.repos };
    }));
    return { apps, embedCache: (await embedsOf(env)?.stats()) ?? null };
}

async function admin(req, env, name, action, { cf = domainsOn(env) && domains(env) } = {}) {
    if (!authorized(req, env)) return json({ error: "Authorization: Bearer <ADMIN_TOKEN>" }, 401);
    const directory = env.DIRECTORY.get(env.DIRECTORY.idFromName("directory"));
    if (!name) return req.method === "GET" ? json(await fleet(env, directory)) : json({ error: "GET" }, 405);
    if (!NAME.test(name) || RESERVED.has(name)) return json({ error: `app name "${name}": lowercase letters, digits and dashes, not reserved` }, 400);
    const app = env.APPS.get(env.APPS.idFromName(name));
    const found = (s) => (s ? json(s) : json({ error: "no such app" }, 404));
    if (action) return req.method === "POST" ? found(await app[action]()) : json({ error: "POST" }, 405);
    if (req.method === "GET") return found(await app.status());
    if (req.method === "DELETE") {
        if (cf) await cf.remove(name);
        await app.remove();
        await directory.remove(name);
        return json({ removed: name });
    }
    if (req.method !== "PUT") return json({ error: "GET, PUT or DELETE" }, 405);
    const input = await req.json().catch(() => undefined);
    let status;
    try { status = await app.configure(name, input); }
    catch (e) { return json({ error: String(e?.message ?? e) }, 400); }
    await directory.add(name);
    // Its hostname: on failure the app still runs, by path, and the error says why.
    if (cf && !status.hostname) {
        try { await app.setHostname(await cf.ensure(name)); status = await app.status(); }
        catch (e) { status = { ...status, hostnameError: String(e?.message ?? e) }; }
    }
    return json(status);
}

export default {
    async fetch(req, env, ctx, opts) {
        const url = new URL(req.url), m = url.pathname.match(/^\/_pool\/apps(?:\/([^/]*))?(?:\/(pause|resume))?\/?$/);
        if (m) return admin(req, env, m[1], m[2], opts);
        const route = routeOf(req, env.POOL_ZONE);
        if (!route) return json({ error: `no app here: <name>.${env.POOL_ZONE ?? "<POOL_ZONE>"} or /apps/<name>/` }, 404);
        return env.APPS.get(env.APPS.idFromName(route.name)).fetch(route.req);
    },
};
