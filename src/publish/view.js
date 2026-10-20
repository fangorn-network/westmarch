// An app's presented data → a view any Fangorn reader loads: the embedding lens
// (WHITEPAPER_1 §3.4), computed by whoever runs this.
//
//   westmarch-view --app my-app [--repo catalog …] --out site/view     (a laptop, CI)
//   site/worker.js, on a cron                                          (the free tier)
//
// Reads the registry and storage and nothing else: every repo the app presents (its
// members' repos, less its exclusions, `appRepos`), at their latest heads, and the app
// owner's schema (`fangorn.schema`, see below). Embeds only records the view does not hold
// yet, drops removed ones, and writes, through a store (a directory or an R2 bucket):
//
//   cdn/catalog
//   cdn/domains/<domain>/manifest
//   cdn/domains/<domain>/shards/shard-NNNN-<sha12>.ndjson.gz
//
// Stateless: the view's own files are its state, and each domain's manifest names the head
// it was built from, so a run where no head moved reads one manifest per repo and nothing
// else. A repo the app stops presenting (an exclusion) loses its domain on the next run.
//
// The layout is quickbeam's (the hosted tier), so an app moves between the two by changing
// one URL in its card:
//   - URL layout, domain names (`domainFor`, byte-identical to quickbeam's `_domain_for`),
//     row shape {track_id, fields, v}, manifest and catalog keys;
//   - a record is a row: track_id = its CID, fields = payload + entityType (its type);
//   - the schema: a declared type is embedded and shipped with exactly its role map;
//   - the embedded text (`composeText` mirrors quickbeam's `compose_document_text`).
// The encoder is EmbeddingGemma (embed.js). Two runtimes of it agree closely but not bit for
// bit, so the manifest names its `embedder` and this refuses to append to a view another
// encoder built.
//
// ponytail: flat records. quickbeam folds a record's neighbours into its text and can fuse
// publishers by shared identity; that is the hosted tier's job. A reference the schema
// declares is written onto its source row instead (`linkRelations`), which is all a
// serverless reader needs.

