// An app's committed data → a view any Fangorn reader loads: the free, local tier.
//
//   westmarch-view --app my-app --namespace my-app --out site/view
//
// Reads the chain and nothing else: each publisher's commits to `namespaces`, and
// the app owner's schema (`fangorn.schema`, see below). Embeds only records the view
// does not hold yet, marks removed ones as tombstones, and writes static files:
//
//   <out>/cdn/catalog
//   <out>/cdn/domains/<domain>/manifest
//   <out>/cdn/domains/<domain>/shards/shard-NNNN-<sha12>.ndjson.gz
//
// Stateless: the view's own files are its state, so it runs from a laptop, CI or an
// agent, and a second run with nothing new on chain changes nothing.
//
// THE SAME CONTRACT AS QUICKBEAM (the hosted tier), so an app moves between the two by
// changing one URL in its card:
//   - URL layout, domain names (`domainFor`, byte-identical to quickbeam's
//     `_domain_for` and the registry's `domainFor`), row shape {track_id, fields, v},
//     manifest and catalog keys;
//   - a record is a vertex: track_id = its CID, fields = payload + entityType (its tag);
//   - the schema: a declared type is embedded and shipped with exactly its role map;
//   - the embedded text (`composeText` mirrors quickbeam's `compose_document_text`).
// What differs is the encoder: transformers.js q8 here, fastembed fp32 there. Their
// vectors agree to ~0.95 cosine, close but not interchangeable, so the manifest names
// its `embedder` and this refuses to append to a view another encoder built.
//
// ponytail: flat records. quickbeam folds a record's graph neighbours into its text
// and can fuse publishers by shared identity; that is the hosted tier's job. Edges
// are not shipped here either (quickbeam's edges.json) until a reader needs them.

