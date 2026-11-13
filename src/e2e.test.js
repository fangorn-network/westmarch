// Publish → the runner follows → an agent searches and fetches over MCP. All in memory.
import { test, expect } from "vitest";
import { memoryNetwork } from "@fangorn-network/sdk/lib/test/testbed.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { run } from "./run.js";
import { mcpServer } from "./mcp.js";
import { fakeEmbedder } from "./testing.js";

const call = async (agent, name, args) => {
    const res = await agent.callTool({ name, arguments: args });
    return { ...res, data: res.isError ? null : JSON.parse(res.content[0].text) };
};

test("publish, index, and an agent finds and fetches it", async () => {
    const net = memoryNetwork();
    const [alice, eve, indexer] = await Promise.all([net.client(), net.client(), net.client()]);
    await Promise.all([alice.initRepo("shop"), eve.initRepo("shop")]);
    await alice.uploadBatch("shop", [{ id: "t", type: "item", payload: { name: "oak table", sku: "OAK-1" } }]);

    const config = { publishers: [alice.getAddress()], repos: ["shop"] };
    const runner = await run({ config, fangorn: indexer, embedder: fakeEmbedder(), path: ":memory:", log: () => {} });

    const [a, b] = InMemoryTransport.createLinkedPair();
    await mcpServer({ index: runner.index, fangorn: indexer }).connect(a);
    const agent = new Client({ name: "agent", version: "0" });
    await agent.connect(b);
    expect((await agent.listTools()).tools.map((t) => t.name).sort()).toEqual(["get", "repos", "search"]);

    // what's here
    expect((await call(agent, "repos", {})).data).toEqual([{ publisher: alice.getAddress().toLowerCase(), repo: "shop", records: 1 }]);

    // found by words
    const [hit] = (await call(agent, "search", { query: "OAK-1" })).data;
    expect(hit).toMatchObject({ repo: "shop", id: "t", payload: { name: "oak table" } });

    // new data is picked up by the watch, no tick needed; eve's isn't
    await eve.uploadBatch("shop", [{ id: "x", type: "item", payload: { name: "eve lamp" } }]);
    await alice.uploadBatch("shop", [{ id: "l", type: "item", payload: { name: "brass lamp" } }]);
    await expect.poll(async () => (await call(agent, "search", { query: "lamp", mode: "lexical" })).data.map((r) => r.id)).toEqual(["l"]);

    // fetched live from fangorn, by what the hit names
    const got = await call(agent, "get", { publisher: hit.publisher, repo: hit.repo, id: hit.id });
    expect(got.data).toMatchObject({ id: "t", payload: { name: "oak table", sku: "OAK-1" } });
    expect((await call(agent, "get", { publisher: hit.publisher, repo: "shop", id: "nope" })).isError).toBe(true);

    await agent.close();
    await runner.stop();
});
