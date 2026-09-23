// Reading a quickbeam VIEW's Semantic CDN shards, in the consumer's own process.
//
// One view → one manifest per watched (owner, namespace) domain → N gzipped
// NDJSON shards, downloaded once, kept in memory, ranked locally — no index
// server, no backend, and no chain read on the reader's path. The query never
// leaves the tab, which is the property the Semantic CDN exists for.
//
// Nothing here knows what a row IS. A row is `{ id, owner, ...fields, text,
// vector, norm }` and everything above that — what a file is, what a folder is,
// how hits group into results — is the app's. Scoring lives in ./rank.js.
//
// ── what an app has to wire ─────────────────────────────────────────────────
// `configure({ resolveView })` — how to learn WHICH view to read. Deliberately
// a callback and not a build-time constant: a view id embeds its requester and
// its name, so repointing an app at a new one must not need a rebuild. sond3r
// resolves it from its relay's /api/config; an app with a fixed view can pass
// `() => "https://reg/q/qb_1"`.
//
// `configure({ rowText })` — the free text a lexical query matches, per row.
// The default is name/path/desc. An app with passages (subtitle cues, chapters)
// joins those instead, because that is what its rows are about.
//
// Two ranking modes, chosen per row by ./rank.js: cosine for rows that carry a
// vector, word-boundary lexical for rows that don't. So search degrades rather
// than breaks.
//
// ponytail: brute-force scan over every row, and rows are held in memory whole.
// A linear pass over 2k × 256 floats is well under a frame. Reach for
// HNSW/quantization past ~50k rows, and for IndexedDB past what a tab will hold.

import { unpackVec } from "./embed.js";
import { rankDomains } from "./rank.js";

let _view = null;       // the app's default view base, resolved lazily
let _active = null;     // the view the reader navigated into, or null for the default
let _only = null;       // domain allowlist; null = pull every domain
const _shards = new Map();   // view base → its rows
// Everyone waiting to paint a download that is already running. Honouring only
// the caller that STARTED it was a race nobody could win: an app's catalog, its
// vector map and its search box's warm-up all call loadShard on the same tick,
// and whichever resumed first became the starter — so the one with the callback
// usually wasn't it, and the page sat blank until the last byte.
const _watchers = new Map(); // view base → Set of onRows
// A view's domain manifests, kept rather than discarded. They carry `role_map`
// and `presentation` — which field is the title, which are tags, which prose to
// search, what icon an entity type gets — baked by whoever published the domain.
// Throwing them away is what forces every consumer to hardcode field names and
// makes a "generic" reader work on exactly one dataset. See ./roles.js.
const _meta = new Map(); // view base → [manifest, …]

/** Free text a lexical query can match. Overridable — see the header. */
let _rowText = (f) => [f.name, f.path, f.desc].filter(Boolean).join(" ");
/** How to learn the default view. Overridden by the app; unset means an app that
 *  always passes an explicit view base, which is a legitimate way to use this. */
let _resolveView = null;
/** Called with the domain manifests once they land and BEFORE the first shard is
 *  parsed. See configure(). */
let _onManifests = null;

/**
 * Wire the app-specific pieces. All optional; called once at startup.
 *
 * `onManifests` exists because of an ordering that is easy to get wrong and
 * silent when you do: `rowText` runs per row during parsing, so anything it
 * depends on must be ready BEFORE the first shard is read. Deriving it from the
 * manifests after `loadShard` resolves is too late — every row was already
 * parsed with whatever the default was, and the symptom is not an error, it is
 * search quietly matching nothing. The format puts every manifest on the wire
 * before any shard, so this hook is the moment that dependency can be satisfied.
 *
 * Both hooks are handed the VIEW they are running for. A page that holds more
 * than one corpus open needs per-corpus roles, and `_shards`/`_meta` are already
 * keyed by view — these two callbacks were the only globals left, and without
 * the argument the second corpus loaded would silently be parsed with the
 * first one's text role.
 */
export function configure({ resolveView, rowText, onManifests } = {}) {
    if (resolveView) _resolveView = resolveView;
    if (rowText) _rowText = rowText;
    if (onManifests) _onManifests = onManifests;
}

/** Drop everything cached — self-checks reload between fixtures, and the SSE
 *  watcher drops it when a domain gains shards. Leaves `configure` alone: it is
 *  startup wiring, not cache. */
export const resetShard = () => { _shards.clear(); _watchers.clear(); _meta.clear(); _view = null; _active = null; _only = null; };

/**
 * Point every no-arg reader (browse, search, vectors, the SSE watcher) at one
 * view. `null` goes back to the app's default.
 *
 * A module-level current view rather than a url threaded through every call
 * site: an app shows one view at a time, and the cache below is keyed by view,
 * so switching back is free rather than a re-download.
 */
export function setView(url) {
    _active = url ? trimView(url) : null;
}
export const activeView = () => _active;

