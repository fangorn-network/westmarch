#!/usr/bin/env bash
#
# Cut the next commit of the Steam corpus from whatever the crawl has reached.
#
# This is the versioned-graph argument as an actual command. A Game's node id is
# `steam:app:<appid>` and the game stems are snapshots, so re-publishing the same
# appid REPLACES its vertex rather than appending a second one. `fangorn commit`
# diffs against the local tip, so the commit carries only the rows whose fields
# actually changed, and the running `quickbeam watch` re-embeds only those.
#
# Run it as often as you like. The first pass published thin rows — a name and a
# developer — because the crawl had barely started; `src/publish/lint.js` said so in
# as many words ("the text role is the title"). Every later run trades some of
# those for real prose, at the cost of re-embedding only what moved.
#
#   ./deepen-steam.sh          publish, wait for the embed, re-bake
#   ./deepen-steam.sh --no-bake   publish and embed only
set -euo pipefail
cd "$(dirname "$0")"

PUB=../../../quickbeam-publisher
APP=games.test.0
NS=games
OWNER=0x7a7849231cF7Ab1EA003BcF0063CB89704D7Cce9
LIMIT=20000

cd "$PUB"
# shellcheck disable=SC1091
source venv/bin/activate

spy=$(wc -l < steam-cache/spy.ndjson 2>/dev/null || echo 0)
store=$(wc -l < steam-cache/store.ndjson 2>/dev/null || echo 0)
echo "── crawl has $spy games with tags, $store with prose (of $LIMIT)"

before=$(curl -s --max-time 8 http://localhost:6333/collections/$NS \
    | grep -oE '"points_count":[0-9]+' | cut -d: -f2)
echo "── qdrant holds $before points before this commit"

echo "── staging and publishing"
python qb_sources/steam.py --require roster --limit "$LIMIT" \
    --output-dir steam-repo/stage_volumes \
    --publish --namespace "$NS" \
    --fangorn-bin "fangorn --app $APP"

# The watcher is subscribed to pushes, so it starts on its own. What it does NOT
# do is tell us when it is finished, and baking mid-embed would ship a shard with
# half the corpus at the old text. So: wait for the point count to stop moving.
echo "── waiting for the watcher to embed the diff (quiet for 3 min = done)"
last=-1; quiet=0
while [ "$quiet" -lt 6 ]; do
    sleep 30
    n=$(curl -s --max-time 8 http://localhost:6333/collections/$NS \
        | grep -oE '"points_count":[0-9]+' | cut -d: -f2)
    n=${n:-0}
    if [ "$n" = "$last" ]; then quiet=$((quiet + 1)); else quiet=0; echo "   $n points"; fi
    last=$n
done
echo "── embed settled at $last points"

if [ "${1:-}" != "--no-bake" ]; then
    cd - >/dev/null
    ./bake-steam.sh
    echo
    echo "── lint (the check that caught the thin text last time)"
    node ../../src/publish/lint.js http://127.0.0.1:8099/steam || true
fi
