// taste.md against real catalogues, with no browser.
//
//   node doc-probe.mjs <view>[,<view>…]
//
// Builds a plausible reader out of rows the first catalogue actually holds —
// silent-era and animation in, daytime television out — and prints the document
// those choices produce. The point is not the fixture: it is that the words in
// the output are the publishers' own declared tags, so running this against a
// catalogue nobody has seen shows what that catalogue is able to say about a
// person before anyone writes a line of code for it.
import { configure, domainManifests, loadShard, resetShard, trimView } from "@fangorn/westmarch/shard";
import { rolesFrom, textOf, titleOf } from "@fangorn/westmarch/roles";
import { taste } from "@fangorn/westmarch/taste";
import { tasteDoc } from "@fangorn/westmarch/taste-doc";

const held = new Map();
configure({ onManifests: (ms, v) => held.set(v, rolesFrom(ms)), rowText: (f, v) => textOf(f, held.get(v) ?? { text: [] }) });
const catalogues = [];
for (const u of process.argv[2].split(",")) {
  const view = trimView(u);
  const rows = await loadShard(view);
  const roles = rolesFrom(domainManifests(view), rows);
  catalogues.push({ name: roles.name ?? view.split("/").pop(), rows, roles, view });
}
const films = catalogues[0];
// A reader who watches silent-era and animation, and bounces off wrestling.
const pick = (re, n) => films.rows.filter((r) => r.vector && re.test(JSON.stringify([r.subject, r.desc, r.year]))).slice(0, n);
const likes = pick(/silent|1920|1926|1927|animation|cartoon/i, 7).map((r) => ({ id: r.id, title: titleOf(r, films.roles), vector: r.vector }));
const nos   = pick(/wrestling|infomercial|televangel/i, 3).map((r) => ({ id: r.id, title: titleOf(r, films.roles), vector: r.vector }));
console.error(`built from ${likes.length} likes / ${nos.length} rejections across ${catalogues.map(c=>`${c.name}(${c.rows.length})`).join(" ")}`);
console.log(tasteDoc({ t: taste(likes, nos), catalogues, instructions: "Nothing over 90 minutes on a weeknight. I will always take a bad print of something rare over a clean print of something I have seen." }));
