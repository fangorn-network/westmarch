import { test, expect } from "vitest";
import { memoryNetwork } from "@fangorn-network/sdk/lib/test/testbed.js";
import { run } from "./run.js";
import { fakeEmbedder } from "./testing.js";

test("publishView: each new root puts the view in storage and points the indexer's `view` record at it", async () => {
    const net = memoryNetwork();
    const [alice, indexer] = await Promise.all([net.client(), net.client()]);
    await alice.initRepo("arcade");
    await alice.uploadBatch("arcade", [{ id: "cube", type: "game", payload: { title: "Cube" } }]);

    const config = { repos: ["arcade"], publishView: "arcade-view" };
    const runner = await run({ config, fangorn: indexer, embedder: fakeEmbedder(), path: ":memory:", log: () => {} });
    const read = async () => {
        const { payload } = await indexer.engine.readRecord(indexer.getAddress(), "arcade-view", "view");
        return { payload, view: JSON.parse(new TextDecoder().decode(await indexer.getStorage().getFile(payload.src))) };
    };

    let { payload, view } = await read();
    expect(view.records.map((r) => r.id)).toEqual(["cube"]);
    expect(view.stitch).toBeTruthy();
    expect(payload).toMatchObject({ root: view.root, stitch: view.stitch, records: 1 });

    await alice.uploadBatch("arcade", [{ id: "drift", type: "game", payload: { title: "Drift" } }]);
    await runner.tick();
    ({ view } = await read());
    expect(view.records.map((r) => r.id)).toEqual(["cube", "drift"]);
    await runner.stop();
});

test("publishView refuses a repo the index follows: each view would trigger the next", async () => {
    const net = memoryNetwork();
    const indexer = await net.client();
    await expect(run({ config: { repos: ["arcade"], publishView: "arcade" }, fangorn: indexer, embedder: fakeEmbedder(), path: ":memory:", log: () => {} }))
        .rejects.toThrow(/each view would trigger the next/);
});

test("once: catches up without watching, and a failed catch-up throws its own error", async () => {
    const net = memoryNetwork();
    const [alice, indexer] = await Promise.all([net.client(), net.client()]);
    await alice.initRepo("arcade");
    await alice.uploadBatch("arcade", [{ id: "cube", type: "game", payload: { title: "Cube" } }]);
    indexer.getRegistry().watch = () => { throw new Error("watched"); };
    const config = { repos: ["arcade"] }, logged = [];
    const go = () => run({ config, fangorn: indexer, embedder: fakeEmbedder(), path: ":memory:", log: (m) => logged.push(m), once: true });

    const runner = await go();
    expect(runner.index.rows().map((r) => r.id)).toEqual(["cube"]);
    await runner.stop();

    // live, this is logged and the next event retries; once, there is no next event (seed.js would report "no stitch")
    const restitch = indexer.restitch.bind(indexer);
    indexer.restitch = () => Promise.reject(new Error("HTTP request failed. Status: 429"));
    await expect(go()).rejects.toThrow(/429/);
    expect(logged.filter((m) => m.startsWith("✗"))).toEqual([]);
    indexer.restitch = restitch;
});
