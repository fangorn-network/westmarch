#!/usr/bin/env node
// The Fangorn app index, headless. One command per verb, JSON on stdout.
//
// WHY THERE IS NO MCP SERVER HERE
// -------------------------------
// An index that POINTS AT apps rather than hosting them needs no runtime of its
// own. Every verb below is a function `@fangorn/westmarch` already exports, and
// the agent's shell is the transport. Nobody has to stand up a server to be in
// the index — a publisher bakes a view, and that is the whole obligation.
//
// WHY THIS IS A PLUGIN AND NOT A PAGE
// -----------------------------------
// One thing here is not stateless: the taste kernel. It lives in
// ~/.fangorn/taste.json — on the filesystem, between the human and the agent —
// because it has to outlive any one app, any one tab and any one ORIGIN.
// localStorage cannot do that: a taste learned in fangorn.tv is invisible to the
// next app by construction, which is the whole reason apps keep rebuilding it.
// A file the agent can read is the shortest thing that carries it across.
//
// ponytail: a plaintext file, no wallet, no sync. `publish/vault.js` is the
// upgrade path — same object, sealed to a signature, kept in the graph — and it
// is worth doing the day the kernel needs to travel between machines, not now.
// ponytail: every command re-fetches its view. Fine at 917 rows, ~seconds at
// 42k; add a disk cache keyed by view URL when a big corpus makes it hurt.

import { homedir } from "node:os";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configure, domainManifests, loadShard, trimView } from "../../consume/shard.js";
import { findCorpora, sourcesFromRegistry } from "../../consume/directory.js";
import { linkOf, rolesFrom, textOf, titleOf } from "../../consume/roles.js";
import { exportTaste, recommend, taste } from "../../consume/taste.js";
import { EMBED_MODEL, embedQuery, packVec, unpackVec } from "../../consume/embed.js";
import { browse, describe, facet, getRow, neighbors, search } from "../../example/tools.js";

const HOME = process.env.FANGORN_HOME ?? join(homedir(), ".fangorn");
const TASTE = join(HOME, "taste.json");

// ── the kernel on disk ───────────────────────────────────────────────────────
const store = () => { try { return JSON.parse(readFileSync(TASTE, "utf8")); } catch { return { model: EMBED_MODEL, likes: [], dislikes: [] }; } };
const save = (s) => { mkdirSync(HOME, { recursive: true }); writeFileSync(TASTE, JSON.stringify(s, null, 1)); };
/** Picks are stored PACKED (base64 int8, the shard encoding) and unpacked here.
 *  Storing the picks rather than only the derived vector is what keeps the
 *  kernel correctable: you can read what it was built from and drop one. */
const picks = (l = []) => l.map((p) => ({ ...p, vector: unpackVec(p.v) })).filter((p) => p.vector);
const kernel = (s = store()) => taste(picks(s.likes), picks(s.dislikes));

// ── args ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const [cmd, ...rest] = argv;
const pos = rest.filter((a) => !a.startsWith("--"));
const flag = (n, d) => { const a = rest.find((x) => x.startsWith(`--${n}=`)); return a === undefined ? d : a.slice(n.length + 3); };
const num = (n, d) => { const v = flag(n); return v === undefined ? d : Number(v); };
const pairs = (s) => s ? Object.fromEntries(String(s).split(",").map((p) => p.split("=").map((x) => x.trim()))) : undefined;
const list = (s) => String(s ?? "").split(",").map((x) => x.trim()).filter(Boolean);
const out = (o) => console.log(JSON.stringify(o, null, 1));
const die = (m) => { console.error(m); process.exit(1); };

// ── a view, loaded ───────────────────────────────────────────────────────────
let roles = rolesFrom([], []);
async function load(view) {
    if (!view) die("need a view URL");
    const base = trimView(view);
    configure({
        resolveView: () => base,
        // Roles must be ready BEFORE the first row is parsed: rowText runs during
        // parsing, so deriving them afterwards leaves every row with empty text
        // and lexical search silently matching nothing.
        onManifests: (ms) => { roles = rolesFrom(ms); },
        rowText: (f) => textOf(f, roles),
    });
    const rows = await loadShard(base);
    roles = rolesFrom(domainManifests(), rows);
    let model = null;
    try { model = (await (await fetch(`${base}/cdn/catalog`)).json()).embedding_model ?? null; } catch { /* unranked, not fatal */ }
    return { rows, roles, base, model };
}

