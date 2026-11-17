// MCP over streamable HTTP, stateless: every POST is one JSON-RPC message, answered with one JSON body.
// The base tools work on any index: search (by meaning), repos (what's indexed), get (a record live from Fangorn),
// and publish (into the caller's own repo, when the app publishes). worker/API.md is their spec.
// An app adds its own tools, or replaces a base one by name: { name, description, inputSchema, run(args, ctx) }.

const text = (v) => ({ content: [{ type: "text", text: JSON.stringify(v) }] });
const MAX_INLINE = 5 * 1024 * 1024;
const REF = { type: "object", required: ["id"], properties: { publisher: { type: "string", description: "0x address (default: yours)" }, repo: { type: "string", description: "default: the repo you publish to" }, id: { type: "string" } } };

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
            const k = Math.min(Math.max(Math.floor(Number(a.k)) || 10, 1), 50), vec = await query(String(a.query ?? ""));
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
            const { src, mime } = record.payload ?? {};
            if (typeof src !== "string") return record;
            const out = { ...record, url: `${gateway}/ipfs/${src}` };
            if (mime && mime !== "application/json") return out;
            // A file without mime is JSON: inline it, so an agent gets the content in one call. Anything else stays a url.
            // ponytail: downloads the whole file before the size check; a HEAD for its length if big files show up here
            try {
                const bytes = await fangorn.getStorage().getFile(src);
                if (bytes.length <= MAX_INLINE) out.file = JSON.parse(new TextDecoder().decode(bytes));
            } catch { /* not JSON, or storage refused it: the url still works */ }
            return out;
        },
    },
    publish: {
        name: "publish",
        description: "Publish a record into your own repo, publicly and permanently, signed by your wallet (show the person what will be published first). Needs this MCP added with your grant from fangorn.network as the bearer. `file` is uploaded to storage and becomes payload.src: { json } for content (stored as JSON), or { base64, mime } for a binary file, up to 5 MB. `pin` names payload keys that hold references ({ publisher?, repo?, id }, or lists of them) to other records: each is pinned to that record's current version. Publishing an id you already have replaces it.",
        inputSchema: { type: "object", required: ["record"], properties: {
            repo: { type: "string", description: "Which repo (default: the app's, when it has one)" },
            record: { type: "object", required: ["id", "type"], properties: {
                id: { type: "string", description: "Unique in your repo" },
                type: { type: "string" },
                payload: { type: "object", description: "The record's data" },
            } },
            file: { type: "object", description: "{ json } or { base64, mime }", properties: { json: {}, base64: { type: "string" }, mime: { type: "string" } } },
            pin: { type: "array", items: { type: "string" }, description: `Payload keys holding references to pin, each ${JSON.stringify(REF.properties)}` },
        } },
        async run(a, { auth, publish, connect }) {
            if (!auth) throw new Error(`Publishing needs you connected: open ${connect}, sign in, allow the app, then add this MCP again with the command shown there (it sends your grant as an Authorization header).`);
            return publish(auth, a);
        },
    },
};

/** The base tools for this deployment: publish only where the app publishes, and `type` documented by `types`. */
function baseTools({ publish, types }) {
    const tools = { ...BASE };
    if (!publish) delete tools.publish;
    if (!types || !Object.keys(types).length) return tools;
    const type = { type: "string", enum: Object.keys(types), description: Object.entries(types).map(([t, d]) => `${t}: ${d}`).join("; ") };
    const { search, publish: pub } = tools;
    tools.search = { ...search, inputSchema: { ...search.inputSchema, properties: { ...search.inputSchema.properties, type: { ...type, description: `Only records of this type. ${type.description}` } } } };
    if (pub) {
        const rec = pub.inputSchema.properties.record;
        tools.publish = { ...pub, inputSchema: { ...pub.inputSchema, properties: { ...pub.inputSchema.properties, record: { ...rec, properties: { ...rec.properties, type } } } } };
    }
    return tools;
}

/**
 * One JSON-RPC message → its answer (null for a notification).
 * ctx: `index` (d1Index), `query(text)` → vector, `fangorn` (a reader), `gateway`, `name`, `instructions`,
 * `types` (CONFIG.types), `publish(token, body)` and `connect` (where the app publishes; publish is listed only then),
 * `tools` (the app's, added to BASE or replacing one by name), and whatever else the app's tools read (auth, origin …).
 */
export async function mcpCall(ctx, msg) {
    if (msg.id === undefined) return null;
    const ok = (result) => ({ jsonrpc: "2.0", id: msg.id, result });
    const tools = Object.values({ ...baseTools(ctx), ...Object.fromEntries((ctx.tools ?? []).map((t) => [t.name, t])) });
    switch (msg.method) {
        case "initialize": return ok({
            protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: ctx.name, version: "0.3.1" },
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
