import { test, expect } from "vitest";
import { memoryNetwork } from "@fangorn-network/sdk/lib/test/testbed.js";
import { stitcher } from "./stitcher.js";
import { d1Index, SCHEMA } from "./d1.js";
import { d1Shim, fakeEmbedder } from "./testing.js";

test("d1: follows the stitch, embeds what has no vector a bounded batch at a time, searches by meaning", async () => {
    const net = memoryNetwork();
    const [alice, indexer] = await Promise.all([net.client(), net.client()]);
    const db = await d1Shim();
    await db.exec(SCHEMA);
    const index = d1Index({ db, fangorn: indexer });
    const s = stitcher(indexer, { repos: ["arcade"] }, { store: index.store, lens: index.lens });
    const embedder = fakeEmbedder();

    await alice.initRepo("arcade");
    await alice.uploadBatch("arcade", [
        { id: "t", type: "game", payload: { title: "table flip" } },
        { id: "l", type: "game", payload: { title: "lamp light" } },
    ]);
    const root = await s.update();
    expect((await index.rows()).map((r) => r.id).sort()).toEqual(["l", "t"]);
    expect(await index.search(await embedder.query("table"))).toEqual([]); // nothing embedded yet

    expect(await index.embedMissing(embedder.embed, 1)).toBe(1);           // the budget holds
    expect(await index.embedMissing(embedder.embed, 10)).toBe(1);
    expect(await index.embedMissing(embedder.embed, 10)).toBe(0);
    expect((await index.search(await embedder.query("furniture"), { k: 1 }))[0]).toMatchObject({ id: "t", payload: { title: "table flip" } });

    // a change clears that row's vector; a delete removes it; the stitch resumes from what was saved
    await alice.uploadBatch("arcade", [{ id: "t", type: "game", payload: { title: "table flip 2" } }], ["l"]);
    const again = d1Index({ db, fangorn: indexer });
    const s2 = stitcher(indexer, { repos: ["arcade"] }, { store: again.store, lens: again.lens });
    expect(await s2.update()).not.toBe(root);
    expect((await again.rows()).map((r) => [r.id, r.payload.title])).toEqual([["t", "table flip 2"]]);
    expect(await again.embedMissing(embedder.embed)).toBe(1);
});