/** The registry prints a domain's `/stream` and `/cdn` URLs rather than the base,
 *  so either is accepted and trimmed back to the thing every route hangs off. */
export const trimView = (url) => String(url).replace(/\/+$/, "").replace(/\/(stream|cdn)$/, "");

/** The view base — `{registry}/q/{viewId}`. Cached; a failure clears the slot so
 *  the next call retries. */
function viewBase() {
    if (!_resolveView) return Promise.resolve(null);
    return (_view ??= Promise.resolve()
        .then(() => _resolveView())
        .then((u) => (u ? trimView(u) : null))
        .catch((e) => { _view = null; throw e; }));
}

/**
 * Which of a view's domains to actually download. `null` = all of them.
 *
 * A view fuses several publishers/namespaces, and `load()` pulls EVERY one —
 * which is right for a view built to be browsed whole and wrong for one that has
 * last month's test corpus still watched alongside this month's. Two corpora is
 * twice the bytes, twice the parse, and the second one is not on screen.
 *
 * An entry matches a domain by exact name, by its namespace half (`0xabc/videos`
 * matched by `videos`), or as a prefix — the registry prints these three ways
 * depending on which surface you read them off, and requiring the exact form
 * means a filter that silently matches nothing.
 */
export function setDomains(only) {
    const list = (Array.isArray(only) ? only : String(only ?? "").split(","))
        .map((x) => String(x).trim()).filter(Boolean);
    _only = list.length ? list : null;
}

/** Does `name` (as the view lists it) match the configured allowlist? */
const wanted = (name) => !_only || _only.some((e) =>
    name === e || name.split("/").pop() === e || name.startsWith(e));

const NO_VIEW = "no quickbeam view configured — pass a view base, or wire one with configure({ resolveView })";

/** Fetch + parse a view's shards. Cached PER VIEW; concurrent callers share one
 *  fetch. Keyed by the resolved base, so two apps on screen in one session can't
 *  serve each other's rows out of a single global slot.
 *
 *  `onRows` is called with the merged rows so far after every shard, so a big
 *  catalog paints as it arrives instead of after the last byte. Only the caller
 *  that starts the download sees them — a second concurrent reader shares the
 *  same promise and just waits. */
export async function loadShard(base, onRows) {
    const at = base ?? _active ?? await viewBase();
    if (!at) throw new Error(NO_VIEW);
    // Subscribe BEFORE the cache check: a load already in flight still has rows to
    // come, and a late subscriber must get them. Registering first also means the
    // order these callers happen to resume in stops mattering.
    let subs = _watchers.get(at);
    if (!subs) _watchers.set(at, (subs = new Set()));
    if (onRows) subs.add(onRows);

    const hit = _shards.get(at);
    if (hit) return hit; // already downloaded: nothing to stream, the caller gets it whole
    // A rejected promise left in the cache poisons every later search until a page
    // reload, so failures clear the slot and the next call retries.
    const fan = (rows) => { for (const f of subs) { try { f(rows); } catch { /* one bad painter must not stop the rest */ } } };
    const p = load(at, fan)
        .finally(() => _watchers.delete(at))
        .catch((e) => { _shards.delete(at); throw e; });
    _shards.set(at, p);
    return p;
}

/** Fetch a text body, gunzipping it if the server sent raw gzip — see the sniff
 *  below. Exported because an app resolving its own view reads config the same
 *  way, and a second copy of the sniff would drift. */
export async function fetchText(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`shard: HTTP ${res.status} for ${url}`);

    // Who gunzips depends on the server. `cdn serve` sends a shard as
    // `application/gzip` with no Content-Encoding, so the raw gzip arrives here; a
    // host (or a proxy) that labels it `Content-Encoding: gzip` has the BROWSER
    // decode it first, and a DecompressionStream would then choke on plain NDJSON.
    // Sniff the magic bytes rather than trusting headers — this has to work under
    // both, and the same function reads the plain-JSON catalog and manifests.
    return decodeMaybeGzip(new Uint8Array(await res.arrayBuffer()));
}

const decodeMaybeGzip = async (buf) => (buf[0] === 0x1f && buf[1] === 0x8b
    ? await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"))).text()
    : new TextDecoder().decode(buf));

function toRow(row, view) {
    const f = row.fields ?? {};
    // Three wire forms for the same vector, and all three are live:
    //   `v`               base64 int8, what the CDN bake writes now
    //   `embedding`       plain float array, what it wrote before — shards are
    //                     served immutable for a year, so this never goes away
    //   `fields.embed.vec` base64 int8, the shape a publisher commits on-chain
    // Packed first: a row with both was written by a bake keeping the old key
    // for compatibility, and the packed one is what the manifest's `dim` describes.
    const v = typeof row.v === "string" ? unpackVec(row.v)
        : Array.isArray(row.embedding) ? row.embedding
        : typeof f.embed?.vec === "string" ? unpackVec(f.embed.vec) : null;
    let norm = 0;
    if (v) for (const x of v) norm += x * x;
    return { id: row.track_id, owner: row.owner, ...f, text: _rowText(f, view), vector: v, norm: Math.sqrt(norm) || 1 };
}

