import { test, expect } from "vitest";
import { memoryNetwork } from "@fangorn-network/sdk/lib/test/testbed.js";
import { privateKeyToAccount } from "viem/accounts";
import { timingSafeEqual } from "node:crypto";
import pool, { App, Directory, Embeds } from "./pool.js";
import { configOf, newKey, openKey, routeOf } from "./tenant.js";
import { domains } from "./domains.js";
import { d1Index, SCHEMA } from "../src/d1.js";
import { d1Shim, fakeEmbedder } from "../src/testing.js";
import { stitcher } from "../src/stitcher.js";

// The pool on the in-memory network, with a stand-in for a Durable Object's storage over node:sqlite: the same calls
// (sql.exec → cursor, the key-value API, alarms, transactionSync), BLOBs as ArrayBuffers as the runtime gives them.

crypto.subtle.timingSafeEqual ??= (a, b) => timingSafeEqual(a, b); // Workers-only, used by the admin auth

const MASTER_KEY = "11".repeat(32), ADMIN_TOKEN = "let-me-in";
/** Workers AI that embeds by text length, counting the texts it was asked for. */
const fakeAI = () => {
    const ai = { texts: 0, run: async (_, { text }) => { ai.texts += text.length; return { data: text.map((t) => Array.from({ length: 768 }, (_, i) => ((t.length + i) % 7) / 7)) }; } };
    return ai;
};

async function doStorage() {
    const { DatabaseSync } = await import("node:sqlite");
    let db = new DatabaseSync(":memory:"), kv = new Map(), alarm = null;
    const arg = (v) => (v instanceof ArrayBuffer ? new Uint8Array(v) : v);
    const out = (r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v instanceof Uint8Array ? v.slice().buffer : v]));
    const sql = {
        exec(query, ...args) {
            // Several statements (a schema) run whole; node:sqlite prepares only one.
            if (!args.length && /;\s*\S/.test(query.trim().replace(/;$/, ""))) { db.exec(query); return { toArray: () => [] }; }
            const st = db.prepare(query);
            const rows = st.columns().length ? st.all(...args.map(arg)).map(out) : (st.run(...args.map(arg)), []);
            return { toArray: () => rows };
        },
    };
    return {
        sql,
        transactionSync(fn) {
            db.exec("BEGIN");
            try { const r = fn(); db.exec("COMMIT"); return r; } catch (e) { db.exec("ROLLBACK"); throw e; }
        },
        async get(k) { return Array.isArray(k) ? new Map(k.filter((x) => kv.has(x)).map((x) => [x, structuredClone(kv.get(x))])) : structuredClone(kv.get(k)); },
        async put(k, v) { for (const [a, b] of typeof k === "string" ? [[k, v]] : Object.entries(k)) kv.set(a, structuredClone(b)); },
        async delete(k) { kv.delete(k); },
        async deleteAll() { kv = new Map(); db = new DatabaseSync(":memory:"); },
        async getAlarm() { return alarm; },
        async setAlarm(t) { alarm = t; },
        async deleteAlarm() { alarm = null; },
    };
}

/** A Durable Object namespace of `Class`, one instance per name; calls go through structuredClone, as RPC does. */
function namespace(Class, env) {
    const live = new Map();
    return {
        idFromName: (n) => n,
        get(id) {
            if (!live.has(id)) live.set(id, (async () => new Class({ storage: await doStorage(), blockConcurrencyWhile: (fn) => fn() }, env))());
            return new Proxy({}, {
                get: (_, m) => async (...a) => {
                    const o = await live.get(id);
                    return m === "fetch" ? o.fetch(...a) : structuredClone(await o[m](...a.map((x) => structuredClone(x))));
                },
            });
        },
        instance: (n) => live.get(n),
    };
}

