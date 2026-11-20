import { test, expect } from "vitest";
import { memoryNetwork } from "@fangorn-network/sdk/lib/test/testbed.js";
import { stitcher } from "./stitcher.js";
import { d1Index, diffSince, SCHEMA } from "./d1.js";
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
    const q = await embedder.query("furniture"); // paging (one row per page) finds the same, in the same order
    expect((await index.search(q, { page: 1 })).map((h) => [h.id, h.score])).toEqual((await index.search(q)).map((h) => [h.id, h.score]));
    expect((await db.prepare("SELECT typeof(vec) AS t FROM records").all()).results.map((r) => r.t)).toEqual(["blob", "blob"]); // int8, 256 bytes

    // a change clears that row's vector; a delete removes it; the stitch resumes from what was saved
    await alice.uploadBatch("arcade", [{ id: "t", type: "game", payload: { title: "table flip 2" } }], ["l"]);
    const again = d1Index({ db, fangorn: indexer });
    const s2 = stitcher(indexer, { repos: ["arcade"] }, { store: again.store, lens: again.lens });
    expect(await s2.update()).not.toBe(root);
    expect((await again.rows()).map((r) => [r.id, r.payload.title])).toEqual([["t", "table flip 2"]]);
    expect(await again.embedMissing(embedder.embed)).toBe(1);
});

test("diffSince: reads only the new commits, skips what the index already holds, falls back for a new repo", async () => {
    const net = memoryNetwork();
    const [alice, reader] = await Promise.all([net.client(), net.client()]);
    const e = reader.engine, hex = (c) => "0x" + Buffer.from(c.multihash.digest).toString("hex");
    const head = async () => hex(await e.resolveHeadCommit(alice.getAddress(), "arcade"));
    await alice.initRepo("arcade");
    await alice.uploadBatch("arcade", [{ id: "a", type: "game", payload: { n: 1 } }, { id: "b", type: "game", payload: { n: 1 } }]);
    const h1 = await head(), known = new Map([...(await e.stateAt(e.hexToRootCid(h1))).state].map(([id, c]) => [id, c.toString()]));
    await alice.uploadBatch("arcade", [{ id: "a", type: "game", payload: { n: 2 } }, { id: "c", type: "game", payload: { n: 1 } }], ["b"]);
    await alice.uploadBatch("arcade", [{ id: "c", type: "game", payload: { n: 1 } }]); // a re-put of the same record
    const h3 = await head();
    let full = 0; const repoDiff = e.repoDiff.bind(e); e.repoDiff = (...a) => (full++, repoDiff(...a));
    const d = await diffSince(e, h1, h3, known);
    expect(full).toBe(0);
    expect(d.puts.map((r) => [r.id, r.payload.n]).sort()).toEqual([["a", 2], ["c", 1]]);
    expect(d.deletes).toEqual(["b"]);
    expect((await diffSince(e, h3, h3, known)).puts).toEqual([]);                        // nothing between
    expect((await diffSince(e, null, h1, new Map())).puts.map((r) => r.id).sort()).toEqual(["a", "b"]);
    expect(full).toBe(1);                                                                // a new repo: the full diff
});