/** Hex SHA-256 of the bytes exactly as they arrived. */
async function sha256Hex(chunks) {
    let n = 0;
    for (const c of chunks) n += c.length;
    const all = new Uint8Array(n);
    let at = 0;
    for (const c of chunks) { all.set(c, at); at += c.length; }
    return [...new Uint8Array(await crypto.subtle.digest("SHA-256", all))]
        .map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Check a shard against the digest its own manifest published.
 *
 * WHY THIS IS WHAT LETS THE BYTES LIVE ANYWHERE
 * ---------------------------------------------
 * Shards are immutable, hash-named files. Without this check a reader trusts
 * whichever host handed them over, so they can only safely come from the
 * publisher's own origin — and every mirror, CDN edge, gateway or peer is a
 * place to substitute rows nobody would notice. With it, the manifest is the
 * authority and the transport is not trusted at all, which is the difference
 * between "we have to run the server" and "put it anywhere".
 *
 * The manifest hashes the file AS SERVED — gzipped. So this can only run when
 * the raw gzip actually reached us. A host or proxy that sets
 * `Content-Encoding: gzip` has the fetch layer decode it first, and gzip is not
 * reproducible across implementations, so there is nothing left to compare
 * against. That is REPORTED rather than silently passed: serving `.ndjson.gz`
 * as `application/gzip` with no Content-Encoding is precisely what makes a
 * third-party mirror checkable, and a publisher who has it wrong needs to know
 * that their readers cannot verify anything.
 *
 * ponytail: verified at the END of the stream, so rows are handed to the caller
 * before the digest is known. Buffering 34MB to check it first would delete the
 * streaming first paint this file exists to provide. A mismatch therefore
 * REJECTS the load — `loadShard` drops the cache entry, and a caller that
 * painted intermediate rows must treat a failed load as "discard what you
 * showed". Same trade every streaming extractor makes.
 */
async function verifyShard(url, expect, chunks, gz) {
    // No digest: an older bake. Shards are served immutable for a year, so these
    // do not go away and refusing them would take working corpora offline.
    if (!expect) return;
    if (!gz) { console.warn(`shard: cannot verify ${url} — the transport decoded it (Content-Encoding), and the manifest digest is over the gzipped bytes`); return; }
    const got = await sha256Hex(chunks);
    if (got !== expect) throw new Error(`shard: ${url} does not match the digest in its manifest (expected ${expect.slice(0, 12)}…, got ${got.slice(0, 12)}…)`);
}

/** NDJSON as it arrives, a line at a time.
 *
 *  A shard is ONE file and it is big — the live view's is 34MB gzipped, 100MB of
 *  JSON, and `arrayBuffer()` means nothing at all exists until the last byte of
 *  it lands. Read the body as a stream and the first rows are usable after the
 *  first chunk, which is the difference between a blank page for the length of a
 *  34MB download and a catalog that fills in.
 *
 *  Same gzip sniff as fetchText and for the same reason (see there) — it just has
 *  to happen on the first chunk instead of on the whole buffer. No `res.body`
 *  (the self-check's fixtures, an ancient browser) falls back to the buffered
 *  read, so this is an optimisation and never a requirement.
 */
async function fetchLines(url, onLine, expect) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`shard: HTTP ${res.status} for ${url}`);
    if (!res.body) {
        // The buffered path has every byte before it parses one, so it can verify
        // FIRST — the streaming path below cannot, and says so.
        const buf = new Uint8Array(await res.arrayBuffer());
        await verifyShard(url, expect, [buf], buf[0] === 0x1f && buf[1] === 0x8b);
        // `.split("\n")`: iterating the decoded string yields CHARACTERS, and
        // every one of them reached JSON.parse.
        for (const line of (await decodeMaybeGzip(buf)).split("\n")) onLine(line);
        return;
    }
    const reader = res.body.getReader();
    const first = await reader.read();
    const head = first.value ?? new Uint8Array();
    // Kept only when there is a digest to check them against: a 34MB shard is
    // 34MB of retained chunks, and paying that for a bake that published no
    // digest buys nothing.
    const seen = expect ? [] : null;
    const raw = new ReadableStream({
        start(c) { if (head.length) { seen?.push(head); c.enqueue(head); } if (first.done) c.close(); },
        async pull(c) { const { done, value } = await reader.read(); if (done) { c.close(); } else { seen?.push(value); c.enqueue(value); } },
        cancel(r) { return reader.cancel(r); },
    });
    const gz = head[0] === 0x1f && head[1] === 0x8b;
    const bytes = gz ? raw.pipeThrough(new DecompressionStream("gzip")) : raw;
    const dec = new TextDecoder();
    let buf = "";
    for (const r = bytes.getReader(); ;) {
        const { done, value } = await r.read();
        // A chunk boundary lands mid-line far more often than not, so the tail is
        // held back until its newline arrives. `stream: true` does the same for a
        // multi-byte character split across chunks.
        buf += done ? dec.decode() : dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = done ? "" : lines.pop();
        for (const line of lines) onLine(line);
        if (done) {
            if (buf) onLine(buf);
            // After the last line, not before the first: see verifyShard's note
            // on why the stream is not buffered to check it up front.
            await verifyShard(url, expect, seen, gz);
            return;
        }
    }
}