function poolEnv({ cache = true } = {}) {
    const env = { AI: fakeAI(), MASTER_KEY, ADMIN_TOKEN, POOL_ZONE: "pool.test" };
    env.APPS = namespace(App, env);
    env.DIRECTORY = namespace(Directory, env);
    if (cache) env.EMBEDS = namespace(Embeds, env);
    return env;
}
const call = (env, method, path, body, token = ADMIN_TOKEN, opts) => pool.fetch(new Request(`https://pool.workers.dev${path}`, {
    method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body && { body: JSON.stringify(body) }),
}), env, undefined, opts);
const get = async (env, url) => (await pool.fetch(new Request(url), env)).json();
const status = async (env, name) => (await call(env, "GET", `/_pool/apps/${name}`)).json();

test("configOf takes what the pool runs and says why it won't take the rest", () => {
    expect(configOf("shop", { repos: ["shop"] })).toEqual({ repos: ["shop"], name: "shop", network: "baseSepolia" });
    expect(configOf("shop", { follow: ["0xabc/shop"], name: "Shop", schema: { type: "object" } })).toMatchObject({ name: "Shop" });
    expect(() => configOf("Shop!", { repos: ["shop"] })).toThrow(/app name/);
    expect(() => configOf("registry-sepolia", { repos: ["shop"] })).toThrow(/reserved/);
    expect(() => configOf("shop", {})).toThrow(/follow/);
    expect(() => configOf("shop", { follow: ["*"] })).toThrow(/registry/);
    expect(() => configOf("shop", { repos: ["shop"], rules: [{ check: "0xabc/checks/glb" }] })).toThrow(/rules/);
    expect(() => configOf("shop", { repos: ["shop"], types: { t: { rules: ["x"] } } })).toThrow(/rules/);
    expect(() => configOf("shop", { repos: ["shop"], index: "repos" })).toThrow(/index/);
    expect(() => configOf("shop", { repos: ["shop"], schema: "schemas/x.json" })).toThrow(/inline/);
    expect(() => configOf("shop", { repos: ["shop"], network: "moon" })).toThrow(/network/);
});

test("an app's gas key is sealed under the master key, and opens to the address it was made for", async () => {
    const { address, sealed } = await newKey(MASTER_KEY);
    expect(sealed).not.toMatch(/0x[0-9a-f]{64}/);
    expect(privateKeyToAccount(await openKey(MASTER_KEY, sealed)).address).toBe(address);
    await expect(openKey("22".repeat(32), sealed)).rejects.toThrow();
    await expect(newKey("short")).rejects.toThrow(/MASTER_KEY/);
});

test("routeOf: by host under the zone, else by /apps/<name>/ path, told its public base; a client's own base is dropped", () => {
    const at = (u, h = {}) => {
        const r = routeOf(new Request(u, { headers: h }), "pool.test");
        return r && [r.name, new URL(r.req.url).pathname, r.req.headers.get("x-westmarch-origin")];
    };
    expect(at("https://shop.pool.test/search")).toEqual(["shop", "/search", null]);
    expect(at("https://shop.pool.test/search", { "x-westmarch-origin": "https://evil" })).toEqual(["shop", "/search", null]);
    expect(at("https://x.workers.dev/apps/shop/view.json")).toEqual(["shop", "/view.json", "https://x.workers.dev/apps/shop"]);
    expect(at("https://x.workers.dev/apps/shop")).toEqual(["shop", "/", "https://x.workers.dev/apps/shop"]);
    expect(at("https://pool.pool.test/apps/shop/api.json")).toEqual(["shop", "/api.json", "https://pool.pool.test/apps/shop"]); // reserved host: by path
    expect(at("https://Bad_Name.pool.test/")).toBeNull();
    expect(at("https://x.workers.dev/search")).toBeNull();
});

