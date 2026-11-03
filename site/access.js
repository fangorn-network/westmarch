// How to use the app from an agent: its MCP server, a line for Claude Code, and how to buy what is sold.

function copyable(el, label, text) {
    const code = el("code", {}, text);
    const btn = el("button", { type: "button", className: "chip", onclick: async () => {
        try { await navigator.clipboard.writeText(text); btn.textContent = "Copied"; } catch { btn.textContent = "Select and copy"; }
        setTimeout(() => { btn.textContent = "Copy"; }, 1500);
    } }, "Copy");
    return el("div", { className: "copy" }, el("small", {}, label), el("pre", {}, code), btn);
}

/** How to use the app from an agent: its MCP server, a line for Claude Code, and how to buy. `paid`: the app quotes records. */
export function agentPanel({ el, origin, name, paid = false }) {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    return el("section", { className: "agents" },
        el("h2", { className: "page" }, "Use it with an agent"),
        el("p", {}, `${name} is an MCP server: any agent that speaks MCP can search it, read records and follow links, with no install.`),
        copyable(el, "Claude Code", `claude mcp add --transport http ${slug} ${origin}/mcp`),
        copyable(el, "Any MCP client (streamable HTTP)", JSON.stringify({ mcpServers: { [slug]: { type: "http", url: `${origin}/mcp` } } }, null, 2)),
        paid ? el("p", { className: "hint" }, "Records marked for sale are bought by an agent with a wallet: fangorn-mcp's buy tool pays the publisher's price in USDC and opens the record.") : null,
        el("p", { className: "hint" }, "Machine-readable: ", el("a", { href: `${origin}/.well-known/agent-card.json` }, "agent card")));
}
