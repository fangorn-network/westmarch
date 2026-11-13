import { test, expect } from "vitest";
import { memoryNetwork } from "@fangorn-network/sdk/lib/test/testbed.js";
import { stitcher } from "../src/stitcher.js";
import { d1Index, SCHEMA } from "../src/d1.js";
import { d1Shim, fakeEmbedder } from "../src/testing.js";
import { mcpCall, BASE } from "./mcp.js";

test("the Worker's MCP: base tools on any index, and an app's tools added or replacing one", async () => {
    const net = memoryNetwork();
    const [alice, indexer] = await Promise.all([net.client(), net.client()]);
    const db = await d1Shim();
    await db.exec(SCHEMA);
    const index = d1Index({ db, fangorn: indexer }), embedder = fakeEmbedder();

    await alice.initRepo("notes");
    const src = await alice.getStorage().putFile(new TextEncoder().encode("hi"), "t.txt");
    await alice.uploadBatch("notes", [{ id: "t", type: "note", payload: { title: "table flip", src } }, { id: "u", type: "memo", payload: { title: "chair" } }]);
    await stitcher(indexer, { repos: ["notes"] }, { store: index.store, lens: index.lens }).update();
    await index.embedMissing(embedder.embed);

    const ctx = { index, query: embedder.query, fangorn: indexer, gateway: "https://gw", name: "notes", instructions: "notes" };
    let n = 0;
    const call = async (c, method, params) => (await mcpCall(c, { jsonrpc: "2.0", id: ++n, method, params })).result;
    const tool = async (c, name, args) => { const r = await call(c, "tools/call", { name, arguments: args }); if (r.isError) throw new Error(r.content[0].text); return JSON.parse(r.content[0].text); };

    expect((await call(ctx, "initialize", {})).serverInfo.name).toBe("notes");
    expect((await call(ctx, "tools/list")).tools.map((t) => t.name)).toEqual(["search", "repos", "get"]);
    expect((await call(ctx, "tools/list")).tools[0].run).toBeUndefined();
    expect(await mcpCall(ctx, { jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();

    const [hit] = await tool(ctx, "search", { query: "furniture", k: 1 });
    expect(hit).toMatchObject({ payload: { title: expect.any(String) } });
    expect((await tool(ctx, "search", { query: "x", type: "memo" })).map((h) => h.id)).toEqual(["u"]);
    expect(await tool(ctx, "repos", {})).toEqual([{ publisher: alice.getAddress().toLowerCase(), repo: "notes", records: 2 }]);
    expect(await tool(ctx, "get", { publisher: alice.getAddress(), repo: "notes", id: "t" })).toMatchObject({ id: "t", url: `https://gw/ipfs/${src}` });
    expect((await call(ctx, "tools/call", { name: "get", arguments: { publisher: alice.getAddress(), repo: "notes", id: "nope" } })).isError).toBe(true);
    expect((await call(ctx, "tools/call", { name: "nope" })).isError).toBe(true);

    // an app: a new tool that reads ctx, and the base get replaced
    const app = { ...ctx, auth: "tok", tools: [
        { name: "whoami", description: "x", inputSchema: { type: "object" }, run: (_, c) => ({ auth: c.auth }) },
        { ...BASE.get, run: async (a, c) => ({ ...await BASE.get.run(a, c), extra: true }) },
    ] };
    expect((await call(app, "tools/list")).tools.map((t) => t.name)).toEqual(["search", "repos", "get", "whoami"]);
    expect(await tool(app, "whoami", {})).toEqual({ auth: "tok" });
    expect(await tool(app, "get", { publisher: alice.getAddress(), repo: "notes", id: "t" })).toMatchObject({ id: "t", extra: true });
});
