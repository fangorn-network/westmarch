import { test, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryNetwork } from "@fangorn-network/sdk/lib/test/testbed.js";
import { stitcher } from "./stitcher.js";
import { sqliteIndex } from "./sqlite.js";
import { fakeEmbedder } from "./testing.js";

const tmp = () => join(mkdtempSync(join(tmpdir(), "indexer-")), "index.db");

async function setup({ path = ":memory:", embedder = fakeEmbedder(), repos = ["shop"] } = {}) {
    const net = memoryNetwork();
    const [alice, bob, indexer] = await Promise.all([net.client(), net.client(), net.client()]);
    await Promise.all([alice.initRepo("shop"), alice.initRepo("blog"), bob.initRepo("shop")]);
    const open = (o = {}) => {
        const index = sqliteIndex({ path, fangorn: indexer, embedder, ...o });
        const cfg = { publishers: [alice.getAddress(), bob.getAddress()], repos: o.repos ?? repos };
        return { index, s: stitcher(indexer, cfg, { store: index.store, lens: index.lens }) };
    };
    return { net, alice, bob, indexer, embedder, open };
}

const ids = (rows) => rows.map((r) => r.id).sort();
const all = (index) => index.db.prepare("SELECT id, payload FROM records ORDER BY id").all();

test("follows the stitch: puts, updates and deletes, embedding only what changed", async () => {
    const { alice, embedder, open } = await setup();
    const { index, s } = open();
    await alice.uploadBatch("shop", [
        { id: "t", type: "item", payload: { name: "oak table" } },
        { id: "l", type: "item", payload: { name: "brass lamp" } },
    ]);
    await s.update();
    expect(ids(all(index))).toEqual(["l", "t"]);

    await alice.uploadBatch("shop", [{ id: "t", type: "item", payload: { name: "pine table" } }], ["l"]);
    await s.update();
    expect(all(index)).toMatchObject([{ id: "t", payload: JSON.stringify({ name: "pine table" }) }]);
    expect(embedder.seen.sort()).toEqual(["name: brass lamp", "name: oak table", "name: pine table"]);
});

test("the stitch and the rows are saved together, in one file: a reopen resumes both", async () => {
    const path = tmp();
    const { alice, embedder, open } = await setup({ path });
    let { index, s } = open();
    await alice.uploadBatch("shop", [{ id: "t", type: "item", payload: { name: "oak table" } }]);
    const r0 = await s.update();
    index.close();

    ({ index, s } = open());
    expect(await s.update()).toBe(r0);
    expect(ids(all(index))).toEqual(["t"]);
    expect(embedder.seen).toHaveLength(1); // nothing re-embedded
});

test("a failed embed writes nothing; the next update retries it", async () => {
    const { alice, embedder, open } = await setup();
    const { index, s } = open();
    await alice.uploadBatch("shop", [{ id: "t", type: "item", payload: { name: "oak table" } }]);
    const embed = embedder.embed;
    embedder.embed = async () => { throw new Error("model down"); };
    await expect(s.update()).rejects.toThrow("model down");
    expect(all(index)).toEqual([]);
    expect(await index.store.load()).toBeUndefined();

    embedder.embed = embed;
    await s.update();
    expect(ids(all(index))).toEqual(["t"]);
});

test("refuses a file embedded by another model", async () => {
    const path = tmp();
    const { alice, open } = await setup({ path });
    const { index, s } = open();
    await alice.uploadBatch("shop", [{ id: "t", type: "item", payload: { name: "oak table" } }]);
    await s.update();
    index.close();
    expect(() => open({ embedder: { ...fakeEmbedder(), id: { model: "other" } } })).toThrow(/embedded by/);
});

test("following other repos rebuilds: rows of repos no longer followed go", async () => {
    const path = tmp();
    const { alice, open } = await setup({ path });
    let { index, s } = open();
    await alice.uploadBatch("shop", [{ id: "t", type: "item", payload: { name: "oak table" } }]);
    await alice.uploadBatch("blog", [{ id: "p", type: "post", payload: { title: "hello" } }]);
    await s.update();
    expect(ids(all(index))).toEqual(["t"]);
    index.close();

    ({ index, s } = open({ repos: ["blog"] }));
    await s.update();
    expect(ids(all(index))).toEqual(["p"]);
});

test("search: by meaning, by words, filtered, and both", async () => {
    const { alice, bob, open } = await setup();
    const { index, s } = open();
    await alice.uploadBatch("shop", [
        { id: "t", type: "item", payload: { name: "oak table", sku: "OAK-1" } },
        { id: "c", type: "item", payload: { name: "pine chair", sku: "PIN-2" } },
        { id: "l", type: "item", payload: { name: "brass lamp", sku: "BRS-3" } },
    ]);
    await bob.uploadBatch("shop", [{ id: "r", type: "rug", payload: { name: "wool rug", sku: "WOL-4" } }]);
    await s.update();

    // meaning: "furniture" is in no record, but the embedder puts it near tables and chairs
    const sem = await index.search("furniture", { mode: "semantic", k: 2 });
    expect(ids(sem)).toEqual(["c", "t"]);
    expect(await index.search("furniture", { mode: "lexical" })).toEqual([]);

    // words: an exact SKU, which the embedder can't see
    expect((await index.search("BRS-3", { mode: "lexical" })).map((r) => r.id)).toEqual(["l"]);

    // both: the SKU match and the meaning match each make it in
    const both = await index.search("lamp OAK-1", { k: 2 });
    expect(ids(both)).toEqual(["l", "t"]);

    // filters
    expect(ids(await index.search("rug", { publisher: bob.getAddress() }))).toEqual(["r"]);
    expect(await index.search("rug", { publisher: alice.getAddress(), mode: "lexical" })).toEqual([]);
    expect(ids(await index.search("anything", { type: "rug", mode: "semantic" }))).toEqual(["r"]);

    // a hit carries what an agent needs to fetch the record
    expect((await index.search("BRS-3"))[0]).toMatchObject({
        publisher: alice.getAddress().toLowerCase(), repo: "shop", id: "l", type: "item",
        payload: { name: "brass lamp", sku: "BRS-3" },
    });
    expect((await index.search("BRS-3"))[0].cid).toBeTruthy();
});

test("search: query text with FTS syntax in it doesn't throw", async () => {
    const { open } = await setup();
    const { index } = open();
    await expect(index.search(`"unbalanced AND (NOT`, { mode: "lexical" })).resolves.toEqual([]);
});
