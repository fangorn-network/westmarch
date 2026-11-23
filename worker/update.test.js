import { test, expect } from "vitest";
import { memoryNetwork } from "@fangorn-network/sdk/lib/test/testbed.js";
import { SCHEMA } from "../src/d1.js";
import { d1Shim } from "../src/testing.js";
import { update } from "./index.js";

// The Worker's cron run, on the in-memory network: its clock ticks once per log entry, so "blocks" are entries.

/** A Worker env: D1 with the schema, and a Workers AI that embeds everything the same. */
async function envOf(config) {
    const db = await d1Shim();
    await db.exec(SCHEMA);
    const AI = { run: async (_, { text }) => ({ data: text.map(() => Array.from({ length: 768 }, (_, i) => (i % 7) / 7)) }) };
    return { CONFIG: config, DB: db, AI };
}

const ids = async (env) => (await env.DB.prepare("SELECT id FROM records ORDER BY id").all()).results.map((r) => r.id);
const meta = async (env, k) => JSON.parse((await env.DB.prepare("SELECT v FROM meta WHERE k = ?").bind(k).first())?.v ?? "null");
const publish = async (client, repo, id) => {
    await client.initRepo(repo); // a no-op once it exists
    await client.uploadBatch(repo, [{ id, type: "note", payload: { title: id } }]);
};
const quiet = () => {};

test("a catch-up in bounded steps, one per run, each saved, ends with the records one fold gives", async () => {
    const net = memoryNetwork();
    const [alice, eve, indexer] = await Promise.all([net.client(), net.client(), net.client()]);
    await publish(alice, "shop", "oak-table");
    for (const n of [1, 2, 3]) await publish(eve, "blog", `post-${n}`); // not followed: steps where the root stays put
    await publish(alice, "shop", "pine-chair");
    const config = { repos: ["shop"] };

    const whole = await envOf(config);
    await update(whole, quiet, { fangorn: indexer });
    expect(await ids(whole)).toEqual(["oak-table", "pine-chair"]);

    // the gate's reads are the ones filtered by repo; while behind, a run folds on without them
    const registry = indexer.getRegistry(), log = registry.log.bind(registry), gateReads = [];
    registry.log = (filter, from, to) => (filter.repo !== undefined && gateReads.push(from), log(filter, from, to));
    const stepped = await envOf(config), seen = [];
    let runs = 0;
    do {
        await update(stepped, quiet, { fangorn: indexer, step: 2 });
        seen.push(await ids(stepped));
        expect(++runs).toBeLessThan(20);
    } while ((await meta(stepped, "stitch")).caughtUp === false);
    expect(runs).toBeGreaterThan(2);
    expect(gateReads).toEqual([]);
    expect(seen[0]).toEqual(["oak-table"]); // records arrive with their step, not all at the end
    expect(seen.at(-1)).toEqual(["oak-table", "pine-chair"]);
    expect((await meta(stepped, "stitch")).root).toBe((await meta(whole, "stitch")).root);
});

test("the gate looks again at the newest blocks, which a lagging RPC can leave out", async () => {
    const net = memoryNetwork();
    const [alice, eve, indexer] = await Promise.all([net.client(), net.client(), net.client()]);
    await publish(alice, "shop", "oak-table");
    const env = await envOf({ repos: ["shop"] });
    await update(env, quiet, { fangorn: indexer });
    expect(await ids(env)).toEqual(["oak-table"]);

    // well past the gate's margin of blocks, then a followed update at the head
    for (let n = 0; n < 40; n++) await publish(eve, "shop-not", `noise-${n}`);
    await publish(alice, "shop", "pine-chair");

    // a log backend one block behind the clock: the gate (and any fold) sees nothing of the newest block
    const registry = indexer.getRegistry(), log = registry.log.bind(registry);
    registry.log = (filter, from, to) => log(filter, from, to === undefined ? undefined : to - 1n);
    await update(env, quiet, { fangorn: indexer });
    expect(await ids(env)).toEqual(["oak-table"]);

    // caught up with the clock: the next run's gate covers that block again
    registry.log = log;
    await update(env, quiet, { fangorn: indexer });
    expect(await ids(env)).toEqual(["oak-table", "pine-chair"]);
});

test("a changed config re-indexes, though nothing it follows has moved since", async () => {
    const net = memoryNetwork();
    const [alice, indexer] = await Promise.all([net.client(), net.client()]);
    await publish(alice, "shop", "oak-table");
    await publish(alice, "blog", "first-post");
    const env = await envOf({ repos: ["shop"] });
    await update(env, quiet, { fangorn: indexer });
    expect(await ids(env)).toEqual(["oak-table"]);

    env.CONFIG = { repos: ["blog"] };
    await update(env, quiet, { fangorn: indexer });
    expect(await ids(env)).toEqual(["first-post"]);
});
