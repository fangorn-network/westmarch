import { test, expect } from "vitest";
import { memoryNetwork } from "@fangorn-network/sdk/lib/test/testbed.js";
import { generatePrivateKey } from "viem/accounts";
import { reposOf, stitcher, watchHeads } from "./stitcher.js";
import { memoryStore } from "./store.js";

const put = async (client, repo, name) => {
    await client.initRepo(repo); // a no-op once it exists
    return client.uploadBatch(repo, [{ type: "note", payload: { name } }]);
};

test("build a stitch, get its root, follow new publishes to a new root", async () => {
    const net = memoryNetwork();
    const [alice, bob, eve, indexer] = await Promise.all([net.client(), net.client(), net.client(), net.client()]);
    await put(alice, "shop", "oak table");
    await put(bob, "shop", "brass lamp");
    await put(eve, "shop", "not followed"); // eve isn't one of our publishers

    const s = stitcher(indexer, { publishers: [alice.getAddress(), bob.getAddress()], repos: ["shop"] });

    const r0 = await s.update();
    expect(r0).toBeTruthy();
    expect((await indexer.stitchHeads(s.stitch)).map((h) => h.publisher.toLowerCase()).sort())
        .toEqual([alice.getAddress(), bob.getAddress()].map((a) => a.toLowerCase()).sort());

    // our own commit of the stitch is a log entry too: a new stitch, same root (so no commit, no loop)...
    expect(await s.update()).toBe(r0);
    // ...and after that, nothing new: same stitch, same root
    const before = s.stitch;
    expect(await s.update()).toBe(r0);
    expect(s.stitch).toBe(before);

    // a publish outside the set changes nothing
    await put(eve, "shop", "still not followed");
    expect(await s.update()).toBe(r0);

    // a followed publisher publishes: new root
    await put(alice, "shop", "pine chair");
    const r1 = await s.update();
    expect(r1).not.toBe(r0);
});

test("commits the stitch to fangorn when its root changes, and resumes from it", async () => {
    const net = memoryNetwork();
    const sk = generatePrivateKey();
    const [alice, eve, indexer] = await Promise.all([net.client(), net.client(), net.client(sk)]);
    await put(alice, "shop", "oak table");
    const cfg = { publishers: [alice.getAddress()], repos: ["shop"] };
    const committed = async (c) => (await c.inspectRepo("stitch")).records.map((r) => r.payload);

    const s = stitcher(indexer, cfg);
    const r0 = await s.update();
    expect(await committed(indexer)).toMatchObject([{ stitch: s.stitch, root: r0 }]);

    // the log moved but the root didn't: nothing to commit
    const first = s.stitch;
    await put(eve, "shop", "not followed");
    await s.update();
    expect(s.stitch).not.toBe(first);
    expect(await committed(indexer)).toMatchObject([{ stitch: first }]);

    // a restart (same key, fresh client) resumes from the committed stitch
    const again = await net.client(sk);
    const prevs = [];
    const restitch = again.restitch.bind(again);
    again.restitch = (p, prev) => (prevs.push(prev), restitch(p, prev));
    expect(await stitcher(again, cfg).update()).toBe(r0);
    expect(prevs).toEqual([first]);

    // ...unless it follows something else now: then it starts over
    const other = stitcher(again, { ...cfg, repos: ["blog"] });
    await other.update();
    expect(prevs[1]).toBeUndefined();
});

test("memoryStore: persists in memory, nothing committed to fangorn", async () => {
    const net = memoryNetwork();
    const [alice, indexer] = await Promise.all([net.client(), net.client()]);
    await put(alice, "shop", "oak table");
    const cfg = { publishers: [alice.getAddress()], repos: ["shop"] };
    const store = memoryStore();

    const s = stitcher(indexer, cfg, { store });
    const r0 = await s.update();
    expect(await store.load()).toMatchObject({ stitch: s.stitch, root: r0 });
    expect((await indexer.inspectRepo("stitch")).records).toEqual([]);

    // nothing of ours went into the log, so a second stitcher on the same store resumes at the same stitch
    const s2 = stitcher(indexer, cfg, { store });
    expect(await s2.update()).toBe(r0);
    expect(s2.stitch).toBe(s.stitch);
});