test("embedMissing with a cache: hits fill past the budget, only misses are embedded, and what's made is cached", async () => {
    const net = memoryNetwork();
    const [alice, indexer] = await Promise.all([net.client(), net.client()]);
    await alice.initRepo("shop");
    await alice.uploadBatch("shop", ["a", "b", "c", "d"].map((id) => ({ id, type: "item", payload: { title: `item ${id}` } })));
    const db = await d1Shim();
    await db.exec(SCHEMA);
    const index = d1Index({ db, fangorn: indexer });
    await stitcher(indexer, { repos: ["shop"] }, { store: index.store, lens: index.lens }).update();

    const held = new Map(), embedder = fakeEmbedder(), asked = [];
    const cache = { get: async (texts) => texts.map((t) => held.get(t) ?? null), put: async (e) => e.forEach(([t, v]) => held.set(t, v)) };
    const embed = async (texts) => { asked.push(...texts); return embedder.embed(texts); };
    expect(await index.embedMissing(embed, 1, { cache })).toBe(1); // nothing cached: one, as the budget says
    expect(held.size).toBe(1);
    const rest = (await db.prepare("SELECT text FROM records WHERE vec IS NULL").all()).results.map((r) => r.text);
    for (const t of rest) held.set(t, new Int8Array(256).fill(1).buffer); // the rest made elsewhere
    expect(await index.embedMissing(embed, 1, { cache })).toBe(3); // all three hits, past a budget of one
    expect(asked).toHaveLength(1);
    expect((await db.prepare("SELECT count(*) AS n FROM records WHERE vec IS NULL").first()).n).toBe(0);
});

test("the pool: an app added by a PUT indexes on its alarm, serves its routes, re-indexes on a new config, and goes on DELETE", async () => {
    const net = memoryNetwork();
    const [alice, indexer] = await Promise.all([net.client(), net.client()]);
    await alice.initRepo("shop");
    await alice.uploadBatch("shop", [{ id: "oak-table", type: "item", payload: { title: "oak table" } }]);
    await alice.initRepo("blog");
    await alice.uploadBatch("blog", [{ id: "first-post", type: "post", payload: { title: "first post" } }]);
    const env = poolEnv();

    expect((await call(env, "PUT", "/_pool/apps/shop", { repos: ["shop"] }, "wrong")).status).toBe(401);
    expect((await call(env, "PUT", "/_pool/apps/shop", { repos: ["shop"], rules: ["x"] })).status).toBe(400);
    expect((await call(env, "PUT", "/_pool/apps/pool", { repos: ["shop"] })).status).toBe(400);
    const made = await (await call(env, "PUT", "/_pool/apps/shop", { repos: ["shop"] })).json();
    expect(made).toMatchObject({ name: "shop", wallet: expect.stringMatching(/^0x[0-9a-fA-F]{40}$/), records: 0, stitch: null, paused: false, hostname: null });

    // the alarm is set for now; one run indexes and embeds, and sets the next
    const app = await env.APPS.instance("shop");
    expect(await app.ctx.storage.getAlarm()).toBeLessThanOrEqual(Date.now());
    app.runOpts = { fangorn: indexer };
    await app.alarm();
    expect(await app.ctx.storage.getAlarm()).toBeGreaterThan(Date.now());
    expect(await status(env, "shop")).toMatchObject({ records: 1, embedded: 1, stitch: { caughtUp: true }, lastError: null });
    expect(await (await call(env, "GET", "/_pool/apps")).json()).toMatchObject({ apps: [{ name: "shop", records: 1, follow: ["shop"] }], embedCache: { n: 1 } });

    // its routes, by path and by host; by path, its urls carry the path
    expect((await get(env, "https://pool.workers.dev/apps/shop/view.json")).records.map((r) => r.id)).toEqual(["oak-table"]);
    expect((await get(env, "https://shop.pool.test/search?q=table")).map((h) => h.id)).toEqual(["oak-table"]);
    expect(await get(env, "https://shop.pool.test/api.json")).toMatchObject({ name: "shop", mcp: "https://shop.pool.test/mcp" });
    expect(await get(env, "https://pool.workers.dev/apps/shop/api.json")).toMatchObject({ mcp: "https://pool.workers.dev/apps/shop/mcp" });
    expect((await pool.fetch(new Request("https://nope.pool.test/api.json"), env)).status).toBe(404);

    // a new config keeps the wallet and re-indexes on the next run
    expect(await (await call(env, "PUT", "/_pool/apps/shop", { repos: ["blog"] })).json()).toMatchObject({ wallet: made.wallet });
    await app.alarm();
    expect((await get(env, "https://shop.pool.test/view.json")).records.map((r) => r.id)).toEqual(["first-post"]);

    // a failed run is recorded, and the alarm still comes back
    app.runOpts = { fangorn: { getRegistry: () => { throw new Error("rpc down"); } } };
    await app.alarm();
    expect(await status(env, "shop")).toMatchObject({ lastError: "rpc down" });
    expect(await app.ctx.storage.getAlarm()).toBeGreaterThan(Date.now());
    app.runOpts = { fangorn: indexer };

    // DELETE: gone from the list, its routes 404, and its alarm doesn't come back
    expect(await (await call(env, "DELETE", "/_pool/apps/shop")).json()).toEqual({ removed: "shop" });
    expect((await (await call(env, "GET", "/_pool/apps")).json()).apps).toEqual([]);
    expect((await call(env, "GET", "/_pool/apps/shop")).status).toBe(404);
    expect((await pool.fetch(new Request("https://shop.pool.test/view.json"), env)).status).toBe(404);
    expect(await app.ctx.storage.getAlarm()).toBeNull();
    await app.alarm();
    expect(await app.ctx.storage.getAlarm()).toBeNull();

    // and the same name can come back, from nothing
    await call(env, "PUT", "/_pool/apps/shop", { repos: ["shop"] });
    await app.alarm();
    expect(await status(env, "shop")).toMatchObject({ records: 1 });
});