// How often a partial catalog is handed up. Every line would be correct and
// useless: the viewer rebuilds its tree, shelves, concepts and wiki from scratch
// on each one — ~200ms of derivation at 4k files. Painting four times a second
// is already faster than anyone reads.
const EMIT_MS = 250;

// The download itself is not optimised, only its arrival — but it no longer
// needs to be: embeddings were 56% of a shard as JSON floats and the bake now
// writes them as base64 int8 (~14x smaller per vector). Both forms are still
// read; see toRow.

async function load(view, onRows) {
    const cdn = `${view}/cdn`;

    // The view's own domain list: one per watched (owner, namespace), already
    // filtered to this view by the registry worker. It's the only way the browser
    // learns which domains to pull — the view's sources aren't public here.
    const { domains: listed = [] } = JSON.parse(await fetchText(`${cdn}/catalog`));
    // Narrowed BEFORE any manifest is fetched: a domain that is filtered out must
    // cost nothing, not be downloaded and then hidden.
    const domains = listed.filter((d) => wanted(d.name));
    if (_only && domains.length !== listed.length) {
        console.info(`shard: pulling ${domains.length} of ${listed.length} domains (allowlist: ${_only.join(",")})`);
    }
    if (_only && !domains.length) {
        console.warn(`shard: allowlist ${_only.join(",")} matched none of ${listed.map((d) => d.name).join(", ")} — nothing will load`);
    }
    // A view with nothing baked yet is the normal state of a brand-new one, not an
    // error. Say which it is, or "search finds nothing" is indistinguishable from
    // a URL pointing at the wrong view.
    if (!domains.length) console.warn(`shard: quickbeam view ${cdn} has no baked domains yet — nothing to read until the watcher bakes one.`);

    const byId = new Map();
    const dead = new Set();

    // Every manifest BEFORE any shard: a tombstone retracts an id whatever order
    // its shard arrives in, and knowing them all up front is what makes an
    // intermediate emit honest rather than a flash of deleted files.
    const domainsAt = await Promise.all(domains.map(async (d) => {
        const at = `${cdn}/domains/${encodeURIComponent(d.name)}`;
        const m = JSON.parse(await fetchText(`${at}/manifest`));
        for (const id of m.tombstones ?? []) dead.add(id);
        return { at, manifest: m, shards: m.shards ?? [] };
    }));
    // Recorded — and handed to the app — before a single shard is read, so a
    // consumer can lay out its page from the manifests while the rows are still
    // arriving, and so `rowText` is correct for the very first row.
    const manifests = domainsAt.map((d) => d.manifest);
    _meta.set(view, manifests);
    try { _onManifests?.(manifests, view); }
    catch (e) { console.warn("shard: onManifests threw, continuing with the default rowText —", e); }

    // Domains stream in parallel: their track_ids are vertex CIDs, so rows can't
    // collide across publishers and the interleaving is free. Sequential WITHIN a
    // domain, because a delta shard re-delivers an updated record under the same
    // track_id and the later one has to win.
    let painted = Date.now(); // first paint is a shard in, or EMIT_MS in — whichever comes first
    // A shard boundary always paints — it's the honest checkpoint, and there are
    // one or two of them. The throttle is for the lines INSIDE one, where there
    // are tens of thousands.
    const emit = (force) => {
        if (!onRows || (!force && Date.now() - painted < EMIT_MS)) return;
        onRows([...byId.values()]);
        // Clocked from when the paint FINISHED, not when it started: the callback
        // rebuilds the viewer's whole page synchronously, so timing from the start
        // would queue the next one before the last had let go of the thread.
        painted = Date.now();
    };
    await Promise.all(domainsAt.map(async ({ at, shards }) => {
        for (const s of shards) {
            // The manifest's own digest for this file. A shard that does not
            // match it fails the load rather than becoming rows — which is what
            // lets `/cdn` sit behind any CDN, gateway or peer instead of a
            // server this project has to run.
            await fetchLines(`${at}/shards/${s.file}`, (line) => {
                if (!line.trim()) return;
                const r = toRow(JSON.parse(line), view);
                if (!dead.has(r.id)) byId.set(r.id, r);
                emit();
            }, s.sha256);
            emit(true);
        }
    }));
    return [...byId.values()];
}