test("step: a catch-up in bounded steps, each saved, ends where one fold does", async () => {
    const net = memoryNetwork();
    const [alice, eve, indexer] = await Promise.all([net.client(), net.client(), net.client()]);
    await put(alice, "shop", "oak table");
    for (const n of [1, 2, 3]) await put(eve, "shop", `not followed ${n}`); // steps that leave the root where it was
    await put(alice, "shop", "pine chair");
    const cfg = { publishers: [alice.getAddress()], repos: ["shop"] };
    const whole = await stitcher(indexer, cfg, { store: memoryStore() }).update();

    // each update is a fresh stitcher on the same store, as each Worker run is
    const store = memoryStore(), roots = [];
    let s, runs = 0;
    do {
        s = stitcher(indexer, cfg, { store, step: 2 });
        roots.push(await s.update());
        expect((await store.load()).stitch).toBe(s.stitch); // saved, even when the root didn't move
        expect(++runs).toBeLessThan(20);
    } while (!s.caughtUp);
    expect(runs).toBeGreaterThan(2);
    expect(roots.at(-1)).toBe(whole);
    expect(new Set(roots).size).toBeGreaterThan(1); // the root moved partway, not only at the end

    // caught up, with nothing new: the same stitch, still caught up
    const last = s.stitch;
    s = stitcher(indexer, cfg, { store, step: 2 });
    expect(await s.update()).toBe(whole);
    expect(s.stitch).toBe(last);
    expect(s.caughtUp).toBe(true);
});

test("a burst of triggers runs at most one restitch now and one after", async () => {
    const net = memoryNetwork();
    const [alice, indexer] = await Promise.all([net.client(), net.client()]);
    await put(alice, "shop", "oak table");

    let calls = 0;
    const restitch = indexer.restitch.bind(indexer);
    indexer.restitch = (...a) => (calls++, restitch(...a));

    const s = stitcher(indexer, { publishers: [alice.getAddress()], repos: ["shop"] });
    const roots = await Promise.all(Array.from({ length: 10 }, () => s.trigger()));
    expect(calls).toBe(2);
    expect(new Set(roots).size).toBe(1); // same heads, same root
});

test("head updates from followed publishers trigger a new root; others don't", async () => {
    const net = memoryNetwork();
    const [alice, eve, indexer] = await Promise.all([net.client(), net.client(), net.client()]);
    await put(alice, "shop", "oak table");

    const cfg = { publishers: [alice.getAddress()], repos: ["shop"] };
    const s = stitcher(indexer, cfg);
    const r0 = await s.update();

    const seen = [];
    const off = watchHeads(indexer, cfg, (e) => seen.push(e));

    await put(eve, "shop", "not followed");
    expect(seen).toHaveLength(0);

    await put(alice, "shop", "pine chair");
    await expect.poll(() => seen.length).toBe(1);
    expect(seen[0].publisher.toLowerCase()).toBe(alice.getAddress().toLowerCase());
    expect(await s.trigger()).not.toBe(r0);
    off();
});

test("without publishers, it follows that repo of every publisher: a newcomer joins with no config change", async () => {
    const net = memoryNetwork();
    const [alice, bob, indexer] = await Promise.all([net.client(), net.client(), net.client()]);
    await put(alice, "arcade", "cube");
    await put(alice, "shop", "not this repo");
    const s = stitcher(indexer, { repos: ["arcade"] });
    await s.update();
    const who = async () => (await indexer.stitchHeads(s.stitch)).map((h) => `${h.publisher.toLowerCase()}/${h.repo}`).sort();
    expect(await who()).toEqual([`${alice.getAddress().toLowerCase()}/arcade`]);

    await put(bob, "arcade", "particles"); // bob was never named anywhere
    await s.update();
    expect(await who()).toEqual([alice, bob].map((c) => `${c.getAddress().toLowerCase()}/arcade`).sort());
});

test("follow: exactly the publisher/repo pairs named, not their cross product", async () => {
    const net = memoryNetwork();
    const [alice, bob, indexer] = await Promise.all([net.client(), net.client(), net.client()]);
    await Promise.all([put(alice, "shop", "a"), put(alice, "blog", "not followed"), put(bob, "blog", "b"), put(bob, "shop", "not followed")]);
    const follow = [`${alice.getAddress()}/shop`, `${bob.getAddress()}/blog`];
    const s = stitcher(indexer, { follow });
    await s.update();
    expect((await indexer.stitchHeads(s.stitch)).map((h) => `${h.publisher}/${h.repo}`.toLowerCase()).sort())
        .toEqual(follow.map((p) => p.toLowerCase()).sort());
    expect(reposOf({ follow })).toEqual(["shop", "blog"]);
    expect(reposOf({ follow: ["*"] })).toBe(null);
});
