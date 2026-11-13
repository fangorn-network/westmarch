#!/usr/bin/env node
// The agent's door to the index, as an MCP server: `search` and `repos` to discover, `get` to fetch.
//
//   node src/mcp.js app.json            serve an index another process keeps (run.js)
//   node src/mcp.js app.json --watch    and keep it up to date here too
//
// stdout is the MCP channel: everything else goes to stderr.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { isMain, readConfig, run } from "./run.js";
import { sqliteIndex } from "./sqlite.js";
import { localEmbedder } from "./embed.js";
import { client } from "./client.js";

const ok = (v) => ({ content: [{ type: "text", text: JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x)) }] });
const fail = (text) => ({ isError: true, content: [{ type: "text", text }] });

export function mcpServer({ index, fangorn }) {
    const server = new McpServer({ name: "fangorn-indexer", version: "0.0.1" });
    const reposQ = index.db.prepare("SELECT publisher, repo, count(*) AS records FROM records GROUP BY publisher, repo ORDER BY publisher, repo");

    server.registerTool("search", {
        description: "Search the indexed Fangorn records by meaning and by words. Returns the best matches, each with "
            + "publisher, repo, id, cid, type and payload. Use mode 'lexical' for exact names, ids or codes, 'semantic' for "
            + "what a record is about, 'hybrid' (default) for both. Filter with publisher, repo or type.",
        inputSchema: {
            query: z.string().describe("What to look for"),
            k: z.number().int().min(1).max(50).optional().describe("How many results (default 10)"),
            mode: z.enum(["hybrid", "semantic", "lexical"]).optional(),
            publisher: z.string().optional().describe("Only this publisher's records (0x address)"),
            repo: z.string().optional().describe("Only records in repos with this name"),
            type: z.string().optional().describe("Only records of this type"),
        },
    }, async ({ query, ...opts }) => ok(await index.search(query, opts)));

    server.registerTool("repos", {
        description: "Every repo in the index: publisher, repo name, and how many records it holds.",
        inputSchema: {},
    }, async () => ok(reposQ.all().map((r) => ({ ...r }))));

    server.registerTool("get", {
        description: "Fetch one record's current version live from Fangorn (chain + IPFS), by the publisher, repo and id a search returned.",
        inputSchema: { publisher: z.string(), repo: z.string(), id: z.string() },
    }, async ({ publisher, repo, id }) => {
        const r = await fangorn.engine.readRecord(publisher, repo, id);
        return r ? ok(r) : fail(`no record "${id}" in ${publisher}/${repo}`);
    });

    return server;
}

if (isMain(import.meta.url)) {
    const [file, ...flags] = process.argv.slice(2);
    if (!file) { console.error("usage: mcp.js app.json [--watch]"); process.exit(2); }
    const config = readConfig(file);
    const fangorn = client(config);
    const index = flags.includes("--watch")
        ? (await run({ config, fangorn, log: (m) => console.error(m) })).index
        : sqliteIndex({ path: config.db ?? "index.db", fangorn, embedder: localEmbedder() });
    await mcpServer({ index, fangorn }).connect(new StdioServerTransport());
}