/**
 * Hold the view's SSE stream open and call `onChange` when a watched namespace gains
 * shards. Returns an unsubscribe.
 *
 * The stream says WHEN a domain changed, never what — so this only drops the cache
 * and lets the next read re-pull through the normal shard route. `snapshot` is the
 * connect-time census and it re-fires on every automatic reconnect, so treating it
 * as a change would reload the whole catalog each time a proxy cuts the socket.
 */
export function watchShard(onChange, base) {
    let es = null, stopped = false;
    (async () => {
        const view = base ?? _active ?? await viewBase();
        if (!view || stopped) return;
        es = new EventSource(`${view}/stream`);
        const changed = () => { resetShard(); onChange(); };
        es.addEventListener("added", changed);  // a namespace's first bake
        es.addEventListener("change", changed); // new delta shards
    })().catch(() => { }); // no view configured → no live updates; search still works
    return () => { stopped = true; es?.close(); };
}


/** The manifests of the domains this view actually loaded — `role_map`,
 *  `presentation`, `entity_types`, shard checksums. Empty until `loadShard` has
 *  fetched them, which happens before any row is parsed. Feed them to
 *  ./roles.js rather than reading role_map by hand. */
export const domainManifests = (base) => _meta.get(base ?? _active ?? "") ?? [..._meta.values()][0] ?? [];

/** The view's domain list, ranked against a lookahead vector. Not cached — it's
 *  one small JSON and it changes whenever the watcher bakes. */
export async function suggestDomains(q, { url } = {}) {
    const view = url ?? _active ?? await viewBase();
    if (!view) throw new Error(NO_VIEW);
    const { domains = [] } = JSON.parse(await fetchText(`${view}/cdn/catalog`));
    return rankDomains(domains, q);
}

