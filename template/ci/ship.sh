#!/usr/bin/env bash
# Portable CI: any runner (or a laptop) with node 22 and jq.
#   ci/ship.sh ship   claim on first run, commit the schema, build the site, deploy the Worker, bind the agent
#   ci/ship.sh eval   grade the live view against eval/golden.jsonl
# Env: ETH_PRIVATE_KEY, PINATA_JWT, PINATA_GATEWAY, CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID
set -euo pipefail
cd "$(dirname "$0")/.."
export FANGORN_IPFS_GATEWAY="${FANGORN_IPFS_GATEWAY:-${PINATA_GATEWAY:-}}"   # westmarch reads this name, not PINATA_GATEWAY

grep -q '"app": "my-app"' app.json && { echo "edit app.json first: app, name, description, site.project, the type" >&2; exit 1; }
[ -d node_modules ] || npm ci
# ship signs with the fangorn CLI, which must be the SDK version westmarch reads with
command -v fangorn >/dev/null || npm i -g "@fangorn-network/sdk@$(node -p 'require("@fangorn-network/sdk/package.json").version')"

case "${1:-}" in
  ship) npx westmarch-ship app.json ;;
  eval)
    [ -s eval/golden.jsonl ] || { echo "no golden queries in eval/golden.jsonl yet: nothing to grade"; exit 0; }
    npx westmarch-eval "$(jq -r .url .ship/state.json)/view" ;;
  *) echo "usage: ci/ship.sh ship|eval" >&2; exit 2 ;;
esac