/** A query vector, or null with the reason. Never throws: every verb here
 *  degrades to lexical and SAYS so rather than returning confident nonsense. */
const qvOf = async (q) => { try { return { qv: await embedQuery(q), why: null }; } catch (e) { return { qv: null, why: e?.message ?? String(e) }; } };

/** The corpus and the kernel must share an embedding space or cosine between
 *  them is noise that still looks like a score. */
const mismatch = (model, s) => model && s.model && model !== s.model
    ? `taste was built with ${s.model}, this corpus is ${model} — scores would be noise` : null;

const sources = async () => {
    const f = flag("sources"); if (f) return list(f);
    const r = flag("registry"); if (r) return sourcesFromRegistry(r);
    if (process.env.FANGORN_SOURCES) return list(process.env.FANGORN_SOURCES);
    try { return JSON.parse(readFileSync(join(HOME, "sources.json"), "utf8")); } catch { return []; }
};

// ── verbs ────────────────────────────────────────────────────────────────────
switch (cmd) {

// WHICH app has this. Downloads no corpus — coverage centroids only, ~4KB each.
case "find": {
    const src = await sources();
    if (!src.length) die("no sources: pass --sources=a,b or --registry=<view>, or write ~/.fangorn/sources.json");
    out(await findCorpora(pos.join(" "), { sources: src, embed: embedQuery, model: EMBED_MODEL, limit: num("limit", 10) }));
    break;
}

case "describe": {
    const { rows, roles: r, model } = await load(pos[0]);
    out({
        ...describe(rows), model,
        shape: r.declared ? "declared" : "sniffed",
        title: r.title, subtitle: r.subtitle, tags: r.tags, text: r.text,
        entityTypes: r.entityTypes, gates: r.gates,
        // Where the reader goes next. The index's job ends here.
        launch: r.launch, externalUrl: r.externalUrl, actions: r.actions,
    });
    break;
}

case "browse": {
    const { rows, roles: r } = await load(pos[0]);
    out(browse(rows, r, { type: flag("type"), where: pairs(flag("where")), sort: flag("sort"),
                          desc: flag("asc") === undefined, limit: num("limit", 20), offset: num("offset", 0), fields: list(flag("fields")) }));
    break;
}

case "search": {
    const { rows, roles: r } = await load(pos[0]);
    const q = pos.slice(1).join(" ");
    const { qv, why } = await qvOf(q);
    out({ query: q, mode: qv ? "semantic where rows have vectors" : "lexical", ...(why ? { why } : {}),
          hits: search(rows, q, r, { qv, limit: num("limit", 10), where: pairs(flag("where")), fields: list(flag("fields")) }) });
    break;
}

case "facet": {
    const { rows } = await load(pos[0]);
    out(facet(rows, pos[1], { limit: num("limit", 20), where: pairs(flag("where")) }));
    break;
}

case "row": {
    const { rows, roles: r } = await load(pos[0]);
    const g = getRow(rows, pos[1], r);
    out(g ? { ...g, url: linkOf(rows.find((x) => x.id === g.id) ?? {}, r) } : null);
    break;
}

case "similar": {
    const { rows, roles: r } = await load(pos[0]);
    out(neighbors(rows, pos[1], r, { limit: num("limit", 10), fields: list(flag("fields")) }));
    break;
}

// ── the kernel ───────────────────────────────────────────────────────────────
case "like": case "dislike": {
    const { rows, roles: r, base, model } = await load(pos[0]);
    const s = store();
    const into = cmd === "like" ? s.likes : s.dislikes;
    const added = [];
    for (const id of pos.slice(1)) {
        const row = rows.find((x) => x.id === id);
        if (!row) { console.error(`no row ${id}`); continue; }
        if (!row.vector) { console.error(`${id} has no vector — nothing to learn from`); continue; }
        // Newest last: taste() weights by recency, so order in the file is signal.
        const at = into.findIndex((p) => p.id === id);
        if (at >= 0) into.splice(at, 1);
        into.push({ id, title: titleOf(row, r), view: base, at: new Date().toISOString().slice(0, 10), v: packVec(Array.from(row.vector)) });
        added.push(id);
    }
    s.model ??= model ?? EMBED_MODEL;
    save(s);
    const t = kernel(s);
    out({ added, likes: s.likes.length, dislikes: s.dislikes.length, taste: t && exportTaste(t), file: TASTE });
    break;
}

case "forget": {
    const s = store();
    const drop = new Set(pos);
    const before = s.likes.length + s.dislikes.length;
    s.likes = s.likes.filter((p) => !drop.has(p.id));
    s.dislikes = s.dislikes.filter((p) => !drop.has(p.id));
    save(s);
    out({ removed: before - s.likes.length - s.dislikes.length, likes: s.likes.length, dislikes: s.dislikes.length });
    break;
}

case "taste": {
    const s = store();
    const t = kernel(s);
    out(t ? { model: s.model, n: t.n, from: t.from, rejected: t.rejected, drift: t.drift,
              // Where each pick was learned. A kernel built in one publisher's
              // corpus is meant to be pointed at another's — this is the record
              // of whether it actually has been.
              views: [...new Set([...s.likes, ...s.dislikes].map((p) => p.view))],
              export: exportTaste(t), file: TASTE }
            : { n: 0, file: TASTE, note: "nothing liked yet — `fx like <view> <id>`" });
    break;
}

// The headline: rank a corpus by a taste learned somewhere else entirely.
case "recommend": {
    const { rows, roles: r, model } = await load(pos[0]);
    const s = store();
    const t = kernel(s);
    if (!t) die("no taste yet — `fx like <view> <id>` first");
    const warn = mismatch(model, s);
    if (warn) die(warn);
    const seen = new Set([...s.likes, ...s.dislikes].map((p) => p.id));
    out({ from: t.from, against: pos[0],
          hits: recommend(rows, t, { limit: num("limit", 10), exclude: seen })
              .map(({ row, score }) => ({ id: row.id, title: titleOf(row, r), score, url: linkOf(row, r) })) });
    break;
}

// ── the handoff. The index points; the app does the work. ────────────────────
case "launch": {
    const { rows, roles: r } = await load(pos[0]);
    const id = flag("row");
    if (id) {
        const row = rows.find((x) => x.id === id);
        if (!row) die(`no row ${id}`);
        out({ url: linkOf(row, r), title: titleOf(row, r) });
        break;
    }
    if (!r.launch) die("this corpus declares no presentation.launch — nowhere to hand off to");
    const t = kernel();
    const fill = { taste: t ? JSON.stringify(exportTaste(t)) : "", q: pos.slice(1).join(" ") };
    const url = String(r.launch).replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(fill[k] ?? ""));
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") die(`refusing a ${u.protocol} launch URL`);
    // The kernel travels in the URL because that is the only channel a page on
    // someone else's origin can receive it on. It is the app's copy from here.
    out({ url: u.toString(), carries: t ? { n: t.n, from: t.from } : null });
    break;
}

default:
    console.log(`fx <verb>

  find <query> [--sources=a,b|--registry=<view>]   which app has this. No corpus downloaded.
  describe <view>                                  rows, field coverage, roles, where it hands off
  browse <view> [--type= --where=k=v --sort= --asc --limit= --offset=]
  search <view> <query> [--where=k=v --limit=]     semantic where rows have vectors, else lexical
  facet <view> <field> [--where=k=v --limit=]      count a field's values
  row <view> <id>                                  one record, whole
  similar <view> <id> [--limit=]                   nearest by vector

  like|dislike <view> <id...>                      teach the kernel. Writes ${TASTE}
  forget <id...>                                   drop picks from it
  taste                                            what it is, and what it was built from
  recommend <view> [--limit=]                      rank ANY corpus by it

  launch <view> [query] | launch <view> --row=<id> the handoff URL, carrying the kernel`);
}