test("pause stops an app's runs and keeps it serving; resume runs it again from where it stopped", async () => {
    const net = memoryNetwork();
    const [alice, indexer] = await Promise.all([net.client(), net.client()]);
    await alice.initRepo("shop");
    await alice.uploadBatch("shop", [{ id: "oak-table", type: "item", payload: { title: "oak table" } }]);
    const env = poolEnv();
    await call(env, "PUT", "/_pool/apps/shop", { repos: ["shop"] });
    const app = await env.APPS.instance("shop");
    app.runOpts = { fangorn: indexer };
    await app.alarm();

    expect(await (await call(env, "POST", "/_pool/apps/shop/pause")).json()).toMatchObject({ paused: true, nextRun: null });
    await alice.uploadBatch("shop", [{ id: "pine-chair", type: "item", payload: { title: "pine chair" } }]);
    await app.alarm(); // a run already scheduled when it was paused does nothing, and sets no next one
    expect(await app.ctx.storage.getAlarm()).toBeNull();
    expect((await get(env, "https://shop.pool.test/view.json")).records.map((r) => r.id)).toEqual(["oak-table"]);
    expect(await (await call(env, "PUT", "/_pool/apps/shop", { repos: ["shop"], name: "Shop" })).json()).toMatchObject({ paused: true, nextRun: null }); // stays paused

    expect(await (await call(env, "POST", "/_pool/apps/shop/resume")).json()).toMatchObject({ paused: false, nextRun: expect.any(String) });
    await app.alarm();
    expect((await get(env, "https://shop.pool.test/view.json")).records.map((r) => r.id)).toEqual(["oak-table", "pine-chair"]);
    expect((await call(env, "POST", "/_pool/apps/nope/pause")).status).toBe(404);
    expect((await call(env, "GET", "/_pool/apps/shop/pause")).status).toBe(405);
});

