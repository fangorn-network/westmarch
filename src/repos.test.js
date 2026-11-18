import { test, expect } from "vitest";
import { memoryNetwork } from "@fangorn-network/sdk/lib/test/testbed.js";
import { FANGORN_REPO_EXTENSION } from "@fangorn-network/sdk";
import { stitcher } from "./stitcher.js";
import { d1Repos, textOf, SCHEMA } from "./repos.js";
import { d1Shim } from "./testing.js";
import { mcpCall } from "../worker/mcp.js";

test("repos: every repo of every publisher, cards kept only when they speak for the repo, read a bounded batch at a time", async () => {
    const net = memoryNetwork();
    const [alice, bob, eve, indexer] = await Promise.all([net.client(), net.client(), net.client(), net.client()]);
    const { caip2, dataRegistryContractAddress } = indexer.getConfig();
    const cardFor = (publisher, repo, name, description) => ({ name, description, skills: [{ name: "search", tags: ["furniture"] }],
        capabilities: { extensions: [{ uri: FANGORN_REPO_EXTENSION, params: { chainId: caip2, dataRegistry: dataRegistryContractAddress, publisher, repo } }] } });
    const cards = {
        "https://a.example/card.json": cardFor(alice.getAddress(), "shop", "Oak & Iron", "Handmade tables and chairs"),
        "https://e.example/card.json": cardFor(alice.getAddress(), "shop", "Fake", "Claims to be alice"), // eve binds alice's card
    };
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => cards[url] ? new Response(JSON.stringify(cards[url])) : realFetch(url, init);

    try {
        const put = async (c, repo, records) => { await c.initRepo(repo); return c.uploadBatch(repo, records); };
        await put(alice, "shop", [{ id: "oak", type: "item", payload: { name: "oak table" } }, { id: "@card", type: "card", payload: { url: "https://a.example/card.json" } }]);
        await put(bob, "field-notes", [{ id: "n1", type: "note", payload: { text: "saw a heron" } }]);
        await put(eve, "shop", [{ id: "@card", type: "card", payload: { url: "https://e.example/card.json" } }]);

        const db = await d1Shim();
        await db.exec(SCHEMA);
        let t = "t1";
        const index = d1Repos({ db, fangorn: indexer, now: () => t });
        const s = stitcher(indexer, { follow: ["*"] }, { store: index.store, lens: index.lens });
        await s.update();
        expect((await index.rows()).map((r) => r.repo).sort()).toEqual(["field-notes", "shop", "shop"]); // listed before any card is read
        expect(await index.cardsMissing(2)).toBe(2);                                                       // the budget holds
        expect(await index.cardsMissing()).toBe(1);
        expect(await index.cardsMissing()).toBe(0);

        const a = await index.get(alice.getAddress(), "shop");
        expect(a).toMatchObject({ card_url: "https://a.example/card.json", card: { name: "Oak & Iron" }, updated: "t1" });
        expect((await index.get(eve.getAddress(), "shop")).card).toBe(null); // a card naming someone else's repo isn't kept
        expect((await index.get(bob.getAddress(), "field-notes")).card).toBe(null);

        const vocab = ["table", "chairs", "heron", "notes"];
        const embed = async (ts) => ts.map((x) => vocab.map((v) => x.toLowerCase().split(/\W+/).filter((w) => w === v).length));
        expect(await index.embedMissing(embed)).toBe(3);
        expect((await index.find({ q: (await embed(["tables and chairs"]))[0] }))[0].repo).toBe("shop");
        expect((await index.search((await embed(["heron notes"]))[0]))[0].publisher).toBe(bob.getAddress().toLowerCase());
        expect((await index.find({ publisher: bob.getAddress() })).map((r) => r.repo)).toEqual(["field-notes"]);

        // A moved head: restamped and its card re-read; the vector stays when the text didn't change, goes when it did.
        t = "t2";
        await put(bob, "field-notes", [{ id: "n2", type: "note", payload: { text: "two herons" } }]);
        await s.update();
        expect(await index.cardsMissing()).toBe(1);
        expect((await index.get(bob.getAddress(), "field-notes")).updated).toBe("t2");
        expect(await index.embedMissing(embed)).toBe(0);
        cards["https://a.example/card.json"].description = "Lamps now too";
        await put(alice, "shop", [{ id: "lamp", type: "item", payload: { name: "lamp" } }]);
        await s.update();
        expect(await index.cardsMissing()).toBe(1);
        expect(await index.embedMissing(embed)).toBe(1);

        // The MCP tools of a repos index.
        const call = async (name, args) => JSON.parse((await mcpCall({ index, fangorn: indexer, repos: true, query: async (q) => (await embed([q]))[0] },
            { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })).result.content[0].text);
        const list = await mcpCall({ repos: true }, { jsonrpc: "2.0", id: 1, method: "tools/list" });
        expect(list.result.tools.map((x) => x.name)).toEqual(["find", "repo", "read"]);
        expect((await call("find", { query: "notes" }))[0].repo).toBe("field-notes");
        expect((await call("repo", { publisher: alice.getAddress(), repo: "shop" })).card.description).toBe("Lamps now too");
        expect((await call("read", { publisher: alice.getAddress(), repo: "shop", id: "lamp" })).payload.name).toBe("lamp");
    } finally { globalThis.fetch = realFetch; }

    expect(textOf("field-notes", null)).toBe("field notes");
});
