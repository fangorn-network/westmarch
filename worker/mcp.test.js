import { test, expect } from "vitest";
import { memoryNetwork } from "@fangorn-network/sdk/lib/test/testbed.js";
import { stitcher } from "../src/stitcher.js";
import { d1Index, SCHEMA } from "../src/d1.js";
import { d1Shim, fakeEmbedder } from "../src/testing.js";
import { mcpCall, BASE } from "./mcp.js";
import { manifest } from "./index.js";

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
    const lexical = { ...ctx, query: () => { throw new Error("lexical mode should skip embeddings"); } };
    expect(await tool(lexical, "search", { query: "furniture", keywords: "chair", mode: "lexical" }))
        .toMatchObject([{ id: "u", cid: expect.any(String) }]);
    expect(await tool(ctx, "repos", {})).toEqual([{ publisher: alice.getAddress().toLowerCase(), repo: "notes", records: 2 }]);
    const t = await tool(ctx, "get", { publisher: alice.getAddress(), repo: "notes", id: "t" });
    expect(t).toMatchObject({ id: "t", url: `https://gw/ipfs/${src}` });
    expect(t.file).toBeUndefined(); // no mime, but not JSON: the url only
    expect((await call(ctx, "tools/call", { name: "get", arguments: { publisher: alice.getAddress(), repo: "notes", id: "nope" } })).isError).toBe(true);
    // a gated app: get serves a version only once it passed
    const gated = { ...ctx, index: { ...ctx.index, allows: async (p, r, id) => id !== "t" } };
    const refused = await call(gated, "tools/call", { name: "get", arguments: { publisher: alice.getAddress(), repo: "notes", id: "t" } });
    expect([refused.isError, refused.content[0].text]).toEqual([true, expect.stringMatching(/isn.t served here/)]);
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

test("get inlines JSON files; publish is listed where the app publishes; types document `type`", async () => {
    const net = memoryNetwork();
    const [alice, indexer] = await Promise.all([net.client(), net.client()]);
    await alice.initRepo("parts");
    const put = (v, name) => alice.getStorage().putFile(typeof v === "string" ? new TextEncoder().encode(v) : v, name);
    const json = await put(JSON.stringify({ html: "<p>hi</p>" }), "g.json"), png = await put(new Uint8Array([1, 2, 3]), "a");
    await alice.uploadBatch("parts", [{ id: "g", type: "game", payload: { src: json } }, { id: "a", type: "asset", payload: { src: png, mime: "image/png" } }]);

    let n = 0;
    const call = async (c, method, params) => (await mcpCall(c, { jsonrpc: "2.0", id: ++n, method, params })).result;
    const tool = async (c, name, args) => { const r = await call(c, "tools/call", { name, arguments: args }); if (r.isError) throw new Error(r.content[0].text); return JSON.parse(r.content[0].text); };
    const ctx = { fangorn: indexer, gateway: "https://gw", name: "parts" };

    expect((await tool(ctx, "get", { publisher: alice.getAddress(), repo: "parts", id: "g" })).file).toEqual({ html: "<p>hi</p>" });
    const a = await tool(ctx, "get", { publisher: alice.getAddress(), repo: "parts", id: "a" });
    expect(a).toMatchObject({ url: `https://gw/ipfs/${png}` });
    expect(a.file).toBeUndefined();

    // publishing on: the tool is listed, needs the bearer, and goes through the app's publish
    const sent = [];
    const on = { ...ctx, types: { game: "an HTML page", asset: "a file" }, connect: "https://connect", publish: async (token, body) => (sent.push({ token, body }), { id: body.record.id }) };
    const tools = (await call(on, "tools/list")).tools;
    expect(tools.map((t) => t.name)).toEqual(["search", "repos", "get", "publish"]);
    expect(tools[0].inputSchema.properties.type.enum).toEqual(["game", "asset"]);
    expect(tools[3].inputSchema.properties.record.properties.type.enum).toEqual(["game", "asset"]);
    expect(BASE.search.inputSchema.properties.type.enum).toBeUndefined(); // the base tools aren't changed
    await expect(tool(on, "publish", { record: { id: "x", type: "game" } })).rejects.toThrow(/https:\/\/connect/);
    expect(await tool({ ...on, auth: "tok" }, "publish", { record: { id: "x", type: "game" } })).toEqual({ id: "x" });
    expect(sent).toEqual([{ token: "tok", body: { record: { id: "x", type: "game" } } }]);
});

test("GET /api.json: the deployment, with a connect URL for the API's own origin where it publishes", () => {
    const at = { origin: "https://isw.fangorn.network", gateway: "https://gw", name: "isw" };
    const m = manifest({ follow: ["isw"], publishPerDay: 5, types: { game: "g" } }, at);
    expect(m).toMatchObject({ name: "isw", network: "baseSepolia", gateway: "https://gw", repos: ["isw"], types: { game: "g" }, publish: true, mcp: "https://isw.fangorn.network/mcp" });
    const q = new URLSearchParams(m.connect.split("?")[1]);
    expect(m.connect.startsWith("https://fangorn.network/#/connect?")).toBe(true);
    expect(Object.fromEntries(q)).toEqual({ app: "https://isw.fangorn.network", repos: "isw", name: "isw", mcp: "https://isw.fangorn.network/mcp" });
    expect(manifest({ repos: ["a", "b"] }, at)).toEqual({ name: "isw", network: "baseSepolia", gateway: "https://gw", repos: ["a", "b"], types: {}, schema: null, rules: [], publish: false, mcp: "https://isw.fangorn.network/mcp" });
    expect(manifest({ repos: ["a"], schema: { type: "object" }, rules: "bafyR" }, at)).toMatchObject({ schema: { type: "object" }, rules: ["bafyR"] });
});
