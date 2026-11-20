#!/usr/bin/env bash
# Deploy one app: a Worker, its D1 and its gas wallet, all named <name>. Run it again with a changed config to
# update the app: the database and the wallet are kept.
#
#   CLOUDFLARE_API_TOKEN=… [FUNDER_KEY=0x…] [FUND=0.002] worker/deploy.sh <name> <config.json>
#
# config.json is the Worker's CONFIG (see worker/index.js): { repos, network, publishers?, publishPerDay?, … }.
# From a westmarch checkout with its dependencies installed. Prints the app's URL; it answers /view.json once the
# first cron run (within a minute) has indexed it, and serves /mcp, /search and /publish.
#
# The wallet's key is generated here and goes straight into the Worker's secrets: it is never written down, and
# nobody holds it. It only pays gas for stitches and relayed publishes; with FUNDER_KEY set it gets FUND ether from it,
# otherwise fund the address printed.
# A new app is caught up here and its database seeded (worker/seed.js): one Worker run can't fold the whole log.
set -euo pipefail
name=${1:?usage: deploy.sh <name> <config.json>}
config=$(realpath "${2:?usage: deploy.sh <name> <config.json>}")
here=$(cd "$(dirname "$0")/.." && pwd)
cd "$here" # node and npx resolve viem, the SDK and wrangler from here
wrangler() { npx -y wrangler@4 "$@"; }
dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT
# The app's validation, from the CIDs in its config (worker/validator.js): schemas inlined into the config deployed, and
# its hooks built into its validator Worker, when it has any.
node worker/validator.js "$config" "$name" "$dir/v"
config="$dir/v/config.json"
# CONFIG reaches the Worker as a JSON module, not a var: a var is at most 5 KB, and instructions, schemas and the
# resolved checks pass that. The entry hands it to the Worker as env.CONFIG, so worker/index.js reads it as before.
node -e 'const [f, name] = process.argv.slice(1), fs = require("fs"); fs.writeFileSync(f, JSON.stringify({ name, ...JSON.parse(fs.readFileSync(f, "utf8")) }))' "$config" "$name"
cat >"$dir/v/entry.js" <<JS
import CONFIG from "./config.json";
import worker from "$here/worker/index.js";
const withConfig = (env) => ({ ...env, CONFIG });
export default { scheduled: (c, env, ctx) => worker.scheduled(c, withConfig(env), ctx), fetch: (req, env, ctx) => worker.fetch(req, withConfig(env), ctx) };
JS

uuid() { wrangler d1 info "$name" --json 2>/dev/null | node -pe 'JSON.parse(require("fs").readFileSync(0)).uuid'; }
db=$(uuid) || { wrangler d1 create "$name" >/dev/null && db=$(uuid); }

node --input-type=module - "$name" "$db" "$config" "$here" >"$dir/wrangler.json" <<'EOF'
import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
const [name, db, config, here] = process.argv.slice(2), cfg = JSON.parse(readFileSync(config, "utf8"));
console.log(JSON.stringify({
    name, main: `${dirname(config)}/entry.js`,
    compatibility_date: "2025-09-15", compatibility_flags: ["nodejs_compat"],
    d1_databases: [{ binding: "DB", database_name: name, database_id: db }],
    ai: { binding: "AI" },
    triggers: { crons: ["* * * * *"] },
    alias: { "@huggingface/transformers": `${here}/worker/no-model.js` },
    // The app's hooks: its own Worker, <name>-validator, deployed below (worker/validator.js).
    ...(existsSync(`${dirname(config)}/validator/wrangler.json`) && { services: [{ binding: "VALIDATOR", service: `${name}-validator` }] }),
}));
EOF

node --input-type=module -e 'import { SCHEMA } from "./src/d1.js"; import { SCHEMA as REPOS } from "./src/repos.js"; console.log(SCHEMA + REPOS)' >"$dir/schema.sql"
wrangler d1 execute "$name" --remote --file "$dir/schema.sql" --config "$dir/wrangler.json" >/dev/null
# A new database: catch up here and seed it, before the Worker's first run would try to (worker/seed.js).
stitched=$(wrangler d1 execute "$name" --remote --json --command "SELECT count(*) AS n FROM meta WHERE k = 'stitch'" \
    --config "$dir/wrangler.json" | node -pe 'JSON.parse(require("fs").readFileSync(0))[0].results[0].n')
# A repos index isn't seeded: its lens makes no reads, so the Worker's first run catches up itself.
if [ "$stitched" = 0 ] && [ "$(node -pe 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).index ?? ""' "$config")" != repos ]; then
    node worker/seed.js "$config" >"$dir/seed.sql"
    wrangler d1 execute "$name" --remote --file "$dir/seed.sql" --config "$dir/wrangler.json" >/dev/null
    echo "seeded $name: $(grep -c '^INSERT INTO records ' "$dir/seed.sql") records" >&2
fi
# The validator first, so the app's binding has something to bind to.
if [ -f "$dir/v/validator/wrangler.json" ]; then
    wrangler deploy --config "$dir/v/validator/wrangler.json" >/dev/null
    echo "validator $name-validator deployed" >&2
fi
# wrangler's output goes to stderr too, so a failure shows in the log. Retried once: right after a new Worker's upload,
# wrangler asks Cloudflare's newer API (/workers/workers/<name>) about it, which can answer "does not exist" (10007)
# for a few seconds; deploying again is safe and gets past it.
deploy() { wrangler deploy --config "$dir/wrangler.json" | tee /dev/stderr | grep -o 'https://[^ ]*workers\.dev' | head -1; }
url=$(deploy) || { echo "wrangler deploy failed; retrying once in 15s" >&2; sleep 15; url=$(deploy); }

if ! wrangler secret list --config "$dir/wrangler.json" | grep -q INDEXER_KEY; then
    key=$(node -e 'import("viem/accounts").then((m) => process.stdout.write(m.generatePrivateKey()))')
    addr=$(KEY=$key node -e 'import("viem/accounts").then((m) => process.stdout.write(m.privateKeyToAccount(process.env.KEY).address))')
    printf %s "$key" | wrangler secret put INDEXER_KEY --config "$dir/wrangler.json" >/dev/null
    unset key
    ADDR=$addr NETWORK=$(node -pe 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).network ?? "baseSepolia"' "$config") \
        node --input-type=module - <<'JS'
import { createWalletClient, http, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { SupportedNetworks } from "@fangorn-network/sdk";
const { ADDR, NETWORK, FUNDER_KEY, FUND = "0.002" } = process.env;
if (!FUNDER_KEY) { console.error(`gas wallet ${ADDR}: fund it on ${NETWORK}`); process.exit(0); }
const net = SupportedNetworks[NETWORK];
const wallet = createWalletClient({ account: privateKeyToAccount(FUNDER_KEY), chain: net.chain, transport: http(net.rpcUrl) });
console.error(`gas wallet ${ADDR} funded with ${FUND} on ${NETWORK}: ${await wallet.sendTransaction({ to: ADDR, value: parseEther(FUND) })}`);
JS
fi
echo "$url"