test("d1 gate: a record is served only once checked, for its current CID; refused ones are listed, not served", async () => {
    const net = memoryNetwork();
    const [alice, mallory, indexer] = await Promise.all([net.client(), net.client(), net.client()]);
    const db = await d1Shim();
    await db.exec(SCHEMA);
    const gate = { types: {}, other: "g1", all: "g1" }, index = d1Index({ db, fangorn: indexer, gate });
    const s = stitcher(indexer, { repos: ["arcade"] }, { store: index.store, lens: index.lens });
    const embedder = fakeEmbedder(), check = async (r) => (r.payload.title.includes("evil") ? "evil" : null);
    const ids = async (ix = index) => (await ix.rows()).map((r) => r.id).sort();

    await alice.initRepo("arcade");
    await mallory.initRepo("arcade");
    await alice.uploadBatch("arcade", [{ id: "t", type: "game", payload: { title: "table flip" } }]);
    await mallory.uploadBatch("arcade", [{ id: "m", type: "game", payload: { title: "evil lamp" } }]);
    await s.update();
    expect(await ids()).toEqual([]);                                           // nothing checked: nothing served
    expect(await index.embedMissing(embedder.embed)).toBe(0);                  // and nothing embedded
    const t = (await db.prepare("SELECT cid FROM records WHERE id = 't'").first()).cid;
    expect(await index.allows(alice.getAddress(), "arcade", "t", t)).toBe(false);

    expect(await index.checkMissing(check, 1)).toEqual({ checked: 1, refused: expect.any(Number) }); // the budget holds
    await index.checkMissing(check);
    expect(await index.checkMissing(check)).toEqual({ checked: 0, refused: 0 });
    expect(await ids()).toEqual(["t"]);
    expect(await index.refused()).toEqual([expect.objectContaining({ id: "m", reason: "evil" })]);
    expect(await index.allows(alice.getAddress(), "arcade", "t", t)).toBe(true);
    expect(await index.allows(alice.getAddress(), "arcade", "t", "bafyOld")).toBe(false); // another version
    expect(await index.embedMissing(embedder.embed)).toBe(1);
    expect((await index.search(await embedder.query("lamp"))).map((h) => h.id)).toEqual(["t"]); // the evil lamp isn't searchable

    // a changed record waits for a new check; a check that throws leaves its record for later
    await mallory.uploadBatch("arcade", [{ id: "m", type: "game", payload: { title: "rug" } }]);
    await s.update();
    expect(await index.refused()).toEqual([]);                                 // the refused version is gone
    expect(await index.checkMissing(async () => { throw new Error("down"); })).toEqual({ checked: 0, refused: 0 });
    expect(await ids()).toEqual(["t"]);
    await index.checkMissing(check);
    expect(await ids()).toEqual(["m", "t"]);

    // a new checker checks everything again; no gate serves everything, as before
    expect(await ids(d1Index({ db, fangorn: indexer, gate: { types: {}, other: "g2", all: "g2" } }))).toEqual([]);
    expect(await ids(d1Index({ db, fangorn: indexer }))).toEqual(["m", "t"]);
    expect(await d1Index({ db, fangorn: indexer }).allows("0x0", "arcade", "nope", "x")).toBe(true);
});

test("d1 gate per type: changing one type's checks rechecks only that type", async () => {
    const net = memoryNetwork();
    const [alice, indexer] = await Promise.all([net.client(), net.client()]);
    const db = await d1Shim();
    await db.exec(SCHEMA);
    const v1 = { types: { game: "game1", asset: "asset1" }, other: "other1", all: "v1" };
    const index = d1Index({ db, fangorn: indexer, gate: v1 });
    const s = stitcher(indexer, { repos: ["arcade"] }, { store: index.store, lens: index.lens });
    await alice.initRepo("arcade");
    await alice.uploadBatch("arcade", [
        { id: "g", type: "game", payload: { title: "g" } },
        { id: "a", type: "asset", payload: { title: "a" } },
        { id: "x", type: "weird", payload: { title: "x" } },
    ]);
    await s.update();
    const seen = [];
    const check = async (r) => (seen.push(r.id), r.type === "weird" ? "type is one of game, asset" : null);
    expect(await index.checkMissing(check)).toEqual({ checked: 3, refused: 1 });
    const ids = async (ix) => (await ix.rows()).map((r) => r.id).sort();
    expect(await ids(index)).toEqual(["a", "g"]);
    expect((await index.refused()).map((r) => r.id)).toEqual(["x"]);

    const v2 = { ...v1, types: { ...v1.types, asset: "asset2" }, all: "v2" };   // only asset's checks changed
    const next = d1Index({ db, fangorn: indexer, gate: v2 });
    expect(await ids(next)).toEqual(["g"]);                                     // the asset waits
    seen.length = 0;
    expect(await next.checkMissing(check)).toEqual({ checked: 1, refused: 0 });
    expect(seen).toEqual(["a"]);
    expect(await ids(next)).toEqual(["a", "g"]);
});

test("d1: vectors written as JSON (before int8) still search, and packVectors rewrites them with the same ranking", async () => {
    const db = await d1Shim();
    await db.exec(SCHEMA);
    const index = d1Index({ db, fangorn: null }), embedder = fakeEmbedder();
    const titles = { a: "table flip", b: "lamp light", c: "chair stack" };
    const vecs = await embedder.embed(Object.values(titles));
    for (const [i, [id, title]] of Object.entries(titles).entries())
        await db.prepare("INSERT INTO records (publisher, repo, id, cid, type, payload, text, vec) VALUES ('p', 'r', ?, 'c', 'game', ?, ?, ?)")
            .bind(id, JSON.stringify({ title }), title, JSON.stringify(Array.from(vecs[i]))).run();
    const q = await embedder.query("furniture"), ids = async () => (await index.search(q)).map((h) => h.id);
    const before = await ids();
    expect(await index.packVectors(2)).toBe(2);   // bounded per run; a mix of JSON and int8 still searches
    expect(await ids()).toEqual(before);
    expect(await index.packVectors()).toBe(1);
    expect(await index.packVectors()).toBe(0);
    expect(await ids()).toEqual(before);
});
