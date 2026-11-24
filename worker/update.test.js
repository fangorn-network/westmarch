import { test, expect } from "vitest";
import { memoryNetwork } from "@fangorn-network/sdk/lib/test/testbed.js";
import { MemRegistry } from "@fangorn-network/sdk/lib/test/mem-registry.js";
import { Fangorn, FangornConfig } from "@fangorn-network/sdk";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
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

/** An indexer like the Worker's (fangornOf): CARs read without their records until asked for. */
const leanIndexer = (net) => {
    const sk = generatePrivateKey();
    return Fangorn.create({ privateKey: sk, config: { ...FangornConfig, fromBlock: 0n }, storage: { backend: net.storage },
        registry: new MemRegistry(privateKeyToAccount(sk).address, net.ledger), leanCars: true });
};
const rows = async (env) => (await env.DB.prepare("SELECT id, cid, payload FROM records ORDER BY id").all()).results;
const track = (i, v = 1) => ({ id: `t-${String(i).padStart(3, "0")}`, type: "note", payload: { title: `track ${i}`, v } });

test("an update bigger than a run is taken in over several, each saved, ending with the rows one run gives", async () => {
    const net = memoryNetwork();
    const alice = await net.client(), indexer = leanIndexer(net), config = { repos: ["shop"] };
    await alice.initRepo("shop");
    await alice.uploadBatch("shop", Array.from({ length: 30 }, (_, i) => track(i)));

    /** Runs until caught up; each run's ids and saved stitch. */
    const runAll = async (env, perRun, between = async () => {}) => {
        const seen = [];
        do {
            await update(env, quiet, { fangorn: indexer, perRun });
            seen.push({ ids: await ids(env), stitch: await meta(env, "stitch"), cursor: await meta(env, "cursor") });
            await between(seen.length);
            expect(seen.length).toBeLessThan(20);
        } while (seen.at(-1).stitch.caughtUp === false);
        return seen;
    };

    // a new repo: the tree itself, 7 records a run
    const env = await envOf(config), first = await runAll(env, 7);
    expect(first.map((r) => r.ids.length)).toEqual([7, 14, 21, 28, 30]);
    expect(first.slice(0, -1).every((r) => r.stitch.root === undefined && r.cursor)).toBe(true); // the old (no) stitch, kept
    expect(first.at(-1).cursor).toBeNull();
    const whole = await envOf(config);
    await update(whole, quiet, { fangorn: indexer });
    expect(await rows(env)).toEqual(await rows(whole));
    const root1 = first.at(-1).stitch.root;

    // one commit: 20 changed, 3 deleted, 5 new (diff events), with another commit landing partway through
    await alice.uploadBatch("shop", [...Array.from({ length: 20 }, (_, i) => track(i, 2)), ...Array.from({ length: 5 }, (_, i) => track(30 + i))],
        ["t-025", "t-026", "t-027"]);
    const second = await runAll(env, 7, async (n) => {
        if (n === 2) await alice.uploadBatch("shop", [track(3, 3), track(40)], ["t-028"]);
    });
    expect(second.length).toBeGreaterThan(3);
    expect(second.slice(0, -1).every((r) => r.stitch.root === root1 && r.cursor)).toBe(true);
    expect(second.at(-1).cursor).toBeNull();
    await update(whole, quiet, { fangorn: indexer });
    expect(await rows(env)).toEqual(await rows(whole));
    expect((await rows(env)).find((r) => r.id === "t-003").payload).toContain('"v":3');
    expect(await ids(env)).not.toContain("t-028");
    expect((await meta(env, "stitch")).root).toBe((await meta(whole, "stitch")).root);
});
