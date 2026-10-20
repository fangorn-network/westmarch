// The stock page's tools for agents in a browser: the same verbs as fangorn-mcp's data
// tools, over the rows this page loaded. `ctx` holds them; ship's card captures these.
import { describe, facet, getRow, search, threads } from "../src/agent/tools.js";
import { KNOBS, discover } from "../src/taste/taste.js";

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
    mc.registerTool({
        name: "threads",
        description: "One thing followed across records (a matter from committee to council): each thread's steps in date order, the latest-moving first, with the head record when there is one. `id` for one thread (a step's thread field); `where` narrows the steps.",
        inputSchema: obj({ id: { type: "string" }, where: { type: "object" }, limit: { type: "number" }, offset: { type: "number" } }),
        execute: async ({ id, where, limit = 20, offset = 0 }) => ok(threads(ctx.rows, ctx.roles, { id, where, limit, offset })),
    });
    // What the person using this page has done: saved, passed on, searched, and the taste
    // that makes. Theirs, in their browser; an agent in the same browser can act on it.
    mc.registerTool({
        name: "session",
        description: "What the person on this page saved and searched this session, and the taste (a vector over this app's records) their choices make.",
        inputSchema: obj({}),
        execute: async () => ok(ctx.session?.() ?? { saved: [], searches: [], taste: null }),
    });
    // Like / dislike and "For you": the same calls the page's save star and knobs make (ctx.rate,
    // ctx.votes, set by main.js), so what an agent records shows on the page.
    mc.registerTool({
        name: "rate",
        description: "Record that the person liked or disliked a record (or clear it), by the id search returns. Builds the taste discover ranks with.",
        inputSchema: obj({ id: { type: "string" }, verdict: { type: "string", enum: ["like", "dislike", "clear"] } }, ["id", "verdict"]),
        execute: async ({ id, verdict }) => ok(ctx.rate?.(id, verdict) ?? { error: "this page keeps no taste" }),
    });
    mc.registerTool({
        name: "discover",
        description: "Records for a taste: a kernel over what was liked (newest last) and disliked, not a text search. Pass likes and dislikes (ids from search), or omit them to use the taste on this page. Knobs are 0–1.",
        inputSchema: obj({ likes: { type: "array", items: { type: "string" } }, dislikes: { type: "array", items: { type: "string" } },
            ...Object.fromEntries(Object.entries(KNOBS).map(([k, [d, what]]) => [k, { type: "number", minimum: 0, maximum: 1, default: d, description: what }])),
            seed: { type: "integer", description: "Same seed, same shuffle" }, limit: { type: "integer", minimum: 1, maximum: 50, default: 10 } }),
        execute: async ({ likes, dislikes, limit = 10, ...knobs }) => {
            const byId = (ids) => ids.map((id) => ctx.rows.find((r) => r.id === getRow(ctx.rows, id, ctx.roles)?.id)).filter((r) => r?.vector);
            const v = likes ? { likes: byId(likes), dislikes: byId(dislikes ?? []) } : ctx.votes?.() ?? { likes: [], dislikes: [] };
            if (!v.likes.length) return ok({ error: "like at least one record first (ids from search, or rate)" });
            const out = discover(ctx.rows, v.likes, v.dislikes, { ...knobs, limit: Math.min(50, limit) });
            return ok({ ...out, picks: out.picks.map(({ row, score }) => ({ ...getRow(ctx.rows, row.id, ctx.roles), score })) });
        },
    });
}