import { gunzipSync, gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { EMBED_DIM, EMBED_MODEL, embedDocumentDirect, packVec, unpackVec } from "../consume/embed.js";
import { coverage as fitCoverage } from "./reactions.js";

export const SCHEMA_NAMESPACE = "fangorn.schema";
export const TYPE_TAG = "fangorn.type.v1";
export const EMBEDDER = { runtime: "transformers.js", model: EMBED_MODEL, dtype: "q8" };
const SINGULAR = ["identity", "title", "subtitle", "temporal", "spatial", "media"];
const MULTI = ["tags", "measures", "relations", "text"];
const ZERO = "0x0000000000000000000000000000000000000000";
// Refit coverage once a domain has grown this many times over what it was fit on.
const COVERAGE_REFIT = 2;

// ── the contract shared with quickbeam ────────────────────────────────────────

const slug = (s) => (String(s ?? "").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "x");
/** quickbeam `_domain_for` / registry `domainFor`, for an app id. */
export const domainFor = (appId, owner, namespace) =>
    `${slug(appId.slice(2, 10))}-${slug(owner.slice(2, 10))}-${slug(namespace)}`;

/** quickbeam `compose_document_text`, minus the `search_document: ` prefix that
 *  `embedDocumentDirect` adds itself. */
export function composeText(fields, rm) {
    const tags = (rm.tags ?? []).map((t) => (typeof fields[t] === "string" ? fields[t] : "")).join(" ");
    const rels = Object.entries(fields)
        .filter(([k, v]) => Array.isArray(v) && v.length && k !== "entityType")
        .map(([k, v]) => `${k}: ${v.slice(0, 20).filter((x) => x).map(String).join(", ")}`).join("; ");
    const subtitle = fields[rm.subtitle ?? ""] ?? "";
    const text = (rm.text ?? []).filter((t) => fields[t]).map((t) => String(fields[t])).join("; ");
    let s = `Title: ${fields[rm.title ?? ""] ?? ""}. Tags: ${tags}`;
    if (subtitle) s += `. Subtitle: ${subtitle}`;
    if (text) s += `. ${text}`;
    if (rels) s += `. ${rels}`;
    return s.slice(0, 1000 - "search_document: ".length);
}

/** `fangorn.schema` contents → { types: {tag: {description, role_map, presentation}}, relations }. */
export function parseSchema(contents) {
    const types = {}, tagOf = {};
    for (const v of contents?.vertices ?? []) {
        const p = v.payload ?? {};
        if (v.schemaId !== TYPE_TAG || typeof p.tag !== "string") continue;
        types[p.tag] = { description: String(p.description ?? ""), role_map: p.role_map ?? {}, presentation: p.presentation ?? {} };
        tagOf[v.cid] = p.tag;
    }
    const relations = (contents?.edges ?? []).filter((e) => tagOf[e.sourceCid] && tagOf[e.targetCid])
        .map((e) => ({ rel: e.relation, from: tagOf[e.sourceCid], to: tagOf[e.targetCid] }));
    return { types, relations };
}

/** Declared means declared: every role present, left-out ones empty. */
export function completeRoles(rm = {}) {
    const out = {};
    for (const r of SINGULAR) out[r] = rm[r] ?? null;
    for (const r of MULTI) out[r] = rm[r] == null ? [] : [rm[r]].flat();
    return out;
}

// ponytail: for a type the schema does not declare, a guess from field names and
// value lengths — enough to show and search something, and loud about it. quickbeam's
// `infer_roles` is richer; the fix either way is declaring the type.
export function guessRoles(rows) {
    const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((k) => k !== "entityType");
    const find = (names) => keys.find((k) => names.includes(k.toLowerCase())) ?? null;
    const avgLen = (k) => rows.reduce((s, r) => s + (typeof r[k] === "string" ? r[k].length : 0), 0) / (rows.length || 1);
    return completeRoles({
        identity: find(["id", "uid", "key", "slug"]),
        title: find(["title", "name", "label", "headline"]),
        text: keys.filter((k) => avgLen(k) >= 80),
        tags: keys.filter((k) => ["tags", "category", "categories", "genre", "genres", "topics"].includes(k.toLowerCase())),
    });
}

/** Merge the declared types a domain holds (most common first), like quickbeam's `domain_spec`. */
export function domainSpec(schema, tags) {
    const decls = tags.map((t) => schema?.types?.[t]).filter(Boolean);
    if (!decls.length) return null;
    const role_map = {};
    for (const d of decls) {
        const c = completeRoles(d.role_map);
        for (const r of SINGULAR) role_map[r] ??= c[r];
        for (const r of MULTI) role_map[r] = [...new Set([...(role_map[r] ?? []), ...c[r]])];
    }
    const presentation = {};
    for (const d of decls) for (const [k, v] of Object.entries(d.presentation ?? {}))
        presentation[k] = v && typeof v === "object" && !Array.isArray(v) ? { ...presentation[k], ...v } : v;
    return { description: decls.map((d) => d.description).filter(Boolean).join(" "), role_map, presentation };
}

// ── a client that only reads ──────────────────────────────────────────────────

/** An SDK client for reading commits: a throwaway key (nothing signs) and no upload
 *  credentials. Contents come through an IPFS gateway: FANGORN_IPFS_GATEWAY, else the one
 *  in ~/.fangorn/config.json (what the fangorn CLI reads through), else the SDK default.
 *  ponytail: the SDK's default is ipfs.io, which no longer serves raw blocks, so on a
 *  machine with neither setting reads fail; set FANGORN_IPFS_GATEWAY. */
export async function readOnlyFangorn() {
    const [{ Fangorn, FangornConfig }, { generatePrivateKey }, { homedir }] = await Promise.all([
        import("@fangorn-network/sdk"), import("viem/accounts"), import("node:os")]);
    let gateway = process.env.FANGORN_IPFS_GATEWAY ?? process.env.IPFS_GATEWAY;
    try { gateway ??= JSON.parse(readFileSync(`${homedir()}/.fangorn/config.json`, "utf8")).pinataGateway || undefined; } catch { /* no CLI config */ }
    if (gateway && !/^https?:\/\//.test(gateway)) gateway = `https://${gateway}`;
    return Fangorn.create({ privateKey: generatePrivateKey(), config: FangornConfig,
        storage: { signedUrl: gateway ? { gateway } : {} } });
}

/** What publishView reads, served from memory instead of the chain: `chain` maps
 *  `<owner>/<namespace>` to namespace contents ({ vertices: [{cid, schemaId, payload}],
 *  edges }). A build that must not touch the chain — a candidate recipe graded before it
 *  ships — runs the exact code a real one does. */
export function localFangorn(chain, { appId, owner }) {
    return {
        setAppId() {}, getAppId: () => appId,
        getAppRegistry: () => ({ getAppOwner: async () => owner }),
        appNamespaces: async ({ namespace }) => Object.keys(chain).filter((k) => k.endsWith(`/${namespace}`)).map((k) => ({ owner: k.split("/")[0] })),
        readNamespace: async (o, ns) => { const c = chain[`${o}/${ns}`]; if (!c) throw new Error("no such namespace"); return { contents: c }; },
    };
}

/** `embed`, remembered on disk by the exact text embedded (and the encoder). Two builds
 *  of the same data under different recipes then only pay for the text that differs.
 *  One ndjson file of packed vectors; packVec's fixed 1/127 scale makes the round trip exact.
 *  ponytail: the whole file is held in memory, ~400 bytes a record; shard it past a few million. */
export function cachedEmbed(path, embed = embedDocumentDirect) {
    const seen = new Map();
    // A build killed mid-write leaves half a line; that one vector is embedded again, nothing else is lost.
    if (existsSync(path)) for (const l of readFileSync(path, "utf8").split("\n")) { try { const [k, v] = JSON.parse(l); seen.set(k, v); } catch { /* blank or cut short */ } }
    const salt = JSON.stringify(EMBEDDER);
    const fn = async (text) => {
        const k = createHash("sha256").update(`${salt}\n${text}`).digest("hex");
        let v = seen.get(k);
        if (!v) { v = packVec(await embed(text)); seen.set(k, v); appendFileSync(path, `${JSON.stringify([k, v])}\n`); fn.misses++; }
        return unpackVec(v);
    };
    fn.misses = 0;
    return fn;
}

// ── the view on disk ──────────────────────────────────────────────────────────

const readJson = (p, dflt) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : dflt);
const writeJson = (p, o) => { writeFileSync(`${p}.tmp`, JSON.stringify(o, null, 1)); renameSync(`${p}.tmp`, p); };

/** What a domain already serves: its manifest and every row (for tombstones and coverage). */
function loadDomain(dir) {
    const manifest = readJson(`${dir}/manifest`, null);
    const rows = new Map();
    for (const s of manifest?.shards ?? []) {
        const text = gunzipSync(readFileSync(`${dir}/shards/${s.file}`)).toString("utf8");
        for (const line of text.split("\n")) if (line.trim()) { const r = JSON.parse(line); rows.set(r.track_id, r); }
    }
    return { manifest, rows };
}

/** Every live row's fields, across the view at `out`. */
export function liveFields(out) {
    const root = `${out}/cdn/domains`;
    if (!existsSync(root)) return [];
    return readdirSync(root).flatMap((d) => {
        const { manifest, rows } = loadDomain(`${root}/${d}`);
        const dead = new Set(manifest?.tombstones ?? []);
        return [...rows.values()].filter((r) => !dead.has(r.track_id)).map((r) => r.fields ?? {});
    });
}

/**
 * Bring `out` up to date with the chain. `fangorn` is an SDK client (reads only).
 * Returns per-domain counts of what changed.
 */
export async function publishView({ fangorn, app, namespaces, out, fromBlock = 0n, rebake = false,
                                    embed = embedDocumentDirect, log = console.log, shardRows = 20000 }) {
    if (!namespaces?.length) throw new Error("publishView: name the data namespace(s) to publish");
    fangorn.setAppId(app);
    const appId = fangorn.getAppId();
    const owner = (await fangorn.getAppRegistry().getAppOwner()).toLowerCase();
    let schema = { types: {}, relations: [] };
    if (owner === ZERO) log(`app ${app} is unclaimed, so it has no schema; every type will be guessed`);
    else {
        try { schema = parseSchema((await fangorn.readNamespace(owner, SCHEMA_NAMESPACE)).contents); }
        catch (e) { log(`schema: none read (${e.message}); every type will be guessed`); }
    }
    const declared = Object.keys(schema.types);
    log(`schema: ${declared.length ? declared.join(", ") : "no declared types"}`);

    const report = {};
    for (const ns of namespaces.filter((n) => n !== SCHEMA_NAMESPACE)) {
        const timelines = await fangorn.appNamespaces({ namespace: ns, fromBlock: BigInt(fromBlock) });
        log(`${ns}: ${timelines.length} publisher(s) since block ${fromBlock}`);
        for (const { owner: publisher } of timelines) {
            const domain = domainFor(appId, publisher, ns);
            report[domain] = await publishDomain({
                fangorn, schema, publisher, ns, domain, dir: `${out}/cdn/domains/${domain}`, rebake, embed, log, shardRows,
            });
        }
    }
    writeCatalog(out);
    return report;
}

async function publishDomain({ fangorn, schema, publisher, ns, domain, dir, rebake, embed, log, shardRows }) {
    const { contents } = await fangorn.readNamespace(publisher, ns);
    const records = new Map((contents.vertices ?? []).filter((v) => v.payload && typeof v.payload === "object")
        .map((v) => [v.cid, { ...v.payload, entityType: v.schemaId }]));

    if (rebake) rmSync(dir, { recursive: true, force: true });   // old shards would stay reachable
    const had = loadDomain(dir);
    const made = had.manifest?.embedder ?? (had.manifest ? { runtime: "fastembed", dtype: "fp32" } : null);
    if (made && JSON.stringify(made) !== JSON.stringify(EMBEDDER))
        throw new Error(`${domain} was embedded by ${made.runtime} ${made.dtype}, not ${EMBEDDER.runtime} ${EMBEDDER.dtype}; ` +
            "vectors from two encoders are not comparable. Rebake it with --rebake, or keep publishing it with the tool that made it.");

    const dead = new Set(had.manifest?.tombstones ?? []);
    const live = (id) => had.rows.has(id) && !dead.has(id);
    const fresh = [...records.keys()].filter((id) => !live(id));
    const gone = [...had.rows.keys()].filter((id) => live(id) && !records.has(id));

    // Roles per type: declared exactly, else guessed (and said so).
    const byType = new Map();
    for (const id of fresh) { const t = records.get(id).entityType; byType.set(t, [...(byType.get(t) ?? []), id]); }
    const rolesOf = new Map();
    for (const [t, ids] of byType) {
        if (schema.types[t]) rolesOf.set(t, completeRoles(schema.types[t].role_map));
        else {
            rolesOf.set(t, guessRoles(ids.slice(0, 200).map((id) => records.get(id))));
            log(`${domain}: type ${t} is not in the schema; guessed title=${rolesOf.get(t).title} text=${rolesOf.get(t).text}`);
        }
    }

    let n = 0;
    const lines = [];
    for (const id of fresh) {
        const fields = records.get(id);
        const v = await embed(composeText(fields, rolesOf.get(fields.entityType)));
        lines.push(JSON.stringify({ track_id: id, fields, v: packVec(v) }));
        if (++n % 100 === 0) log(`${domain}: embedded ${n}/${fresh.length}`);
    }
    if (!fresh.length && !gone.length && had.manifest && !rebake) {
        applySpec(dir, had.manifest, schema, had.rows, dead);   // a schema change alone still lands
        return { added: 0, removed: 0 };
    }

    mkdirSync(`${dir}/shards`, { recursive: true });
    const manifest = had.manifest ?? { name: domain, description: "", count: 0, dim: EMBED_DIM, model: EMBED_MODEL,
        distance: "Cosine", embedder: EMBEDDER, filter: { owner: [publisher], namespace: [ns] }, shards: [], tombstones: [] };
    // Pages serves files up to 25 MiB; 52k Steam games gzipped to 28 MiB in one shard.
    // ponytail: split by row count (~550 B a row gzipped); split by bytes if rows get much fatter.
    const writeShard = (all) => {
        for (let i = 0; i < all.length; i += shardRows) {
            const ls = all.slice(i, i + shardRows);
            const gz = gzipSync(`${ls.join("\n")}\n`, { level: 9 });
            const sha256 = createHash("sha256").update(gz).digest("hex");
            const file = `shard-${String(manifest.shards.length).padStart(4, "0")}-${sha256.slice(0, 12)}.ndjson.gz`;
            writeFileSync(`${dir}/shards/${file}`, gz);
            manifest.shards.push({ file, count: ls.length, bytes: gz.length, sha256 });
        }
    };
    if (lines.length) {
        writeShard(lines);
        for (const l of lines) { const r = JSON.parse(l); had.rows.set(r.track_id, r); dead.delete(r.track_id); }
    }
    for (const id of gone) dead.add(id);
    // A tombstone hides a row from readers, but its shard still serves the bytes. A record
    // retracted for what it said (a name, an address) has to be gone, so any removal
    // rewrites the live rows into one shard and the old files are deleted. No re-embedding:
    // the vectors are already in the rows.
    // ponytail: rewrites the whole domain on every removal; compact past a threshold if domains get big.
    if (dead.size) {
        for (const s of manifest.shards) rmSync(`${dir}/shards/${s.file}`, { force: true });
        manifest.shards = [];
        for (const id of dead) had.rows.delete(id);
        dead.clear();
        writeShard([...had.rows.values()].map((r) => JSON.stringify(r)));
    }
    manifest.tombstones = [...dead].sort();
    manifest.created_at = Math.floor(Date.now() / 1000);
    applySpec(dir, manifest, schema, had.rows, dead, rolesOf);
    log(`${domain}: +${fresh.length} embedded, -${gone.length} removed, ${manifest.count} live`);
    return { added: fresh.length, removed: gone.length };
}

/** Counts, types, roles, description, presentation and coverage from what the domain now holds. */
function applySpec(dir, manifest, schema, rows, dead, guessed = new Map()) {
    const liveRows = [...rows.values()].filter((r) => !dead.has(r.track_id));
    const types = {};
    for (const r of liveRows) types[r.fields?.entityType] = (types[r.fields?.entityType] ?? 0) + 1;
    const tags = Object.entries(types).sort((a, b) => b[1] - a[1]).map(([t]) => t);
    const before = JSON.stringify(manifest);

    manifest.count = liveRows.length;
    manifest.entity_types = tags.map((t) => ({ type: t, count: types[t] }));
    const spec = domainSpec(schema, tags);
    const fields = [...new Set(liveRows.slice(0, 500).flatMap((r) => Object.keys(r.fields ?? {})))].sort();
    manifest.role_map = { ...(spec?.role_map ?? manifest.role_map ?? guessed.values().next().value ?? completeRoles()), fields };
    if (spec?.description) manifest.description = spec.description;
    if (spec && Object.keys(spec.presentation).length) manifest.presentation = spec.presentation;

    const cov = manifest.coverage;
    if (liveRows.length && (!cov || liveRows.length >= COVERAGE_REFIT * (cov.fit_at ?? 0))) {
        manifest.coverage = { ...fitCoverage(liveRows.map((r) => unpackVec(r.v))), fit_at: liveRows.length };
    }
    if (JSON.stringify(manifest) !== before || !existsSync(`${dir}/manifest`)) {
        mkdirSync(dir, { recursive: true });
        writeJson(`${dir}/manifest`, manifest);
    }
}

function writeCatalog(out) {
    const root = `${out}/cdn/domains`;
    mkdirSync(`${out}/cdn`, { recursive: true });
    const domains = existsSync(root) ? readdirSync(root).sort().map((d) => readJson(`${root}/${d}/manifest`, null)).filter(Boolean) : [];
    writeJson(`${out}/cdn/catalog`, {
        generated_at: Math.floor(Date.now() / 1000), embedding_model: EMBED_MODEL,
        domains: domains.map((m) => ({
            name: m.name, description: m.description, count: m.count, dim: m.dim,
            bytes: m.shards.reduce((s, x) => s + x.bytes, 0), shard_count: m.shards.length,
            entity_types: m.entity_types.map((e) => e.type), manifest: `${m.name}/manifest.json`,
            ...(m.coverage ? { coverage: m.coverage } : {}),
        })),
    });
}

// ── self-check: `node publish/view.js` — a fake chain, a fake embedder, the real reader ──
if (typeof process !== "undefined" && import.meta.url === `file://${process.argv[1]}` && process.argv[1].endsWith("/view.js")) {
    const { createServer } = await import("node:http");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { loadShard, configure } = await import("../consume/shard.js");
    const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); };
    const throws = async (f, re, m) => { try { await f(); } catch (e) { if (re.test(e.message)) return; throw e; } throw new Error(`must throw: ${m}`); };

    // quickbeam's own outputs, pinned: the contract, not an approximation of it.
    eq(domainFor(`0x${"7e1497af".padEnd(64, "0")}`, "0x55cf6bd2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "media"), "7e1497af-55cf6bd2-media", "domain name = quickbeam's");
    eq(composeText({ name: "Oak", family: "Fagaceae", description: "big", entityType: "t" },
                   completeRoles({ title: "name", tags: ["family"], text: ["description"] })),
       "Title: Oak. Tags: Fagaceae. big", "embedded text = quickbeam's compose_document_text");

    const APP = `0x${"ab".repeat(32)}`, OWNER = `0x${"11".repeat(20)}`, PUB = `0x${"22".repeat(20)}`;
    const TAG = "shop.item.v1";
    const chain = {
        [`${OWNER}/${SCHEMA_NAMESPACE}`]: { vertices: [{ cid: "t1", schemaId: TYPE_TAG, payload: {
            tag: TAG, description: "Things for a room.", role_map: { identity: "sku", title: "name", text: "about" },
            presentation: { externalUrl: { [TAG]: "https://shop.example/{sku}" } } } }], edges: [] },
        [`${PUB}/shop`]: { vertices: [
            { cid: "c1", schemaId: TAG, payload: { sku: "a1", name: "Oak table", about: "a solid oak dining table", price: 3 } },
            { cid: "c2", schemaId: TAG, payload: { sku: "b2", name: "Lamp", about: "brass reading lamp", price: 1 } },
            { cid: "c3", schemaId: "shop.note.v1", payload: { title: "Note", body: "an undeclared type, with a body long enough to count as its text field" } },
        ], edges: [] },
    };
    const fangorn = localFangorn(chain, { appId: APP, owner: OWNER });
    const embedded = [];
    const embed = async (t) => { embedded.push(t); const v = new Array(EMBED_DIM).fill(0); for (const w of t.split(/\W+/)) if (w) v[w.length % EMBED_DIM] += 1; const n = Math.hypot(...v) || 1; return v.map((x) => x / n); };
    const out = mkdtempSync(`${tmpdir()}/view-`);

    // The vector cache: a second ask for the same text never reaches the encoder, and reads back exactly.
    const cache = cachedEmbed(`${out}/vectors.ndjson`, embed);
    const v1 = await cache("Title: Oak"), again = cachedEmbed(`${out}/vectors.ndjson`, embed);
    eq([packVec(await again("Title: Oak")), again.misses, embedded.length], [packVec(v1), 0, 1], "a cached vector comes back from disk, unchanged");
    appendFileSync(`${out}/vectors.ndjson`, '["cut sho');
    eq(packVec(await cachedEmbed(`${out}/vectors.ndjson`, embed)("Title: Oak")), packVec(v1), "a line cut short by a kill is skipped, not fatal");
    embedded.length = 0; rmSync(`${out}/vectors.ndjson`);
    const run = () => publishView({ fangorn, app: APP, namespaces: ["shop"], out, embed, log: () => {} });

    const d = domainFor(APP, PUB, "shop");
    const split = mkdtempSync(`${tmpdir()}/view-`);
    await publishView({ fangorn, app: APP, namespaces: ["shop"], out: split, embed, log: () => {}, shardRows: 2 });
    m0: { const m = readJson(`${split}/cdn/domains/${d}/manifest`);
          eq([m.count, m.shards.map((s) => s.count)], [3, [2, 1]], "rows past shardRows go to the next shard (Pages caps a file at 25 MiB)"); }
    embedded.length = 0;
    eq((await run())[d], { added: 3, removed: 0 }, "first run embeds everything");
    if (!embedded.includes("Title: Oak table. Tags: . a solid oak dining table")) throw new Error(`declared roles compose the text: ${embedded}`);
    let m = readJson(`${out}/cdn/domains/${d}/manifest`);
    eq([m.role_map.identity, m.role_map.title, m.role_map.text, m.description], ["sku", "name", ["about"], "Things for a room."], "the schema is applied");
    eq(m.embedder, EMBEDDER, "the manifest names its encoder");

    eq((await run())[d], { added: 0, removed: 0 }, "nothing new on chain → nothing embedded");
    eq(embedded.length, 3, "and the embedder was not called");

    chain[`${PUB}/shop`].vertices = [chain[`${PUB}/shop`].vertices[0],
        { cid: "c2b", schemaId: TAG, payload: { sku: "b2", name: "Lamp", about: "brass reading lamp", price: 2 } }];
    eq((await run())[d], { added: 1, removed: 2 }, "a changed record is a new CID; removed ones are dropped");
    m = readJson(`${out}/cdn/domains/${d}/manifest`);
    eq([m.count, m.shards.length, m.tombstones, readdirSync(`${out}/cdn/domains/${d}/shards`).length], [2, 1, [], 1],
       "a removal compacts: the retracted rows' bytes are no longer served anywhere");
    if (embedded.length !== 4) throw new Error("compaction must not re-embed");
    chain[`${PUB}/shop`].vertices.push({ cid: "c4", schemaId: TAG, payload: { sku: "d4", name: "Rug", about: "wool rug" } });
    await run();
    chain[`${PUB}/shop`].vertices.pop();
    m = readJson(`${out}/cdn/domains/${d}/manifest`);
    eq([m.count, m.shards.length], [3, 2], "an addition alone is a delta shard");
    await run();
    m = readJson(`${out}/cdn/domains/${d}/manifest`);

    // The real reader over HTTP: digests checked, tombstones honoured, the publisher's id resolves.
    const srv = createServer((q, s) => { try { s.end(readFileSync(`${out}${decodeURIComponent(q.url)}`)); } catch { s.statusCode = 404; s.end(); } });
    await new Promise((ok) => srv.listen(0, ok));
    configure({ rowText: (f) => f.about ?? "" });
    const got = await loadShard(`http://127.0.0.1:${srv.address().port}`);
    srv.close();
    eq(got.map((r) => [r.id, r.price]).sort(), [["c1", 3], ["c2b", 2]], "readers see exactly the live records");
    const { getRow } = await import("../consume/tools.js");
    const { rolesFrom } = await import("../consume/roles.js");
    eq(getRow(got, "b2", rolesFrom([m]))?.id, "c2b", "get by the publisher's own id, not the CID");

    m.embedder = { runtime: "fastembed", dtype: "fp32" }; writeJson(`${out}/cdn/domains/${d}/manifest`, m);
    await throws(run, /not comparable/, "appending to another encoder's view");
    eq((await publishView({ fangorn, app: APP, namespaces: ["shop"], out, embed, rebake: true, log: () => {} }))[d],
       { added: 2, removed: 0 }, "--rebake starts the domain over");
    eq(readdirSync(`${out}/cdn/domains/${d}/shards`).length, 1, "and leaves no orphaned shards");
    rmSync(out, { recursive: true, force: true });
    console.log("view.js self-check ok — domain names and embedded text match quickbeam's, the schema is applied, a second run embeds nothing, additions ship as delta shards, removals compact the domain, the real reader sees exactly the live records by the publisher's id, and another encoder's view is refused");
}
