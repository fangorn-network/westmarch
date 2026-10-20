#!/usr/bin/env node
// westmarch-view: publish what an app presents as a view (see view.js).
//
//   westmarch-view --app my-app --out site/view [--repo catalog …] [--from-block N] [--rebake]
//
// Reads only; needs no key. Deploy <out> with the site, and put its URL in the card's
// `views`. An app on the free tier needs none of this: its Worker runs the same code on a
// cron (site/worker.js).

import { homedir } from "node:os";

const flags = { repo: [] };
for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (!m) { console.error(`unexpected argument: ${a}`); process.exit(2); }
    const v = m[2] ?? (["rebake", "help"].includes(m[1]) ? true : process.argv[++i]);
    if (m[1] === "repo") flags.repo.push(v); else flags[m[1]] = v;
}
if (flags.help || !flags.app || !flags.out) {
    console.error("usage: westmarch-view --app <name|0xid> --out <dir> [--repo <name> …] [--from-block N] [--rebake]");
    process.exit(flags.help ? 0 : 2);
}

const [{ env }, { publishView, readOnlyFangorn }] = await Promise.all([
    import("@huggingface/transformers"), import("./view.js"),
]);
// Shared with fangorn-mcp, so a machine downloads the model once.
env.cacheDir = `${homedir()}/.cache/fangorn-mcp/models`;
const fangorn = await readOnlyFangorn();

const t0 = Date.now();
const report = await publishView({
    fangorn, app: flags.app, repos: flags.repo, out: flags.out,
    fromBlock: flags["from-block"], rebake: !!flags.rebake,
    log: (s) => console.error(s),
});
const sum = Object.values(report).reduce((a, r) => ({ added: a.added + r.added, removed: a.removed + r.removed }), { added: 0, removed: 0 });
console.error(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s: ${Object.keys(report).length} domain(s) changed, +${sum.added} -${sum.removed}`);
console.log(JSON.stringify(report));
