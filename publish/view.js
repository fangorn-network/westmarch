// Your rows → one view: the static files every Fangorn reader already reads.
//
//   <out>/cdn/catalog                        what the view holds, and its coverage sketch
//   <out>/cdn/domains/<name>/manifest        role_map, model, and each shard's sha256
//   <out>/cdn/domains/<name>/shards/shard-0000-<sha>.ndjson.gz
//
// Rows are plain objects from any source. `roleMap` says which field is what
// (identity, title, text, tags…), and the text roles are what gets embedded, with
// the same model and prefix the readers' query side uses (consume/embed.js).
// Serve `<out>` from any static host; the shard's name carries its digest, so it
// can be cached `immutable`.
//
// ponytail: one shard per view, built in memory. Fine to ~100k rows; split into
// shard-0001… (and stream the gzip) when a view outgrows that.

import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { EMBED_DIM, EMBED_MODEL, embedDocumentDirect, packVec } from "../consume/embed.js";
import { rolesFrom, textOf } from "../consume/roles.js";
import { coverage } from "./reactions.js";

/**
 * Bake `rows` into a view at `out`. `name` names the view's one domain (URL-safe).
 * `type` is what one row is ("Tree"), stamped as `entityType` on rows without
 * one; `presentation` is passed through to the manifest as is (icons, labels, and
 * `externalUrl: { Tree: "https://…/{id}" }`, where a hit links to: see lint.js). `owner` is the
 * publishing wallet, stamped on every row. `embed(text)` defaults to the
 * in-process model (131MB, downloaded once).
 */
export async function bakeView(rows, { out, name, description = "", type = name, roleMap, presentation, owner, embed = embedDocumentDirect, onProgress } = {}) {
    if (!out || !name) throw new Error("bakeView: pass out and name");
    if (!/^[\w.-]+$/.test(name)) throw new Error(`bakeView: name ${name} must be URL-safe`);
    if (!roleMap?.identity) throw new Error("bakeView: roleMap.identity must name each row's id field");
    if (!roleMap.text?.length) throw new Error("bakeView: roleMap.text must name the field(s) to search by meaning");
    rows = rows.map((r) => (r.entityType ? r : { entityType: type, ...r }));   // readers type a row by its own field
    const role_map = { ...roleMap, fields: [...new Set(rows.flatMap(Object.keys))].sort() };
    const roles = rolesFrom([{ role_map }]);

    const seen = new Set(), lines = [], vectors = [];
    for (const [i, r] of rows.entries()) {
        const id = r[roleMap.identity];
        if (id == null || id === "") throw new Error(`bakeView: row ${i} has no ${roleMap.identity}`);
        if (seen.has(String(id))) throw new Error(`bakeView: ${roleMap.identity} ${id} appears twice`);
        seen.add(String(id));
        const v = await embed(textOf(r, roles));
        vectors.push(v);
        lines.push(JSON.stringify({ track_id: String(id), ...(owner ? { owner: owner.toLowerCase() } : {}), v: packVec(v), fields: r }));
        onProgress?.(i + 1, rows.length);
    }

    const gz = gzipSync(`${lines.join("\n")}\n`, { level: 9 });
    const sha256 = createHash("sha256").update(gz).digest("hex");
    const file = `shard-0000-${sha256.slice(0, 12)}.ndjson.gz`;
    const count = rows.length, bytes = gz.length;
    // Cleared first: the old shard has a different name, and would stay reachable.
    rmSync(`${out}/cdn`, { recursive: true, force: true });
    mkdirSync(`${out}/cdn/domains/${name}/shards`, { recursive: true });
    writeFileSync(`${out}/cdn/domains/${name}/shards/${file}`, gz);
    writeFileSync(`${out}/cdn/domains/${name}/manifest`, JSON.stringify({
        name, description, count, dim: EMBED_DIM, model: EMBED_MODEL, distance: "Cosine",
        role_map, entity_types: [{ type, count }], ...(presentation ? { presentation } : {}),
        shards: [{ file, count, bytes, sha256 }], tombstones: [],
    }));
    writeFileSync(`${out}/cdn/catalog`, JSON.stringify({
        embedding_model: EMBED_MODEL,
        domains: [{ name, description, count, dim: EMBED_DIM, bytes, shard_count: 1, entity_types: [type], coverage: coverage(vectors) }],
    }));
    return { file, sha256, count, bytes };
}

