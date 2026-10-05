// `npm test`: every module's own self-check, one after another, stopping at the first failure.
// A module is tested by running it (`node src/x/y.js`); the ones that are also CLIs take
// --selfcheck so a bare run does not start the real thing.
import { spawnSync } from "node:child_process";

const checks = [
    "src/market/terms.js", "src/market/reactions.js", "src/market/cohort.js", "src/taste/vault.js",
    "src/publish/graph.js", "src/publish/envelope.js", "src/market/demand.js", "src/market/settle.js",
    "src/publish/manifest.js", "src/agent/agent-card.js", "src/publish/view.js",
    "src/publish/ship.js --selfcheck", "src/publish/eval.ts --selfcheck", "src/publish/cli.js --selfcheck",
    "src/publish/enrich.js", "src/core/embed.js", "src/core/rank.js", "src/discover/apps.js",
    "src/discover/explore.js", "src/agent/mcp.js --selfcheck", "src/core/roles.js", "src/core/shard.js",
    "src/discover/directory.js", "src/taste/taste.js", "src/taste/steam.js", "src/taste/taste-doc.js",
    "src/discover/corpora.js", "src/agent/ui.js", "src/publish/lint.js", "src/agent/tools.js",
    "src/agent/x402.js", "site/feed.js", "site/store.js",
];
const only = process.argv.slice(2);
for (const c of checks) {
    if (only.length && !only.some((o) => c.includes(o))) continue;
    const r = spawnSync(process.execPath, c.split(" "), { stdio: "inherit" });
    if (r.status !== 0) { console.error(`\nFAILED: node ${c}`); process.exit(r.status ?? 1); }
}
