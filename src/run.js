#!/usr/bin/env node
// The local runner: follows a config's repos into a SQLite index, live.
//
//   node src/run.js app.json [--once]
//
// app.json: { "publishers": ["0x…"], "repos": ["shop"], "db": "index.db", "network": "baseSepolia" }
// (optional: fromBlock, rpcUrl, gateway, deployment, view, publishView). Leave out "publishers" to follow those
// repos of every publisher. On each new root, the view (every record, the stitch, the gateway) goes to "view", a
// local file, and/or is published to Fangorn: to storage, with a `view` record in the "publishView" repo pointing
// at it, so a static page anywhere can find the latest one on chain.
// Env: INDEXER_KEY, RPC_URL, IPFS_GATEWAY.

import { readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { stitchFilter } from "@fangorn-network/sdk";
import { patternsOf, stitcher, watchHeads } from "./stitcher.js";
import { publishView } from "./view.js";
import { sqliteIndex } from "./sqlite.js";
import { localEmbedder } from "./embed.js";
import { client } from "./client.js";

/** Open the index, watch the heads, catch up. Returns `{ index, tick, stop }`. */
export async function run({ config, fangorn, embedder = localEmbedder(), path = config.db ?? "index.db", log = console.log }) {
    if (config.publishView && stitchFilter(patternsOf(config))(fangorn.getAddress(), config.publishView))
        throw new Error(`publishView "${config.publishView}" is a repo this index follows: each view would trigger the next`);
    const index = sqliteIndex({ path, fangorn, embedder });
    const s = stitcher(fangorn, config, { store: index.store, lens: index.lens });
    const count = index.db.prepare("SELECT count(*) AS n FROM records");
    let last, current = Promise.resolve();

    const tick = () => (current = s.trigger().then(async (root) => {
        if (root === last) return;
        log(`root ${root} (${count.get().n} records)`);
        if (config.view || config.publishView) {
            const { stitch } = await index.store.load();
            const view = { root, stitch, gateway: fangorn.getConfig().ipfsGateway, records: index.rows() };
            if (config.view) writeView(config.view, view);
            if (config.publishView) log(`view published: ${await publishView(fangorn, config.publishView, view)}`);
        }
        last = root; // only once the view is out: if publishing failed, the next event tries again
    }).catch((e) => log(`✗ ${e.message}`))); // the stitch stays where it was; the next event retries

    // Watch first, then catch up: an update landing in between still triggers a tick.
    const off = watchHeads(fangorn, config, tick, (e) => log(`✗ watch: ${e.message}`));
    await tick();
    return { index, tick, async stop() { off(); await current; index.close(); } };
}

/** Written whole, then renamed over the old one: a reader never sees half a file. */
// ponytail: a local file next to the page; publishing it to Fangorn (and pointing at it on chain) is next
function writeView(file, view) {
    writeFileSync(`${file}.tmp`, JSON.stringify(view));
    renameSync(`${file}.tmp`, file);
}

/** A config file, checked. */
export function readConfig(file) {
    const config = JSON.parse(readFileSync(file, "utf8"));
    for (const k of ["publishers", "repos"])
        if ((k === "repos" || k in config) && (!Array.isArray(config[k]) || !config[k].length)) throw new Error(`${file}: "${k}" must be a non-empty array`);
    return config;
}

export const isMain = (url) => process.argv[1] && url === pathToFileURL(realpathSync(process.argv[1])).href;

if (isMain(import.meta.url)) {
    const [file, ...flags] = process.argv.slice(2);
    if (!file) { console.error("usage: run.js app.json [--once]"); process.exit(2); }
    const config = readConfig(file);
    const runner = await run({ config, fangorn: client(config) });
    if (flags.includes("--once")) await runner.stop();
    else process.on("SIGINT", () => runner.stop().then(() => process.exit(0)));
}