// ── self-check: `node publish/view.js` — no model, a local server, the real reader ──
if (typeof process !== "undefined" && import.meta.url === `file://${process.argv[1]}` && process.argv[1].endsWith("/view.js")) {
    const { createServer } = await import("node:http");
    const { readFileSync, mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { loadShard, configure } = await import("../consume/shard.js");
    const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); };
    const throws = async (f, re, m) => { try { await f(); } catch (e) { if (re.test(e.message)) return; throw e; } throw new Error(`must throw: ${m}`); };

    // A fake embedder: one axis per word, so the vectors differ and are unit.
    const embed = (t) => { const v = new Array(EMBED_DIM).fill(0); for (const w of t.split(/\W+/)) if (w) v[w.length % EMBED_DIM] += 1; const n = Math.hypot(...v) || 1; return v.map((x) => x / n); };
    const rows = [
        { sku: "a1", name: "Oak table", about: "a solid oak dining table", tags: ["furniture"] },
        { sku: "b2", name: "Lamp", about: "brass reading lamp", tags: ["lighting"] },
    ];
    const roleMap = { identity: "sku", title: "name", text: ["about"], tags: ["tags"] };
    const out = mkdtempSync(`${tmpdir()}/view-`);
    const r = await bakeView(rows, { out, name: "shop", description: "Things for a room", type: "Item", roleMap, owner: "0xABC", embed,
                                     presentation: { externalUrl: { Item: "https://shop.example/{sku}" } } });

    const gz = readFileSync(`${out}/cdn/domains/shop/shards/${r.file}`);
    eq(createHash("sha256").update(gz).digest("hex"), r.sha256, "the file is named and manifested by its own digest");
    const cat = JSON.parse(readFileSync(`${out}/cdn/catalog`, "utf8"));
    eq(cat.domains[0].coverage.vectors.length, 2, "coverage is capped at the row count");
    eq(cat.domains[0].count, 2, "catalog counts the rows");

    // The real reader, over HTTP, checking the digest: what a stranger would get.
    const srv = createServer((q, s) => { try { s.end(readFileSync(`${out}${decodeURIComponent(q.url)}`)); } catch { s.statusCode = 404; s.end(); } });
    await new Promise((ok) => srv.listen(0, ok));
    configure({ rowText: (f) => f.about ?? "" });
    const got = await loadShard(`http://127.0.0.1:${srv.address().port}`);
    srv.close();
    eq(got.map((x) => [x.id, x.owner, x.name]), [["a1", "0xabc", "Oak table"], ["b2", "0xabc", "Lamp"]], "shard.js reads the rows back, owner lowercased");
    if (got[0].vector?.length !== EMBED_DIM) throw new Error("vectors survive the int8 round trip");
    const { rolesFrom: rf, linkOf } = await import("../consume/roles.js");
    const m = JSON.parse(readFileSync(`${out}/cdn/domains/shop/manifest`, "utf8"));
    eq(linkOf(got[1], rf([m])), "https://shop.example/b2", "type is stamped, so the presentation's link applies");

    await throws(() => bakeView([{ name: "x" }], { out, name: "shop", roleMap, embed }), /has no sku/, "a row without an id");
    await throws(() => bakeView([rows[0], rows[0]], { out, name: "shop", roleMap, embed }), /appears twice/, "duplicate ids");
    await throws(() => bakeView(rows, { out, name: "a/b", roleMap, embed }), /URL-safe/, "a name that breaks the path");
    rmSync(out, { recursive: true, force: true });
    console.log("view.js self-check ok — rows become catalog + manifest + digest-named shard, the real reader loads them over HTTP and verifies the digest, bad ids and names refused");
}
