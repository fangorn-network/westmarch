// MCP over streamable HTTP, stateless: every POST is one JSON-RPC message, answered with one JSON body.
// The base tools work on any index: search (by meaning), repos (what's indexed), get (a record live from Fangorn).
// An app adds its own tools, or replaces a base one by name: { name, description, inputSchema, run(args, ctx) }.

const text = (v) => ({ content: [{ type: "text", text: JSON.stringify(v) }] });

/** The base tools, by name, so an app can reuse one's run with its own description: { ...BASE.search, description }. */
export const BASE = {
    search: {
        name: "search",
        description: "Find records by what they're about (semantic search). Each hit has publisher, repo, id, cid, type, payload and score.",
        inputSchema: { type: "object", required: ["query"], properties: {
            query: { type: "string", description: "What to look for, in your own words" },
            type: { type: "string", description: "Only records of this type" },
            k: { type: "integer", minimum: 1, maximum: 50, description: "How many results (default 10)" },
        } },
        async run(a, { index, query }) {
            const k = Math.min(Number(a.k) || 10, 50), vec = await query(String(a.query ?? ""));
            // ponytail: overfetch then filter; a type column in the search once indexes are big
            const hits = a.type ? (await index.search(vec, { k: k * 5 })).filter((h) => h.type === a.type) : await index.search(vec, { k });
            return hits.slice(0, k);
        },
    },
    repos: {
        name: "repos",
        description: "Every repo in the index: publisher, repo name, and how many records it holds.",
        inputSchema: { type: "object", properties: {} },
        async run(_, { index }) {
            const counts = {};
            for (const r of await index.rows()) counts[`${r.publisher}/${r.repo}`] = (counts[`${r.publisher}/${r.repo}`] ?? 0) + 1;
            return Object.entries(counts).map(([k, records]) => ({ publisher: k.split("/")[0], repo: k.split("/")[1], records }));
        },
    },
    get: {
        name: "get",
        description: "One record's current version, read live from Fangorn. When its payload has a src (a file in storage), `url` is where to fetch it.",
        inputSchema: { type: "object", required: ["publisher", "repo", "id"], properties: {
            publisher: { type: "string", description: "The publisher's 0x address" },
            repo: { type: "string" },
            id: { type: "string" },
        } },
        async run(a, { fangorn, gateway }) {
            const record = await fangorn.engine.readRecord(a.publisher, a.repo, a.id);
            if (!record) throw new Error(`no record ${a.publisher}/${a.repo}/${a.id}`);
            const src = record.payload?.src;
            return typeof src === "string" ? { ...record, url: `${gateway}/ipfs/${src}` } : record;
        },
    },
};

/**
 * One JSON-RPC message → its answer (null for a notification).
 * ctx: `index` (d1Index), `query(text)` → vector, `fangorn` (a reader), `gateway`, `name`, `instructions`,
 * `tools` (the app's, added to BASE or replacing one by name), and whatever else the app's tools read (auth, origin …).
 */
export async function mcpCall(ctx, msg) {
    if (msg.id === undefined) return null;
    const ok = (result) => ({ jsonrpc: "2.0", id: msg.id, result });
    const tools = Object.values({ ...BASE, ...Object.fromEntries((ctx.tools ?? []).map((t) => [t.name, t])) });
    switch (msg.method) {
        case "initialize": return ok({
            protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: ctx.name, version: "0.3.0" },
            instructions: ctx.instructions,
        });
        case "ping": return ok({});
        case "tools/list": return ok({ tools: tools.map(({ run, ...t }) => t) });
        case "tools/call": {
            const tool = tools.find((t) => t.name === msg.params?.name);
            try {
                if (!tool) throw new Error(`unknown tool ${msg.params?.name}`);
                return ok(text(await tool.run(msg.params?.arguments ?? {}, ctx)));
            } catch (e) { return ok({ isError: true, content: [{ type: "text", text: e?.message ?? String(e) }] }); }
        }
        default: return { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `unknown method ${msg.method}` } };
    }
}
