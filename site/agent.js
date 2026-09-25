// The stock page's tools for agents in a browser: the same verbs as fangorn-mcp's data
// tools, over the rows this page loaded. `ctx` holds them; ship's card captures these.
import { describe, facet, getRow, search } from "../consume/tools.js";

const ok = (o) => ({ content: [{ type: "text", text: JSON.stringify(o) }] });
const obj = (properties, required = []) => ({ type: "object", properties, required });

export function registerAgent(ctx) {
    const mc = document.modelContext;
    if (!mc?.registerTool) return;   // most browsers have no WebMCP yet
    mc.registerTool({
        name: "describe",
        description: "What this app holds: its fields and how often each is present. Call it first.",
        inputSchema: obj({}),
        execute: async () => ok(describe(ctx.rows)),
    });
    mc.registerTool({
        name: "search",
        description: "Search by meaning: a question in plain words. Optional equality filters in `where`.",
        inputSchema: obj({ query: { type: "string" }, limit: { type: "number" }, where: { type: "object" } }, ["query"]),
        execute: async ({ query, limit = 10, where }) =>
            ok(search(ctx.rows, query, ctx.roles, { qv: await ctx.queryVector(query), limit, where })),
    });
    mc.registerTool({
        name: "get",
        description: "One record in full, by the id search returns.",
        inputSchema: obj({ id: { type: "string" } }, ["id"]),
        execute: async ({ id }) => ok(getRow(ctx.rows, id, ctx.roles) ?? { error: `no record ${id}` }),
    });
    mc.registerTool({
        name: "count",
        description: "Count the distinct values of a field: the shape of the data before reading it.",
        inputSchema: obj({ field: { type: "string" }, where: { type: "object" }, limit: { type: "number" } }, ["field"]),
        execute: async ({ field, where, limit = 20 }) => ok(facet(ctx.rows, field, { where, limit })),
    });
    // What the person using this page has done: saved, passed on, searched, and the taste
    // that makes. Theirs, in their browser; an agent in the same browser can act on it.
    mc.registerTool({
        name: "session",
        description: "What the person on this page saved and searched this session, and the taste (a vector over this app's records) their choices make.",
        inputSchema: obj({}),
        execute: async () => ok(ctx.session?.() ?? { saved: [], searches: [], taste: null }),
    });
}
