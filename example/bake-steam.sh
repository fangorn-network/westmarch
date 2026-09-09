#!/usr/bin/env bash
#
# Bake the Steam corpus out of Qdrant and lay it out the way a consumer reads it.
#
# `quickbeam cdn bake` writes an OPERATOR layout — `catalog.json` at the top and
# `<domain>/manifest.json` beside the shard files. `consume/shard.js` fetches a
# SERVED layout: `cdn/catalog`, `cdn/domains/<domain>/manifest`, and the shards
# under `cdn/domains/<domain>/shards/`. `quickbeam cdn serve` maps between them
# at request time; a static host does not, so anything deployed as plain files
# has to be laid out on disk instead.
#
# That is all this script does after the bake: move three things and drop the
# `.json` extensions. It is separate from deploy.sh because deploy.sh bakes
# straight into `public/` and assumes the two layouts agree, which they do not
# for this quickbeam build — and silently disagreeing is a corpus that 404s on
# its own catalog.
#
#   ./bake-steam.sh                    → public/steam, ready for `pnpm dev`
#   ./bake-steam.sh /tmp/out           → somewhere else
set -euo pipefail
cd "$(dirname "$0")"

DOMAIN=steam
COLLECTION=games
QB=../../embeddings
OUT="${1:-$PWD/public/$DOMAIN}"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

echo "── baking '$DOMAIN' from Qdrant collection '$COLLECTION'"
( cd "$QB" && quickbeam cdn bake --config domains.json \
    --collection "$COLLECTION" --domain "$DOMAIN" --cdn-dir "$STAGE" )

echo "── laying out for static serving → $OUT"
# Emptied first: a shard's filename carries its own digest, so a re-bake writes a
# NEW file and the old one would otherwise stay reachable, stale, and
# indistinguishable from the current one to anyone holding the URL.
rm -rf "$OUT/cdn"
mkdir -p "$OUT/cdn/domains/$DOMAIN/shards"
cp "$STAGE/catalog.json"           "$OUT/cdn/catalog"
cp "$STAGE/$DOMAIN/manifest.json"  "$OUT/cdn/domains/$DOMAIN/manifest"
cp "$STAGE/$DOMAIN"/*.ndjson.gz    "$OUT/cdn/domains/$DOMAIN/shards/"

echo "── done"
du -sh "$OUT/cdn"
echo
echo "   pnpm dev, then:  http://localhost:5180/?sources=/$DOMAIN"
echo "   lint:            node ../consume/lint.js http://localhost:5180/$DOMAIN"
