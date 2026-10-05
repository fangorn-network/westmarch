#!/usr/bin/env bash
#
# Publish westmarch, and — when asked — the shards it serves.
#
#   ./deploy.sh                        rebuild and deploy what is in public/
#   ./deploy.sh archive-films games    re-bake those domains from Qdrant first
#
# Shards are static files under public/<domain>/cdn, so "updating the data" and
# "deploying the site" are the same operation. Two properties make that cheap
# rather than reckless:
#
#   a shard's filename carries its own digest, so a re-bake writes a NEW file and
#   Cloudflare uploads only what actually changed;
#
#   and the domain's directory is emptied first, because it would otherwise
#   accumulate every shard ever baked — reachable, stale, and indistinguishable
#   from the current one to anyone who kept the URL.
#
# The lint runs LAST, against the deployed origin rather than the local files.
# What matters is whether the corpus a stranger can fetch is findable, complete
# and not leaking a paywalled field — and that is a property of what is served,
# not of what was built.
set -euo pipefail
cd "$(dirname "$0")"

ACCOUNT=0beaeb0776ca9e8404297afe0da73e5a       # Fangorn@fangorn.network
PROJECT=westmarch
SITE=https://westmarch-auc.pages.dev
QB=../../../embeddings                            # quickbeam: domains.json + the bake

for d in "$@"; do
    col=$(python3 -c "
import json,sys
ds = json.load(open('$QB/domains.json')); ds = ds.get('domains', ds)
sys.stdout.write(ds.get('$d', {}).get('collection', ''))
")
    if [ -z "$col" ]; then
        echo "deploy: '$d' is not in $QB/domains.json — nothing to re-bake." >&2
        echo "        known: $(python3 -c "
import json; ds=json.load(open('$QB/domains.json')); ds=ds.get('domains',ds); print(', '.join(ds))")" >&2
        exit 1
    fi
    echo "── re-baking $d from collection $col"
    out="$PWD/public/$d/cdn"
    rm -rf "$out"
    ( cd "$QB" && quickbeam cdn bake --config domains.json --collection "$col" --domain "$d" --cdn-dir "$out" )
done

npx vite build
CLOUDFLARE_ACCOUNT_ID=$ACCOUNT npx wrangler pages deploy dist \
    --project-name "$PROJECT" --branch main --commit-dirty=true

for d in public/*/; do
    d=$(basename "$d")
    echo "── lint $SITE/$d"
    node ../../src/publish/lint.js "$SITE/$d"
done
