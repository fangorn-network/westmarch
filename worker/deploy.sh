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
# ponytail: a new app catches up over the update log from CONFIG.fromBlock (the network's deploy block by default)
# in its first run. Following repos with a long history may need more requests than one run gets: seed it first
# (README, worker/seed.js).
set -euo pipefail
name=${1:?usage: deploy.sh <name> <config.json>}
config=$(realpath "${2:?usage: deploy.sh <name> <config.json>}")
here=$(cd "$(dirname "$0")/.." && pwd)
cd "$here" # node and npx resolve viem, the SDK and wrangler from here
wrangler() { npx -y wrangler@4 "$@"; }
dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT

uuid() { wrangler d1 info "$name" --json 2>/dev/null | node -pe 'JSON.parse(require("fs").readFileSync(0)).uuid'; }
db=$(uuid) || { wrangler d1 create "$name" >/dev/null && db=$(uuid); }

node --input-type=module - "$name" "$db" "$config" "$here" >"$dir/wrangler.json" <<'EOF'
import { readFileSync } from "node:fs";
const [name, db, config, here] = process.argv.slice(2);
console.log(JSON.stringify({
    name, main: `${here}/worker/index.js`,
    compatibility_date: "2025-09-15", compatibility_flags: ["nodejs_compat"],
    d1_databases: [{ binding: "DB", database_name: name, database_id: db }],
    ai: { binding: "AI" },
    triggers: { crons: ["* * * * *"] },
    alias: { "@huggingface/transformers": `${here}/worker/no-model.js` },
    vars: { CONFIG: { name, ...JSON.parse(readFileSync(config, "utf8")) } },
}));
EOF

node --input-type=module -e 'import { SCHEMA } from "./src/d1.js"; console.log(SCHEMA)' >"$dir/schema.sql"
wrangler d1 execute "$name" --remote --file "$dir/schema.sql" --config "$dir/wrangler.json" >/dev/null
url=$(wrangler deploy --config "$dir/wrangler.json" | grep -o 'https://[^ ]*workers\.dev' | head -1)

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