test("the shared cache: a second app following the same repo takes the first's vectors, without embedding", async () => {
    const net = memoryNetwork();
    const [alice, indexer] = await Promise.all([net.client(), net.client()]);
    await alice.initRepo("shop");
    await alice.uploadBatch("shop", ["a", "b", "c"].map((id) => ({ id, type: "item", payload: { title: `item ${id}` } })));
    const env = poolEnv();
    for (const name of ["first", "second"]) {
        await call(env, "PUT", `/_pool/apps/${name}`, { repos: ["shop"] });
        (await env.APPS.instance(name)).runOpts = { fangorn: indexer };
    }
    await (await env.APPS.instance("first")).alarm();
    expect(env.AI.texts).toBe(3);
    expect(await status(env, "first")).toMatchObject({ embedded: 3, embedCache: { hits: 0, misses: 3, written: 3 } });

    await (await env.APPS.instance("second")).alarm();
    expect(env.AI.texts).toBe(3); // nothing new embedded
    expect(await status(env, "second")).toMatchObject({ embedded: 3, embedCache: { hits: 3, misses: 0, written: 0 } });
    expect((await get(env, "https://second.pool.test/search?q=item")).map((h) => h.id).sort()).toEqual(["a", "b", "c"]);

    // without the binding, apps embed for themselves
    const solo = poolEnv({ cache: false });
    await call(solo, "PUT", "/_pool/apps/solo", { repos: ["shop"] });
    const app = await solo.APPS.instance("solo");
    app.runOpts = { fangorn: indexer };
    await app.alarm();
    expect(await status(solo, "solo")).toMatchObject({ embedded: 3, embedCache: null });
});

/** Cloudflare's Workers Custom Domains API, held in memory. */
function fakeCloudflare(held = []) {
    const calls = [];
    const fetcher = async (url, init = {}) => {
        const u = new URL(url), method = init.method ?? "GET";
        calls.push(`${method} ${u.pathname}`);
        const ok = (result) => new Response(JSON.stringify({ success: true, result }));
        if (u.pathname === "/client/v4/zones") return ok([{ id: "zone-1" }]);
        if (u.pathname.endsWith("/workers/domains") && method === "GET") return ok(held.filter((d) => d.hostname === u.searchParams.get("hostname")));
        if (u.pathname.endsWith("/workers/domains") && method === "PUT") { const d = JSON.parse(init.body); held.push({ ...d, id: `d-${held.length}` }); return ok(d); }
        if (method === "DELETE") { const id = u.pathname.split("/").pop(); held.splice(held.findIndex((d) => d.id === id), 1); return ok(null); }
        return new Response("{}", { status: 404 });
    };
    return { fetcher, held, calls };
}

test("hostnames: made on the pool Worker for a new app, never taken from another Worker, removed with the app", async () => {
    const env = { ...poolEnv(), CF_API_TOKEN: "t", CF_ACCOUNT_ID: "acct", POOL_SERVICE: "westmarch-pool" };
    const fake = fakeCloudflare([{ id: "old", hostname: "audius-test.pool.test", service: "audius-test" }]);
    const cf = domains(env, fake.fetcher);

    expect(await (await call(env, "PUT", "/_pool/apps/shop", { repos: ["shop"] }, ADMIN_TOKEN, { cf })).json()).toMatchObject({ hostname: "shop.pool.test" });
    expect(fake.held).toContainEqual(expect.objectContaining({ hostname: "shop.pool.test", service: "westmarch-pool", zone_id: "zone-1" }));
    const puts = fake.calls.filter((c) => c.startsWith("PUT")).length;
    await call(env, "PUT", "/_pool/apps/shop", { repos: ["blog"] }, ADMIN_TOKEN, { cf }); // an update doesn't ask again
    expect(fake.calls.filter((c) => c.startsWith("PUT")).length).toBe(puts);

    // a name another Worker serves: the app runs, by path, and says why it has no hostname
    const taken = await (await call(env, "PUT", "/_pool/apps/audius-test", { repos: ["audius-tracks"] }, ADMIN_TOKEN, { cf })).json();
    expect(taken).toMatchObject({ hostname: null, hostnameError: expect.stringMatching(/served by the Worker "audius-test"/) });
    expect(fake.held.find((d) => d.hostname === "audius-test.pool.test").service).toBe("audius-test");

    await call(env, "DELETE", "/_pool/apps/shop", undefined, ADMIN_TOKEN, { cf });
    await call(env, "DELETE", "/_pool/apps/audius-test", undefined, ADMIN_TOKEN, { cf });
    expect(fake.held).toEqual([{ id: "old", hostname: "audius-test.pool.test", service: "audius-test" }]); // only the pool's went
});