import { gunzipSync, gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { EMBED_DIM, EMBED_DTYPE, EMBED_MODEL, embedDocumentDirect, packVec, unpackVec } from "../core/embed.js";
import { coverage as fitCoverage } from "../market/reactions.js";

/** The app owner's repo that declares the app's types: one TYPE_TAG record per type, one
 *  RELATION_TAG record per allowed reference between two of them. */
export const SCHEMA_REPO = "fangorn.schema";
export const TYPE_TAG = "fangorn.type.v1";
export const RELATION_TAG = "fangorn.relation.v1";
export const EMBEDDER = { runtime: "transformers.js", model: EMBED_MODEL, dtype: EMBED_DTYPE };
const SINGULAR = ["identity", "title", "subtitle", "temporal", "spatial", "media", "thread"];
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

/** `fangorn.schema` records → { types: {tag: {description, role_map, presentation}}, relations }. */
export function parseSchema(contents) {
    const types = {}, relations = [];
    for (const r of contents?.records ?? []) {
        const p = r.payload ?? {};
        if (r.type === TYPE_TAG && typeof p.tag === "string")
            types[p.tag] = { description: String(p.description ?? ""), role_map: p.role_map ?? {}, presentation: p.presentation ?? {} };
        else if (r.type === RELATION_TAG && p.rel && p.from && p.to)
            relations.push({ rel: String(p.rel), from: String(p.from), to: String(p.to) });
    }
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

/**
 * Each declared relation, onto the row it starts from: an agenda item whose `part_of` is a
 * reference ({local: <record id>}) to a matter carries `part_of: <the matter's identity>`,
 * so a reader groups rows by it without resolving references. References the schema does not
 * declare are left as they are (the schema is the contract). `rows` maps CID → {id, fields}
 * and is changed in place.
 */
export function linkRelations(rows, schema) {
    const byId = new Map([...rows.values()].map((r) => [r.id, r.fields]));
    for (const { fields } of rows.values()) for (const rel of schema.relations) {
        const ref = fields[rel.rel];
        if (rel.from !== fields.entityType || typeof ref?.local !== "string") continue;
        const to = byId.get(ref.local);
        if (!to || to.entityType !== rel.to) continue;
        const id = schema.types[rel.to]?.role_map?.identity;
        fields[rel.rel] = String((id && to[id]) ?? ref.local);
    }
}

// ── a client that only reads ──────────────────────────────────────────────────

/** The SDK's deployment for a network name ("baseSepolia"): FANGORN_NETWORK, else its default. */
export async function network(name = process.env.FANGORN_NETWORK || "arbitrumSepolia") {
    const { SupportedNetworks } = await import("@fangorn-network/sdk");
    if (!SupportedNetworks[name]) throw new Error(`network ${name}: the SDK knows ${Object.keys(SupportedNetworks).join(", ")}`);
    return SupportedNetworks[name];
}

/** The IPFS gateway to read contents through: FANGORN_IPFS_GATEWAY, else the one in
 *  ~/.fangorn/config.json (what the fangorn CLI reads through), else none (the SDK default). */
export function ipfsGateway() {
    let gateway = process.env.FANGORN_IPFS_GATEWAY ?? process.env.IPFS_GATEWAY;
    try { gateway ??= JSON.parse(readFileSync(`${process.env.HOME}/.fangorn/config.json`, "utf8")).pinataGateway || undefined; } catch { /* no CLI config */ }
    return gateway && !/^https?:\/\//.test(gateway) ? `https://${gateway}` : gateway;
}

/** An SDK client for reading: a throwaway key (nothing signs) and no upload credentials,
 *  reading contents through `ipfsGateway()`. */
export async function readOnlyFangorn() {
    const [{ Fangorn }, { generatePrivateKey }] = await Promise.all([import("@fangorn-network/sdk"), import("viem/accounts")]);
    const FangornConfig = await network();
    const gateway = ipfsGateway();
    return Fangorn.create({ privateKey: generatePrivateKey(), config: FangornConfig,
        storage: { signedUrl: gateway ? { gateway } : {} } });
}

/** What publishView reads, served from memory instead of the chain: `chain` maps
 *  `<owner>/<repo>` to `{ records: [{id, cid, type, payload}] }`, every one presented.
 *  A build that must not touch the chain — a candidate recipe graded before it ships —
 *  runs the exact code a real one does. */
export function localFangorn(chain, { appId, owner }) {
    const root = (k) => `0x${createHash("sha256").update(JSON.stringify(chain[k])).digest("hex")}`;
    return {
        setAppId() {}, getAppId: () => appId,
        getAppRegistry: () => ({ getAppOwner: async () => owner }),
        appRepos: async () => Object.keys(chain).map((k) => ({ owner: k.split("/")[0], repo: k.split("/").slice(1).join("/"), root: root(k) })),
        readRepo: async (o, repo) => { const c = chain[`${o}/${repo}`]; return { tip: c ? root(`${o}/${repo}`) : null, contents: { records: c?.records ?? [] } }; },
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

// ── where the view lives ──────────────────────────────────────────────────────
//
// A store is four calls on paths relative to the view's root: get → bytes or null, put,
// del (a file, or everything under a folder), and list (a folder's immediate children).

/** A directory on disk. */
export function fsStore(out) {
    const at = (p) => `${out}/${p}`;
    return {
        get: async (p) => (existsSync(at(p)) ? readFileSync(at(p)) : null),
        put: async (p, b) => { mkdirSync(dirname(at(p)), { recursive: true }); writeFileSync(`${at(p)}.tmp`, b); renameSync(`${at(p)}.tmp`, at(p)); },
        del: async (p) => rmSync(at(p), { recursive: true, force: true }),
        list: async (p) => (existsSync(at(p)) ? readdirSync(at(p)) : []),
    };
}

/** An R2 bucket (a Worker's binding), under `prefix`. */
export function r2Store(bucket, prefix = "view/") {
    const keys = async (p, delimiter) => {
        const out = { objects: [], prefixes: [] };
        let cursor;
        do {
            const l = await bucket.list({ prefix: prefix + p, delimiter, cursor });
            out.objects.push(...l.objects.map((o) => o.key));
            out.prefixes.push(...(l.delimitedPrefixes ?? []));
            cursor = l.truncated ? l.cursor : undefined;
        } while (cursor);
        return out;
    };
    return {
        get: async (p) => { const o = await bucket.get(prefix + p); return o ? new Uint8Array(await o.arrayBuffer()) : null; },
        put: async (p, b) => { await bucket.put(prefix + p, b); },
        del: async (p) => {
            const all = [...(await keys(`${p}/`)).objects, ...((await bucket.head(prefix + p)) ? [prefix + p] : [])];
            for (let i = 0; i < all.length; i += 1000) await bucket.delete(all.slice(i, i + 1000));
        },
        list: async (p) => {
            const { objects, prefixes } = await keys(`${p}/`, "/");
            const base = prefix.length + p.length + 1;
            return [...objects.map((k) => k.slice(base)), ...prefixes.map((k) => k.slice(base, -1))];
        },
    };
}

const readJson = async (store, p, dflt) => { const b = await store.get(p); return b ? JSON.parse(new TextDecoder().decode(b)) : dflt; };
const writeJson = (store, p, o) => store.put(p, JSON.stringify(o, null, 1));

/** What a domain already serves: its manifest and every row (for tombstones and coverage). */
async function loadDomain(store, dir) {
    const manifest = await readJson(store, `${dir}/manifest`, null);
    const rows = new Map();
    for (const s of manifest?.shards ?? []) {
        const b = await store.get(`${dir}/shards/${s.file}`);
        if (!b) throw new Error(`${dir}: shard ${s.file} is named by its manifest and missing`);
        for (const line of gunzipSync(b).toString("utf8").split("\n")) if (line.trim()) { const r = JSON.parse(line); rows.set(r.track_id, r); }
    }
    return { manifest, rows };
}

/** Every live row's fields, across the view in `store` (or the directory `out`). */
export async function liveFields(store) {
    if (typeof store === "string") store = fsStore(store);
    const out = [];
    for (const d of await store.list("cdn/domains")) {
        const { manifest, rows } = await loadDomain(store, `cdn/domains/${d}`);
        const dead = new Set(manifest?.tombstones ?? []);
        for (const r of rows.values()) if (!dead.has(r.track_id)) out.push(r.fields ?? {});
    }
    return out;
}

const sha256 = (s) => createHash("sha256").update(s).digest("hex");

/**
 * Bring the view up to date with what the app presents. `fangorn` is an SDK client (reads
 * only); the view goes to `store`, or the directory `out`. `repos` narrows it to those repo
 * names (every publisher's); without it, every repo the app presents. `fromBlock` must be
 * at or before the first update to a repo the app presents, or a repo the scan misses is left out;
 * left out, the SDK's deployment start. `embedBatch(texts)` embeds many at once where the
 * encoder batches (a Worker's AI binding); `embedder` is what the manifest records.
 * `presented` replaces the `appRepos` scan with a list the caller keeps itself
 * ([{owner, repo, root}], exclusions already applied), as a Worker does across runs.
 * Returns per-domain counts of what changed.
 */
export async function publishView({ fangorn, app, repos, out, store = fsStore(out), fromBlock, presented, rebake = false,
                                    embed = embedDocumentDirect, embedBatch = (ts) => Promise.all(ts.map(embed)),
                                    embedder = EMBEDDER, log = console.log, shardRows = 20000, concurrency = 4 }) {
    fangorn.setAppId(app);
    const appId = fangorn.getAppId();
    const owner = (await fangorn.getAppRegistry().getAppOwner()).toLowerCase();
    let schema = { types: {}, relations: [] };
    if (owner === ZERO) log(`app ${app} is unclaimed, so it has no schema; every type will be guessed`);
    else {
        try { schema = parseSchema((await retry(() => fangorn.readRepo(owner, SCHEMA_REPO))).contents); }
        catch (e) { log(`schema: none read (${e.message}); every type will be guessed`); }
    }
    const declared = Object.keys(schema.types);
    log(`schema: ${declared.length ? declared.join(", ") : "no declared types"}`);
    const schemaHash = sha256(JSON.stringify(schema));

    // Every repo the app presents, at its accepted head: one log scan, exclusions applied.
    const listed = (presented ?? await retry(() => fangorn.appRepos(fromBlock == null ? {} : { fromBlock: BigInt(fromBlock) })))
        .filter((t) => t.repo !== SCHEMA_REPO && (!repos?.length || repos.includes(t.repo)));
    log(`${listed.length} repo(s) presented${repos?.length ? ` of ${repos.join(", ")}` : ""}`);

    const report = {};
    const live = new Set();
    // Several repos at once: reading one through an IPFS gateway is block by block and takes
    // far longer than embedding it. Each domain writes only its own folder.
    const queue = [...listed];
    const worker = async () => {
        for (let t; (t = queue.shift()) !== undefined;) {
            const domain = domainFor(appId, t.owner, t.repo);
            live.add(domain);
            // One repo failing (unreadable, the encoder out for the day) keeps its last view and
            // does not stop the others; the next run tries it again.
            const r = await publishDomain({ fangorn, store, schema, schemaHash, publisher: t.owner, repo: t.repo, head: t.root, domain,
                dir: `cdn/domains/${domain}`, rebake, embedBatch, embedder, log, shardRows })
                .catch((e) => { log(`${domain}: ✗ ${e.message}; left as it was`); return { added: 0, removed: 0, error: e.message }; });
            if (r) report[domain] = r;
        }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));

    // What the app no longer presents (excluded, or its publisher banned) is not served.
    for (const d of await store.list("cdn/domains")) {
        if (live.has(d)) continue;
        const m = await readJson(store, `cdn/domains/${d}/manifest`, null);
        const repo = m?.filter?.repo?.[0] ?? m?.filter?.namespace?.[0];
        if (repos?.length && !repos.includes(repo)) continue;
        await store.del(`cdn/domains/${d}`);
        report[d] = { added: 0, removed: m?.count ?? 0, dropped: true };
        log(`${d}: no longer presented by the app; dropped`);
    }
    await writeCatalog(store);
    return report;
}

/** A public RPC answers a burst with 429s: back off and try again, a few times. */
async function retry(f, tries = 6) {
    for (let i = 0; ; i++) {
        try { return await f(); } catch (e) {
            if (i >= tries - 1 || !/429|Too Many Requests|rate limit|timeout|ECONNRESET|fetch failed/i.test(String(e?.message ?? e))) throw e;
            await new Promise((ok) => setTimeout(ok, 2000 * 2 ** i));
        }
    }
}

async function publishDomain({ fangorn, store, schema, schemaHash, publisher, repo, head, domain, dir, rebake, embedBatch, embedder, log, shardRows }) {
    // The head the domain was built from, and the schema it was built under: neither moved,
    // nothing to read. This is what keeps a cron run with nothing new to one read per repo.
    const was = rebake ? null : await readJson(store, `${dir}/manifest`, null);
    if (was && was.head === head && was.schema_hash === schemaHash) return null;

    const { contents } = await retry(() => fangorn.readRepo(publisher, repo));
    const records = new Map(contents.records.filter((r) => r.payload && typeof r.payload === "object")
        .map((r) => [r.cid, { id: r.id, fields: { ...r.payload, entityType: r.type } }]));
    linkRelations(records, schema);
    const fieldsOf = (cid) => records.get(cid).fields;

    if (rebake) await store.del(dir);   // old shards would stay reachable
    const had = await loadDomain(store, dir);
    const made = had.manifest?.embedder ?? (had.manifest ? { runtime: "fastembed", dtype: "fp32" } : null);
    // Same model and dtype is the same encoder, whatever ran it: q8 on CPU, CUDA and WASM agree to
    // ~0.98-0.99 cosine, fp32 against q8 noticeably less.
    if (made && (made.model ?? "") + made.dtype !== embedder.model + embedder.dtype)
        throw new Error(`${domain} was embedded by ${made.runtime} ${made.model ?? ""} ${made.dtype}, not ${embedder.runtime} ${embedder.model} ${embedder.dtype}; ` +
            "vectors from two encoders are not comparable. Rebake it with --rebake, or keep publishing it with the tool that made it.");

    const dead = new Set(had.manifest?.tombstones ?? []);
    const live = (id) => had.rows.has(id) && !dead.has(id);
    const fresh = [...records.keys()].filter((id) => !live(id));
    const gone = [...had.rows.keys()].filter((id) => live(id) && !records.has(id));
    // A row already served whose links changed (its matter came later, or moved): new fields,
    // the same vector, so no embedding, only a rewrite.
    const relinked = [...had.rows.keys()].filter((id) => live(id) && records.has(id)
        && JSON.stringify(had.rows.get(id).fields) !== JSON.stringify(fieldsOf(id)));
    for (const id of relinked) had.rows.get(id).fields = fieldsOf(id);

    // Roles per type: declared exactly, else guessed (and said so).
    const byType = new Map();
    for (const id of fresh) { const t = fieldsOf(id).entityType; byType.set(t, [...(byType.get(t) ?? []), id]); }
    const rolesOf = new Map();
    for (const [t, ids] of byType) {
        if (schema.types[t]) rolesOf.set(t, completeRoles(schema.types[t].role_map));
        else {
            rolesOf.set(t, guessRoles(ids.slice(0, 200).map(fieldsOf)));
            log(`${domain}: type ${t} is not in the schema; guessed title=${rolesOf.get(t).title} text=${rolesOf.get(t).text}`);
        }
    }

    let n = 0, stopped = null;
    const lines = [];
    // 32 at a time: what an encoder batches (embed.js, a GPU, the Worker's AI binding).
    for (let i = 0; i < fresh.length; i += 32) {
        const ids = fresh.slice(i, i + 32);
        try {
            const vs = await embedBatch(ids.map((id) => composeText(fieldsOf(id), rolesOf.get(fieldsOf(id).entityType))));
            ids.forEach((id, j) => lines.push(JSON.stringify({ track_id: id, fields: fieldsOf(id), v: packVec(vs[j]) })));
        } catch (e) {
            // The encoder gave out (Workers AI's free daily allowance, say): keep what is embedded
            // and come back for the rest. Nothing served yet, nothing to save: fail as before.
            if (!lines.length) throw e;
            stopped = e;
            break;
        }
        if (Math.floor((n + ids.length) / 1000) > Math.floor(n / 1000)) log(`${domain}: embedded ${n + ids.length}/${fresh.length}`);
        n += ids.length;
    }
    const manifest = had.manifest ?? { name: domain, description: "", count: 0, dim: EMBED_DIM, model: EMBED_MODEL,
        distance: "Cosine", embedder, filter: { owner: [publisher], repo: [repo] }, shards: [], tombstones: [] };
    // Unfinished: the old head stays, so the next run sees a head to catch up to and embeds only what is missing.
    manifest.head = stopped ? (had.manifest?.head ?? null) : head;
    manifest.schema_hash = schemaHash;
    if (!fresh.length && !gone.length && !relinked.length && had.manifest && !rebake) {
        await applySpec(store, dir, manifest, schema, had.rows, dead);   // a schema change alone still lands
        return { added: 0, removed: 0 };
    }

    // Pages and R2 serve files of any size, but a reader holds a shard whole; 52k Steam games
    // gzipped to 28 MiB in one. ponytail: split by row count (~550 B a row gzipped).
    const writeShard = async (all) => {
        for (let i = 0; i < all.length; i += shardRows) {
            const ls = all.slice(i, i + shardRows);
            const gz = gzipSync(`${ls.join("\n")}\n`, { level: 9 });
            const digest = sha256(gz);
            const file = `shard-${String(manifest.shards.length).padStart(4, "0")}-${digest.slice(0, 12)}.ndjson.gz`;
            await store.put(`${dir}/shards/${file}`, gz);
            manifest.shards.push({ file, count: ls.length, bytes: gz.length, sha256: digest });
        }
    };
    if (stopped) {
        await writeShard(lines);
        for (const l of lines) { const r = JSON.parse(l); had.rows.set(r.track_id, r); dead.delete(r.track_id); }
        await applySpec(store, dir, manifest, schema, had.rows, dead, rolesOf);
        log(`${domain}: stopped at ${n}/${fresh.length} (${stopped.message}); the rest on the next run`);
        return { added: n, removed: 0, partial: true };
    }
    if (lines.length) {
        await writeShard(lines);
        for (const l of lines) { const r = JSON.parse(l); had.rows.set(r.track_id, r); dead.delete(r.track_id); }
    }
    for (const id of gone) dead.add(id);
    // A tombstone hides a row from readers, but its shard still serves the bytes. A record
    // retracted for what it said (a name, an address) has to be gone, so any removal (or a
    // relink, whose rows' fields changed) rewrites the live rows into one shard and the old
    // files are deleted. No re-embedding: the vectors are already in the rows.
    // ponytail: rewrites the whole domain on every removal; compact past a threshold if domains get big.
    if (dead.size || relinked.length) {
        for (const s of manifest.shards) await store.del(`${dir}/shards/${s.file}`);
        manifest.shards = [];
        for (const id of dead) had.rows.delete(id);
        dead.clear();
        await writeShard([...had.rows.values()].map((r) => JSON.stringify(r)));
    }
    manifest.tombstones = [...dead].sort();
    manifest.created_at = Math.floor(Date.now() / 1000);
    await applySpec(store, dir, manifest, schema, had.rows, dead, rolesOf);
    log(`${domain}: +${fresh.length} embedded, -${gone.length} removed, ${relinked.length} relinked, ${manifest.count} live`);
    return { added: fresh.length, removed: gone.length, ...(relinked.length ? { relinked: relinked.length } : {}) };
}

/** Counts, types, roles, description, presentation, coverage and the hosts its media role
 *  links to (what a Worker may show inline, see site/worker.js) from what the domain holds. */
async function applySpec(store, dir, manifest, schema, rows, dead, guessed = new Map()) {
    const liveRows = [...rows.values()].filter((r) => !dead.has(r.track_id));
    const types = {};
    for (const r of liveRows) types[r.fields?.entityType] = (types[r.fields?.entityType] ?? 0) + 1;
    const tags = Object.entries(types).sort((a, b) => b[1] - a[1]).map(([t]) => t);
    // Compare with what is stored, not with the manifest as it arrived: publishDomain has already
    // swapped shards and tombstones, and a one-for-one replacement changes nothing here, which left
    // the old manifest naming deleted shards.
    const before = JSON.stringify(await readJson(store, `${dir}/manifest`, null));

    manifest.count = liveRows.length;
    manifest.entity_types = tags.map((t) => ({ type: t, count: types[t] }));
    const spec = domainSpec(schema, tags);
    const fields = [...new Set(liveRows.slice(0, 500).flatMap((r) => Object.keys(r.fields ?? {})))].sort();
    manifest.role_map = { ...(spec?.role_map ?? manifest.role_map ?? guessed.values().next().value ?? completeRoles()), fields };
    if (spec?.description) manifest.description = spec.description;
    if (spec && Object.keys(spec.presentation).length) manifest.presentation = spec.presentation;
    const media = [manifest.role_map.media ?? []].flat();
    manifest.link_hosts = [...new Set(liveRows.flatMap((r) => media.map((m) => r.fields?.[m]))
        .filter((u) => typeof u === "string" && u.startsWith("https://"))
        .map((u) => { try { return new URL(u).hostname; } catch { return null; } }).filter(Boolean))].sort();

    const cov = manifest.coverage;
    if (liveRows.length && (!cov || liveRows.length >= COVERAGE_REFIT * (cov.fit_at ?? 0))) {
        manifest.coverage = { ...fitCoverage(liveRows.map((r) => unpackVec(r.v))), fit_at: liveRows.length };
    }
    if (JSON.stringify(manifest) !== before) await writeJson(store, `${dir}/manifest`, manifest);
}

/** The catalog: every domain's summary and coverage, the one file a reader routes on. */
export async function writeCatalog(store) {
    if (typeof store === "string") store = fsStore(store);
    const domains = (await Promise.all((await store.list("cdn/domains")).sort()
        .map((d) => readJson(store, `cdn/domains/${d}/manifest`, null)))).filter(Boolean);
    await writeJson(store, "cdn/catalog", {
        generated_at: Math.floor(Date.now() / 1000), embedding_model: EMBED_MODEL,
        domains: domains.map((m) => ({
            name: m.name, description: m.description, count: m.count, dim: m.dim,
            bytes: m.shards.reduce((s, x) => s + x.bytes, 0), shard_count: m.shards.length,
            entity_types: m.entity_types.map((e) => e.type), manifest: `${m.name}/manifest.json`,
            ...(m.link_hosts?.length ? { link_hosts: m.link_hosts } : {}),
            ...(m.coverage ? { coverage: m.coverage } : {}),
        })),
    });
}

// ── self-check: `node src/publish/view.js` — a fake chain, a fake embedder, the real reader ──
if (typeof process !== "undefined" && import.meta.url === `file://${process.argv[1]}` && process.argv[1].endsWith("/view.js")) {
    const { createServer } = await import("node:http");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { loadShard, configure } = await import("../core/shard.js");
    const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); };
    const manifestOf = (dir, d) => JSON.parse(readFileSync(`${dir}/cdn/domains/${d}/manifest`, "utf8"));
    const rec = (cid, type, payload, id = cid) => ({ id, cid, type, payload });

    // quickbeam's own outputs, pinned: the contract, not an approximation of it.
    eq(domainFor(`0x${"7e1497af".padEnd(64, "0")}`, "0x55cf6bd2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "media"), "7e1497af-55cf6bd2-media", "domain name = quickbeam's");
    eq(composeText({ name: "Oak", family: "Fagaceae", description: "big", entityType: "t" },
                   completeRoles({ title: "name", tags: ["family"], text: ["description"] })),
       "Title: Oak. Tags: Fagaceae. big", "embedded text = quickbeam's compose_document_text");

    const APP = `0x${"ab".repeat(32)}`, OWNER = `0x${"11".repeat(20)}`, PUB = `0x${"22".repeat(20)}`;
    const TAG = "shop.item.v1";
    const chain = {
        [`${OWNER}/${SCHEMA_REPO}`]: { records: [rec("t1", TYPE_TAG, {
            tag: TAG, description: "Things for a room.", role_map: { identity: "sku", title: "name", text: "about" },
            presentation: { externalUrl: { [TAG]: "https://shop.example/{sku}" } } })] },
        [`${PUB}/shop`]: { records: [
            rec("c1", TAG, { sku: "a1", name: "Oak table", about: "a solid oak dining table", price: 3 }),
            rec("c2", TAG, { sku: "b2", name: "Lamp", about: "brass reading lamp", price: 1 }),
            rec("c3", "shop.note.v1", { title: "Note", body: "an undeclared type, with a body long enough to count as its text field" }),
        ] },
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
    const run = () => publishView({ fangorn, app: APP, out, embed, log: () => {} });

    const d = domainFor(APP, PUB, "shop");
    const split = mkdtempSync(`${tmpdir()}/view-`);
    await publishView({ fangorn, app: APP, out: split, embed, log: () => {}, shardRows: 2 });
    eq(manifestOf(split, d).shards.map((s) => s.count), [2, 1], "rows past shardRows go to the next shard");
    embedded.length = 0;
    eq((await run())[d], { added: 3, removed: 0 }, "first run embeds everything");
    if (!embedded.includes("Title: Oak table. Tags: . a solid oak dining table")) throw new Error(`declared roles compose the text: ${embedded}`);
    let m = manifestOf(out, d);
    eq([m.role_map.identity, m.role_map.title, m.role_map.text, m.description], ["sku", "name", ["about"], "Things for a room."], "the schema is applied");
    eq([m.embedder, m.filter], [EMBEDDER, { owner: [PUB], repo: ["shop"] }], "the manifest names its encoder and its repo");

    eq(await run(), {}, "no head moved → nothing read, nothing embedded");
    eq(embedded.length, 3, "and the embedder was not called");

    chain[`${PUB}/shop`].records = [chain[`${PUB}/shop`].records[0],
        rec("c2b", TAG, { sku: "b2", name: "Lamp", about: "brass reading lamp", price: 2 }, "c2")];
    eq((await run())[d], { added: 1, removed: 2 }, "a changed record is a new CID; removed ones are dropped");
    m = manifestOf(out, d);
    eq([m.count, m.shards.length, m.tombstones, readdirSync(`${out}/cdn/domains/${d}/shards`).length], [2, 1, [], 1],
       "a removal compacts: the retracted rows' bytes are no longer served anywhere");
    if (embedded.length !== 4) throw new Error("compaction must not re-embed");
    chain[`${PUB}/shop`].records[1] = rec("c2c", TAG, { sku: "b3", name: "Lamp", about: "steel reading lamp", price: 2 }, "c2");
    eq((await run())[d], { added: 1, removed: 1 }, "a one-for-one replacement: same count, same types");
    m = manifestOf(out, d);
    eq(m.shards.map((x) => x.file).sort(), readdirSync(`${out}/cdn/domains/${d}/shards`).sort(),
       "and the manifest names the shards stored, not the ones compaction deleted");
    chain[`${PUB}/shop`].records[1] = rec("c2b", TAG, { sku: "b2", name: "Lamp", about: "brass reading lamp", price: 2 }, "c2");
    await run();   // back to the state the checks below expect
    chain[`${PUB}/shop`].records.push(rec("c4", TAG, { sku: "d4", name: "Rug", about: "wool rug" }));
    await run();
    chain[`${PUB}/shop`].records.pop();
    eq([manifestOf(out, d).count, manifestOf(out, d).shards.length], [3, 2], "an addition alone is a delta shard");
    await run();
    m = manifestOf(out, d);

    // The real reader over HTTP: digests checked, tombstones honoured, the publisher's id resolves.
    const srv = createServer((q, s) => { try { s.end(readFileSync(`${out}${decodeURIComponent(q.url)}`)); } catch { s.statusCode = 404; s.end(); } });
    await new Promise((ok) => srv.listen(0, ok));
    configure({ rowText: (f) => f.about ?? "" });
    const got = await loadShard(`http://127.0.0.1:${srv.address().port}`);
    srv.close();
    eq(got.map((r) => [r.id, r.price]).sort(), [["c1", 3], ["c2b", 2]], "readers see exactly the live records");
    const { getRow } = await import("../agent/tools.js");
    const { rolesFrom } = await import("../core/roles.js");
    eq(getRow(got, "b2", rolesFrom([m]))?.id, "c2b", "get by the publisher's own id, not the CID");

    // An exclusion: the app stops presenting the repo, and its domain stops being served.
    const shop = chain[`${PUB}/shop`];
    delete chain[`${PUB}/shop`];
    eq((await run())[d], { added: 0, removed: 2, dropped: true }, "a repo the app no longer presents is dropped");
    eq([existsSync(`${out}/cdn/domains/${d}`), JSON.parse(readFileSync(`${out}/cdn/catalog`, "utf8")).domains], [false, []], "with its files and its catalog entry");
    chain[`${PUB}/shop`] = shop;
    eq((await run())[d], { added: 2, removed: 0 }, "and a restore brings it back");

    const setEmbedder = (e) => { const x = manifestOf(out, d); x.embedder = e; x.head = "moved"; writeFileSync(`${out}/cdn/domains/${d}/manifest`, JSON.stringify(x)); };
    setEmbedder({ ...EMBEDDER, runtime: "transformers.js cuda" });
    if ((await run())[d]?.error) throw new Error("another runtime of the same q8 model must be accepted");
    setEmbedder({ runtime: "fastembed", dtype: "fp32" });
    if (!/not comparable/.test((await run())[d]?.error)) throw new Error("appending to another encoder's view must be refused");

    // The encoder gives out partway (a free daily allowance): what it embedded is served, and
    // the next run embeds only the rest, then takes the head.
    const big = mkdtempSync(`${tmpdir()}/view-`), BIG = `${PUB}/big`;
    chain[BIG] = { records: Array.from({ length: 80 }, (_, i) => ({ id: `r${i}`, cid: `big${i}`, type: "shop.item.v1", payload: { sku: `r${i}`, name: `Thing ${i}` } })) };
    let budget = 40;
    const capped = (ts) => (budget -= ts.length) < 0 ? Promise.reject(new Error("daily allowance used")) : Promise.all(ts.map(embed));
    const bd = domainFor(APP, PUB, "big");
    eq((await publishView({ fangorn, app: APP, out: big, repos: ["big"], embedBatch: capped, log: () => {} }))[bd],
       { added: 32, removed: 0, partial: true }, "an encoder that gives out keeps what it embedded");
    eq([manifestOf(big, bd).count, manifestOf(big, bd).head], [32, null], "served, and the head not taken");
    budget = 1e9;
    eq((await publishView({ fangorn, app: APP, out: big, repos: ["big"], embedBatch: capped, log: () => {} }))[bd],
       { added: 48, removed: 0 }, "the next run embeds only the rest");
    eq(manifestOf(big, bd).count, 80, "and serves all of it");
    delete chain[BIG];
    rmSync(big, { recursive: true, force: true });
    eq((await publishView({ fangorn, app: APP, out, embed, rebake: true, log: () => {} }))[d],
       { added: 2, removed: 0 }, "--rebake starts the domain over");
    eq(readdirSync(`${out}/cdn/domains/${d}/shards`).length, 1, "and leaves no orphaned shards");
    rmSync(out, { recursive: true, force: true });

    // Relations: a declared reference lands on its source row as the target's identity; an
    // undeclared one is left alone; a target whose identity moves relinks the row without embedding it.
    {
        const T = "civic.item.v1", M = "civic.matter.v1";
        const rel = { [`${OWNER}/${SCHEMA_REPO}`]: { records: [
            rec("ti", TYPE_TAG, { tag: T, role_map: { identity: "item_id", title: "heading", thread: "part_of" } }),
            rec("tm", TYPE_TAG, { tag: M, role_map: { identity: "matter_id", title: "title" } }),
            rec("tr", RELATION_TAG, { rel: "part_of", from: T, to: M })] },
            [`${PUB}/civic`]: { records: [
                rec("i1", T, { item_id: "a#1", heading: "Rezone, committee", part_of: { local: "m" } }),
                rec("i2", T, { item_id: "b#4", heading: "Rezone, council", cites: { local: "m" } }),
                rec("m1", M, { matter_id: "plover:7", title: "Rezone" }, "m")] } };
        const o = mkdtempSync(`${tmpdir()}/view-`), dr = domainFor(APP, PUB, "civic");
        const go = () => publishView({ fangorn: localFangorn(rel, { appId: APP, owner: OWNER }), app: APP, out: o, embed, log: () => {} });
        const rows = async () => Object.fromEntries([...(await loadDomain(fsStore(o), `cdn/domains/${dr}`)).rows.values()]
            .map((r) => [r.fields.heading ?? r.fields.title, r.fields.part_of ?? r.fields.cites ?? null]));
        await go();
        eq(await rows(), { "Rezone, committee": "plover:7", "Rezone, council": { local: "m" }, Rezone: null }, "a declared reference carries the target's identity; an undeclared one is left alone");
        eq(manifestOf(o, dr).role_map.thread, "part_of", "the thread role reaches the manifest");
        rel[`${PUB}/civic`].records[2] = rec("m1b", M, { matter_id: "plover:8", title: "Rezone" }, "m");
        const before = embedded.length;
        eq((await go())[dr], { added: 1, removed: 1, relinked: 1 }, "a target whose identity moves relinks the row that points at it");
        eq([(await rows())["Rezone, committee"], embedded.length - before], ["plover:8", 1], "without embedding it again");
        rmSync(o, { recursive: true, force: true });
    }

    // The R2 store: the same four calls over a bucket's flat keys.
    {
        const objs = new Map();
        const bucket = {
            get: async (k) => objs.has(k) ? { arrayBuffer: async () => objs.get(k) } : null,
            head: async (k) => objs.has(k) ? {} : null,
            put: async (k, b) => { objs.set(k, typeof b === "string" ? new TextEncoder().encode(b) : b); },
            delete: async (ks) => { for (const k of [ks].flat()) objs.delete(k); },
            list: async ({ prefix, delimiter }) => {
                const ks = [...objs.keys()].filter((k) => k.startsWith(prefix)).sort();
                if (!delimiter) return { objects: ks.map((key) => ({ key })), truncated: false };
                const deep = new Set(ks.filter((k) => k.slice(prefix.length).includes("/")).map((k) => prefix + k.slice(prefix.length).split("/")[0] + "/"));
                return { objects: ks.filter((k) => !k.slice(prefix.length).includes("/")).map((key) => ({ key })), delimitedPrefixes: [...deep], truncated: false };
            },
        };
        const r2 = r2Store(bucket);
        const via = await publishView({ fangorn, app: APP, store: r2, embed, log: () => {} });
        eq(Object.keys(via), [d], "a view builds into a bucket");
        eq(await r2.list("cdn/domains"), [d], "list names a folder's children");
        eq((await liveFields(r2)).length, 2, "and reads back");
        await r2.del(`cdn/domains/${d}`);
        eq([...objs.keys()].filter((k) => k.includes(d)), [], "del removes a folder and everything under it");
    }
    console.log("view.js self-check ok — domain names and embedded text match quickbeam's, the schema is applied, an unmoved head reads nothing, additions ship as delta shards, removals compact the domain, an excluded repo is dropped and a restored one returns, the real reader sees exactly the live records by the publisher's id, another encoder's view is refused, declared references land on their source rows, and the view builds the same into R2");
}
