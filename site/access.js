// What a person sees before the data: what the app holds, how to reach it from an agent, and,
// for a private app (its card's `access`), what a pass costs and a way to buy one.
//
// A private app's view and tools need a pass (POST /pass, x402) or a payment per tool call.
// The catalog and the describe tool are free, so this page can say what is inside without one.
// The pass is kept on this device (localStorage) and sent as `Authorization: Bearer` with every
// read of the view; the agent panel hands the same token to an MCP client.

const usd = (units, decimals = 6, symbol = "USDC") => {
    const n = Number(units) / 10 ** decimals;
    return /^USDC?$/i.test(symbol) ? `$${n < 1 ? n.toFixed(2) : n.toFixed(n % 1 ? 2 : 0)}` : `${n} ${symbol}`;
};

/** The pass this device holds for `slug`, if it has not expired. */
export function heldPass(slug) {
    try {
        const p = JSON.parse(localStorage.getItem(`${slug}:pass`));
        return p?.token && p.expires > Date.now() / 1000 + 60 ? p : null;
    } catch { return null; }
}
const keepPass = (slug, p) => { try { localStorage.setItem(`${slug}:pass`, JSON.stringify({ token: p.token, expires: p.expires })); } catch { /* this visit only */ } };

/** What the free catalog and describe say: {rows, views, updated, about}. Nothing if not indexed yet. */
export async function whatsInside(origin) {
    const catalog = await fetch(`${origin}/view/cdn/catalog`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (!catalog) return null;
    const rows = catalog.domains.reduce((n, d) => n + (d.count ?? 0), 0);
    const described = await fetch(`${origin}/mcp`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "describe", arguments: {} } }) })
        .then((r) => r.json()).then((m) => JSON.parse(m.result.content[0].text)).catch(() => null);
    return { rows, views: catalog.domains.length, updated: catalog.generated_at ? new Date(catalog.generated_at * 1000) : null,
             about: described?.views?.map((v) => v.description).filter(Boolean) ?? [] };
}

function copyable(el, label, text) {
    const code = el("code", {}, text);
    const btn = el("button", { type: "button", className: "chip", onclick: async () => {
        try { await navigator.clipboard.writeText(text); btn.textContent = "Copied"; } catch { btn.textContent = "Select and copy"; }
        setTimeout(() => { btn.textContent = "Copy"; }, 1500);
    } }, "Copy");
    return el("div", { className: "copy" }, el("small", {}, label), el("pre", {}, code), btn);
}

/** How to use the app from an agent: its MCP server, a line for Claude Code, and what it costs. */
export function agentPanel({ el, origin, name, access, pass }) {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const header = pass ? ` --header "Authorization: Bearer ${pass.token}"` : "";
    const price = access && usd(access.call, access.decimals, access.symbol);
    return el("section", { className: "agents" },
        el("h2", { className: "page" }, "Use it with an agent"),
        el("p", {}, `${name} is an MCP server: any agent that speaks MCP can search it, read records and follow links, with no install.`),
        copyable(el, "Claude Code", `claude mcp add --transport http ${slug} ${origin}/mcp${header}`),
        copyable(el, "Any MCP client (streamable HTTP)", JSON.stringify({ mcpServers: { [slug]: { type: "http", url: `${origin}/mcp`,
            ...(pass ? { headers: { Authorization: `Bearer ${pass.token}` } } : {}) } } }, null, 2)),
        access ? el("p", { className: "hint" }, pass
            ? `This line carries your pass, good until ${new Date(pass.expires * 1000).toLocaleDateString()}: keep it like a password.`
            : `describe is free. Every other tool costs ${price} a call, paid by the agent over x402 (its MCP transport), or nothing with a pass: buy one above and this line will carry it.`) : null,
        el("p", { className: "hint" }, "Machine-readable: ", el("a", { href: `${origin}/.well-known/agent-card.json` }, "agent card"),
            access ? [" · ", el("a", { href: `${origin}/openapi.json` }, "OpenAPI (x402)")] : null));
}

/** A private app's front page without a pass: what is inside, the price, and a way to buy. */
export async function gate({ el, show, origin, name, description, slug, access, wallet, inside, examples = [] }) {
    const price = usd(access.pass, access.decimals, access.symbol);
    const status = el("p", { className: "hint", role: "status" });
    const buy = el("button", { type: "button", className: "buy" }, `Get a ${access.days}-day pass · ${price}`);
    const funds = el("p", { className: "hint" });
    buy.onclick = async () => {
        buy.disabled = true;
        try {
            status.textContent = "Signing in…";
            const w = await wallet();
            await w.signIn();
            const have = await w.balance();
            if (have != null && have < Number(access.pass) / 10 ** (access.decimals ?? 6)) {
                status.textContent = `Your account holds ${usd(have * 10 ** (access.decimals ?? 6), access.decimals, access.symbol)}; a pass is ${price}.`;
                funds.replaceChildren(el("button", { type: "button", className: "chip", onclick: () => w.addFunds() }, w.faucet ? "Get test credit" : "Add funds"),
                    w.faucet ? ` Choose USDC on ${w.chain.name} and send it to ${w.address}.` : "");
                return;
            }
            status.textContent = "Paying…";
            keepPass(slug, await w.buyPass());
            status.textContent = "Done. Opening the data…";
            location.reload();
        } catch (e) { status.textContent = `No pass: ${e.message}`; } finally { buy.disabled = false; }
    };
    show(
        el("section", { className: "gate" },
            el("h2", { className: "page" }, name),
            el("p", {}, description),
            inside
                ? el("p", { className: "stats" }, el("strong", {}, inside.rows.toLocaleString()), " records",
                    inside.updated ? [" · updated ", el("time", { dateTime: inside.updated.toISOString() }, inside.updated.toLocaleDateString())] : null)
                : el("p", { className: "hint" }, "The data is being indexed for the first time; check back in a few minutes."),
            ...(inside?.about ?? []).slice(0, 2).map((t) => el("p", { className: "hint" }, t)),
            examples.length ? [el("h3", {}, "Ask it things like"), el("ul", { className: "asks" }, examples.map((q) => el("li", {}, q)))] : null,
            el("div", { className: "paid" },
                el("h3", {}, "Search it here"),
                el("p", { className: "detail" }, `A pass opens every record and the search by meaning on this page, and in your own agent, for ${access.days} days.`),
                buy, status, funds)),
        agentPanel({ el, origin, name, access, pass: null }));
}