// ── self-check: `node consume/shard.js` — no network, no view ────────────────
if (typeof process !== "undefined" && import.meta.url === `file://${process.argv[1]}` && process.argv[1].endsWith("/shard.js")) {
    const { gzipSync } = await import("node:zlib");
    const warn = console.warn, info = console.info;
    console.warn = console.info = () => {}; // the fallback warnings are behaviour under test, not output

    const row = (owner, path, extra = {}, embedding) => ({
        track_id: `${owner}:${path}`, owner, ...(embedding ? { embedding } : {}),
        fields: { entityType: "file", name: path.split("/").pop(), path, ...extra },
    });
    const ndjson = (rows) => rows.map((r) => JSON.stringify(r)).join("\n");
    const VIEW = "https://registry.test/q/qb_test";

    // Two chunks, split mid-body: exercises the streaming reader the real loader
    // uses, including a line cut across a chunk boundary.
    const body = (buf) => {
        const b = Buffer.from(buf), half = Math.max(1, Math.floor(b.length / 2));
        return {
            ok: true, headers: new Headers(), arrayBuffer: async () => b,
            body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array(b.subarray(0, half))); c.enqueue(new Uint8Array(b.subarray(half))); c.close(); } }),
        };
    };

    const hex = async (b) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", b))].map((x) => x.toString(16).padStart(2, "0")).join("");
    const serveView = async (domains, { tombstones = {}, gzipped = true, keep = false, coverage = {}, digest = false, corrupt = false } = {}) => {
        const state = new Map();
        for (const [name, shards] of Object.entries(domains)) {
            const files = shards.map((_, i) => `shard-000${i}-${name}.ndjson.gz`);
            const bodies = new Map(files.map((f, i) => [f, ndjson(shards[i])]));
            // `digest` publishes the sha256 of the bytes AS SERVED, which is what a
            // real bake writes; `corrupt` publishes one for different bytes, which
            // is what a substituting mirror looks like from the reader's side.
            const shas = digest
                ? await Promise.all(files.map(async (f) => hex(gzipSync(Buffer.from(corrupt ? bodies.get(f) + "\n" : bodies.get(f))))))
                : files.map(() => undefined);
            state.set(name, {
                manifest: JSON.stringify({ name, shards: files.map((file, i) => ({ file, ...(shas[i] ? { sha256: shas[i] } : {}) })), tombstones: tombstones[name] ?? [] }),
                bodies,
            });
        }
        globalThis.fetch = async (url) => {
            const { pathname } = new URL(String(url), "https://app.test");
            // An untrimmed base would ask for /stream/cdn/… — which must 404 here,
            // not silently work.
            if (pathname.includes("/stream/")) return { ok: false, status: 404 };
            if (pathname.endsWith("/cdn/catalog")) return body(JSON.stringify({ domains: [...state.keys()].map((name) => ({ name, ...(coverage[name] ? { coverage: coverage[name] } : {}) })) }));
            let m = pathname.match(/\/cdn\/domains\/([^/]+)\/manifest$/);
            if (m) return state.has(m[1]) ? body(state.get(m[1]).manifest) : { ok: false, status: 404 };
            m = pathname.match(/\/cdn\/domains\/([^/]+)\/shards\/([^/]+)$/);
            if (m) {
                const text = state.get(m[1])?.bodies.get(m[2]);
                if (text === undefined) return { ok: false, status: 404 };
                return body(gzipped ? gzipSync(Buffer.from(text)) : Buffer.from(text));
            }
            return { ok: false, status: 404 };
        };
        if (!keep) resetShard();
        // Re-wired after every reset: resetShard clears the resolved base, not the wiring.
        configure({ resolveView: () => `${VIEW}/stream` });
    };
    const serve = async (shards, opts = {}) => serveView({ d0: shards }, { ...opts, tombstones: { d0: opts.tombstones ?? [] } });
    // gzipSync is deterministic for a fixed input at a fixed level, which is why
    // the fixture can hash what it is about to serve. Across zlib builds it is
    // not — hence verifyShard's rule that only the bytes as served are hashed.
    const paths = (rows) => rows.map((r) => r.path).sort().join(",");

    // ── the view is resolved through the app's callback, and trimmed ──
    // The registry prints /stream and /cdn URLs rather than the base; a base that
    // kept the suffix asks for /stream/cdn/catalog, which the fixture 404s.
    await serve([[row("0xa", "a.md")]]);
    if (paths(await loadShard()) !== "a.md") throw new Error("resolveView never reached the loader");

    // ── gzip is sniffed, not trusted ──
    // `cdn serve` sends application/gzip with no Content-Encoding, so raw gzip
    // arrives here; a proxy that labels it has the BROWSER decode it first, and a
    // DecompressionStream would then choke on plain NDJSON. Both must work.
    await serve([[row("0xa", "plain.md")]], { gzipped: false });
    if (paths(await loadShard()) !== "plain.md") throw new Error("an already-decoded body must still parse");

    // ── a shard is checked against the digest its manifest published ──
    // This is what lets /cdn live on any CDN, gateway or peer: the manifest is
    // the authority, and the host handing over the bytes is not trusted at all.
    await serve([[row("0xa", "signed.md")]], { digest: true });
    if (paths(await loadShard()) !== "signed.md") throw new Error("a shard matching its digest must load");

    // …and a substituted one fails the load rather than becoming rows. Bytes that
    // differ by a single trailing newline are the polite version of this; a mirror
    // rewriting a price or a link looks identical from here.
    await serve([[row("0xa", "tampered.md")]], { digest: true, corrupt: true });
    let caught = null;
    try { await loadShard(); } catch (e) { caught = e; }
    if (!caught) throw new Error("a shard that does not match its digest must fail the load");
    if (!/does not match the digest/.test(caught.message)) throw new Error(`wrong error: ${caught.message}`);
    // …and nothing is left cached, or the next reader is served the tampered rows
    // out of memory with no fetch and no second chance to notice.
    caught = null;
    try { await loadShard(); } catch (e) { caught = e; }
    if (!caught) throw new Error("a failed verification must not leave the rows in the cache");

    // A transport that decoded the body first (Content-Encoding: gzip) leaves
    // nothing to compare — gzip is not reproducible across implementations. That
    // is reported and the rows still load: refusing them would take every corpus
    // behind such a host offline, and pretending it verified would be a lie.
    let warned = "";
    console.warn = (m) => { warned += m; };
    await serve([[row("0xa", "unverifiable.md")]], { digest: true, gzipped: false });
    if (paths(await loadShard()) !== "unverifiable.md") throw new Error("an unverifiable body must still load");
    if (!/cannot verify/.test(warned)) throw new Error("an unverifiable shard must say so, not pass silently");
    console.warn = () => {};

    // ── domains merge; a tombstone retracts only its own domain's row ──
    await serveView({
        "aaa": [[row("0xa", "a.md", { desc: "alpha" }), row("0xa", "gone.md", { desc: "retracted" })]],
        "bbb": [[row("0xb", "b.md", { desc: "beta" })]],
    }, { tombstones: { aaa: ["0xa:gone.md"] } });
    if (paths(await loadShard()) !== "a.md,b.md") throw new Error("domains must merge and tombstones retract");

    // ── the allowlist is applied BEFORE any manifest is fetched ──
    // A filtered-out domain must cost nothing, not be downloaded and then hidden.
    // It matches by exact name, namespace half, or prefix — the registry prints
    // all three, and requiring one form is a filter that silently matches nothing.
    for (const only of ["bbb", ["bbb"], "bb"]) {
        await serveView({ aaa: [[row("0xa", "a.md")]], bbb: [[row("0xb", "b.md")]] });
        setDomains(only);
        if (paths(await loadShard()) !== "b.md") throw new Error(`allowlist ${JSON.stringify(only)} did not narrow the load`);
    }
    await serveView({ aaa: [[row("0xa", "a.md")]] });
    setDomains(null);
    if (paths(await loadShard()) !== "a.md") throw new Error("a null allowlist must pull everything");

    // ── streaming: a two-shard catalog arrives in installments, growing ──
    await serve([
        [row("0xa", "a.md"), row("0xa", "gone.md")],
        [row("0xa", "b.md")],
    ], { tombstones: ["0xa:gone.md"] });
    {
        const steps = [];
        const all = await loadShard(undefined, (r) => steps.push(r.length));
        if (steps.length !== 2 || steps[0] !== 1 || steps[1] !== 2) throw new Error(`must emit per shard, got ${steps}`);
        if (all.length !== 2) throw new Error("the final rows must still be whole");
        if (steps.some((n) => n > 2)) throw new Error("a tombstoned row must never surface in a partial emit");
    }

    // ── a LATE subscriber streams too ──
    // Several readers call loadShard on the same tick; honouring only the one that
    // happened to start the download meant the caller holding the paint callback
    // usually wasn't it, and the page stayed blank until the last byte.
    await serve([[row("0xa", "a.md")], [row("0xa", "b.md")]]);
    {
        const first = [], second = [];
        const a = loadShard(undefined, (r) => first.push(r.length)); // the starter
        const b = loadShard(undefined, (r) => second.push(r.length)); // joins in flight
        await Promise.all([a, b]);
        if (!first.length) throw new Error("the starting caller must still receive partials");
        if (!second.length) throw new Error("a caller that joins an in-flight load must receive partials too");
    }

    // ── a failed load must not poison the cache ──
    // A rejected promise left in the slot makes every later read fail until a page
    // reload, which reads as "search broke" rather than "one fetch failed".
    resetShard();
    configure({ resolveView: () => `${VIEW}/stream` });
    globalThis.fetch = async () => ({ ok: false, status: 500 });
    await loadShard().then(() => { throw new Error("a 500 must reject"); }, () => {});
    await serve([[row("0xa", "a.md")]], { keep: true });
    if (paths(await loadShard()) !== "a.md") throw new Error("a failed load poisoned the cache — the next read must retry");

    // ── onManifests fires BEFORE the first row is parsed ──
    // The ordering rowText depends on. Deriving row text from the manifest after
    // the load resolves is too late and fails silently: every row is already
    // parsed, and search matches nothing rather than erroring.
    {
        const order = [];
        await serveView({ d0: [[row("0xa", "a.md", { blurb: "declared prose" })]] });
        configure({
            onManifests: (ms) => order.push(`manifests:${ms[0]?.name}`),
            rowText: (f) => { order.push("rowText"); return f.blurb ?? ""; },
        });
        const got = await loadShard();
        if (order[0] !== "manifests:d0") throw new Error(`onManifests must fire first, got ${order}`);
        if (!order.includes("rowText")) throw new Error("rowText never ran");
        if (got[0].text !== "declared prose") throw new Error("the manifest-derived rowText did not reach toRow");
        // A throwing hook must not take the load down with it.
        resetShard();
        configure({ resolveView: () => `${VIEW}/stream`, onManifests: () => { throw new Error("boom"); } });
        if ((await loadShard()).length !== 1) throw new Error("a throwing onManifests must not fail the load");
        configure({ onManifests: () => {} });
    }

    // ── configure({ rowText }) decides what a lexical query can match ──
    // The default is name/path/desc. An app whose rows carry passages joins those,
    // because that is what its rows are about.
    await serve([[row("0xa", "ep1.md", { cues: [{ text: "the submarine dives" }] })]]);
    if ((await loadShard())[0].text.includes("submarine")) throw new Error("the default rowText must not know about cues");
    configure({ rowText: (f) => (f.cues?.length ? f.cues.map((c) => c.text).join(" ") : [f.name, f.path, f.desc].filter(Boolean).join(" ")) });
    resetShard();
    configure({ resolveView: () => `${VIEW}/stream` });
    if (!(await loadShard())[0].text.includes("submarine")) throw new Error("a configured rowText must reach toRow");

    // …and it is told WHICH view it is parsing for, which is the whole of what a
    // page needs to hold two publishers' corpora open at once: roles are per
    // corpus, and rowText runs before loadShard has returned either of them.
    {
        const seen = new Set();
        configure({ rowText: (f, view) => { seen.add(view); return f.name ?? ""; },
                    onManifests: (ms, view) => { seen.add(`m:${view}`); } });
        resetShard();
        configure({ resolveView: () => `${VIEW}/stream` });
        await loadShard();
        if (!seen.has(VIEW)) throw new Error(`rowText must receive its trimmed view base, saw ${[...seen]}`);
        if (!seen.has(`m:${VIEW}`)) throw new Error("onManifests must receive its view");
        configure({ rowText: (f) => [f.name, f.path, f.desc].filter(Boolean).join(" "), onManifests: () => {} });
    }

    // ── vectors: both wire forms, and the norm computed once at parse time ──
    await serve([[row("0xa", "v.md", {}, [3, 4]), row("0xa", "packed.md", { embed: { vec: "fwA=" } }), row("0xa", "none.md")]]);
    {
        const by = new Map((await loadShard()).map((r) => [r.path, r]));
        if (Math.abs(by.get("v.md").norm - 5) > 1e-9) throw new Error("norm must be precomputed from the plain float array");
        if (!by.get("packed.md").vector) throw new Error("the base64 int8 form a publisher commits must unpack");
        if (by.get("none.md").vector !== null) throw new Error("a row with no vector must be null, and rank lexically");
        if (by.get("none.md").norm !== 1) throw new Error("a zero norm would divide search by zero");
    }

    // ── the bake's packed vector (`v`), the form shipped today ──
    // Pinned against pack_vec in quickbeam/vectors.py: [0,1,-1] -> "AH+B". A
    // drift here is not a crash, it is cosine ranking on noise.
    {
        await serveView({ d0: [[{ track_id: "p1", owner: "0xa", v: "AH+B", fields: { entityType: "file", name: "packed.md", path: "packed.md" } },
                          { track_id: "p2", owner: "0xa", embedding: [0, 1, -1], fields: { entityType: "file", name: "old.md", path: "old.md" } }]] });
        const by = new Map((await loadShard()).map((r) => [r.path, r]));
        const p = by.get("packed.md").vector, o = by.get("old.md").vector;
        if (!p) throw new Error("the bake's `v` key must unpack");
        for (let i = 0; i < 3; i++) {
            if (Math.abs(p[i] - o[i]) > 1 / 127) throw new Error(`packed and float forms disagree at ${i}: ${p[i]} vs ${o[i]}`);
        }
        if (Math.abs(by.get("packed.md").norm - by.get("old.md").norm) > 0.02) throw new Error("norm must match across wire forms");
    }

    // ── suggestDomains ranks what has NOT been downloaded ──
    await serveView({
        near: [[row("0xa", "a.md")]], far: [[row("0xb", "b.md")]], old: [[row("0xc", "c.md")]],
    }, { coverage: { near: { vectors: [[1, 0]] }, far: { vectors: [[0, 1]] } } });
    {
        const ranked = await suggestDomains([1, 0]);
        if (ranked.map((d) => d.name).join(",") !== "near,far,old") throw new Error(`suggestDomains misranked: ${ranked.map((d) => d.name)}`);
    }

    // ── watchShard: `change`/`added` drop the cache, `snapshot` must not ──
    // snapshot is the connect-time census and it re-fires on every automatic
    // reconnect, so treating it as a change re-downloads every shard whenever a
    // proxy cuts the socket.
    await serve([[row("0xa", "before.md")]]);
    {
        const listeners = new Map();
        let opened = "", closed = false;
        globalThis.EventSource = class {
            constructor(url) { opened = url; }
            addEventListener(type, fn) { listeners.set(type, fn); }
            close() { closed = true; }
        };
        let bumps = 0;
        const stop = watchShard(() => { bumps++; });
        await new Promise((r) => setTimeout(r, 0)); // the base resolves a microtask later
        if (opened !== `${VIEW}/stream`) throw new Error(`watchShard must open the view's SSE stream, got ${opened}`);
        if (listeners.has("snapshot")) throw new Error("snapshot is the connect-time census, not a change");
        if (paths(await loadShard()) !== "before.md") throw new Error("watchShard fixture never loaded");

        await serve([[row("0xa", "after.md")]], { keep: true });
        listeners.get("change")();
        if (bumps !== 1) throw new Error("a `change` event must reach the caller");
        if (paths(await loadShard()) !== "after.md") throw new Error("a `change` must drop the cache so the next read re-pulls");
        stop();
        if (!closed) throw new Error("the unsubscribe must close the stream");
    }

    // ── setView switches app without re-downloading the one you came from ──
    await serveView({ d0: [[row("0xa", "home.md")]], other: [[row("0xb", "guest.md")]] });
    await loadShard();
    setView(`${VIEW}/cdn`); // an app's own view, given as the /cdn URL the registry prints
    if (activeView() !== VIEW) throw new Error("setView must trim to the base every route hangs off");
    setView(null);
    if (activeView() !== null) throw new Error("setView(null) must go back to the app default");

    console.warn = warn; console.info = info;
    console.log("shard.js self-check ok — resolveView, gzip sniff, shard digests, domain merge + tombstones + allowlist, streaming, late subscriber, cache poisoning, rowText, vectors, suggestDomains, watchShard");
}
