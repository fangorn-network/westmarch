// Filesystem tree <-> Fangorn graph.
//
// An app's content is an open-ended tree of folders and files — the tree IS the
// structure, no fixed schema. Publishing snapshots it into a Fangorn commit
// graph: a vertex per folder and per published file, with parent→child
// `contains` edges. `replace: true` gives snapshot semantics, so the remote
// graph is always exactly the current library.
//
// A file vertex carries whatever pointer its app needs to fetch the bytes
// (sond3r puts the x402f resourceId/price/workerUrl there); the bytes themselves
// live wherever the app put them, not in the graph. Vertices are keyed by
// relative path.
//
// ── what an app has to pin ──────────────────────────────────────────────────
// `opts.file` is the string used for the fs node's `type`, the vertex `tag` and
// the payload's `kind`. It goes on-chain, so an app picks it once and never
// again: sond3r pins "video" (historical — it means "a file for sale", and every
// vertex already committed says so). A new app should just take the default.
//
// `opts.passages` is the sidecar of timestamped text hanging off a file —
// subtitle cues, chapter marks, a lecture transcript, a changelog. It's optional
// (an app whose files have no timeline passes null) and its names are on-chain
// too: sond3r pins the "subtitles" spelling throughout.

/** Nest a flat node list into a tree. Each node: { path, name, type:"folder"|
 *  <file type>, parent?, ...extra }. Parent is derived from the path when
 *  omitted. Returns root nodes; folders first, then alpha; children recursively
 *  sorted. */
export function nest(nodes) {
    const byPath = new Map();
    for (const n of nodes) byPath.set(n.path, { ...n, children: [] });
    const roots = [];
    for (const n of byPath.values()) {
        const parent = n.parent != null ? n.parent : n.path.includes("/") ? n.path.slice(0, n.path.lastIndexOf("/")) : "";
        if (parent && byPath.has(parent)) byPath.get(parent).children.push(n);
        else roots.push(n);
    }
    const sort = (arr) => {
        arr.sort((a, b) => (a.type !== b.type ? (a.type === "folder" ? -1 : 1) : a.name.localeCompare(b.name)));
        for (const x of arr) sort(x.children);
    };
    sort(roots);
    return roots;
}

/** The defaults a new app should take as-is. sond3r overrides both — see the
 *  header for why they can never change once something is published. */
export const DEFAULTS = {
    file: "file",
    passages: null,      // or { tag, rel, parentField, idSuffix, field, embedField }
    // Which keys of a node's `published` blob reach the on-chain payload. `null`
    // lifts the whole blob, which is right for a new app — the pointer is opaque
    // to this file and always has been. An app that already has vertices
    // committed pins the list instead, because a key that starts appearing (or
    // stops) changes every payload it publishes from then on.
    pointerFields: null,
};

/** Vertex id for a file's passage list. */
export const passagesId = (path, suffix) => `${path}${suffix}`;

/**
 * A file the publisher has marked NOT for sale (or, in an app with nothing to
 * sell, every file). It still becomes a vertex — named, described, embedded,
 * searchable — but it carries no purchase pointer, so it costs no per-item
 * transaction.
 *
 * This is what makes bulk ingest affordable. `commitStateRoot` is ONE tx for a
 * graph of any size, so a million catalog entries publish for the price of one
 * transaction; only the subset actually for sale pays per item.
 */
export const isCatalogEntry = (n) => n.forSale === false;

/** Does this fs node belong in the published graph at all? */
export const inGraph = (n, { file } = DEFAULTS) => n.type === file && (!!n.published || isCatalogEntry(n));

/** Flat fs nodes → { vertices:[{id,tag,payload}], edges:[{rel,from,to}] }.
 *  Published files and catalog entries become vertices; folders are kept only
 *  if they contain (transitively) one, so a viewer never sees empty folders. */
export function buildTreeGraph(nodes, opts = {}) {
    const { file, passages, pointerFields } = { ...DEFAULTS, ...opts };
    const pointer = (p) => (!pointerFields ? p
        : Object.fromEntries(pointerFields.filter((k) => p[k] !== undefined).map((k) => [k, p[k]])));

    const keep = new Set(); // paths to emit: graph-worthy files + their ancestors
    for (const n of nodes) {
        if (!inGraph(n, { file })) continue;
        keep.add(n.path);
        let p = n.path;
        while (p.includes("/")) { p = p.slice(0, p.lastIndexOf("/")); keep.add(p); }
    }

    const vertices = [];
    const edges = [];
    const parentOf = (path) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

    // Ancestors nobody described. `keep` collects every kept file's folders so the
    // `contains` edges below have somewhere to hang, but vertices are emitted by
    // walking `nodes` — and a caller may hand over a FLAT list of files with no
    // folder entries at all. The browser sends the folders because it has a tree
    // on screen; `scripts/publish.mjs` sends `[{path: "supercuts/x.mp4"}]` and
    // nothing else, and the commit died on the chain SDK's own integrity check:
    //   edge references unknown local id (or invalid CID): test
    // Sorted, so a parent is always emitted before the child that contains it.
    const described = new Set(nodes.map((n) => n.path));
    for (const p of [...keep].filter((x) => !described.has(x)).sort()) {
        vertices.push({ id: p, tag: "folder", payload: { kind: "folder", name: p.slice(p.lastIndexOf("/") + 1), path: p } });
        const up = parentOf(p);
        if (up && keep.has(up)) edges.push({ rel: "contains", from: up, to: p });
    }

    for (const n of nodes) {
        if (!keep.has(n.path)) continue;
        if (n.type === "folder") {
            vertices.push({ id: n.path, tag: "folder", payload: { kind: "folder", name: n.name, path: n.path } });
        } else {
            vertices.push({
                id: n.path, tag: file,
                payload: {
                    // `mime` is what tells a consumer what the bytes actually are.
                    kind: file, name: n.name, path: n.path, mime: n.mime ?? "application/octet-stream",
                    // Semantic content: the publisher's own description, and the
                    // vector for it. Both public by construction — the vector is
                    // derived from text that's already in the clear here, and it's
                    // what lets ANY aggregator bake a searchable shard without
                    // running a model or asking the publisher for anything more.
                    // A catalog entry has ONLY this half, which is the point.
                    ...(n.desc ? { desc: n.desc } : {}),
                    ...(n.embed ? { embed: n.embed } : {}),
                    // Content the publisher doesn't host — a mirror, or an
                    // annotation pointing at the thing it describes. The bytes are
                    // already public, so the pointer IS the url and there's nothing
                    // to mint. Carried here because a vertex that can be found but
                    // not opened is worth very little.
                    ...(n.url ? { url: n.url } : {}),
                    // Whatever the app needs to fetch (and charge for) the bytes.
                    // Absent on a catalog entry — and its absence is the signal,
                    // checked everywhere downstream, so there is no second
                    // "forSale" field to contradict it.
                    ...(n.published ? pointer(n.published) : {}),
                    ...(n.published && n.price != null ? { price: String(n.price) } : {}),
                },
            });
        }
        // Passages are PUBLIC and live in the graph itself, not behind whatever
        // gates the bytes: a sibling vertex of timestamped text, for embedding +
        // semantic search. It deliberately carries the back-pointer field and NO
        // `path`, which is what keeps it out of treeFromGraph's viewer tree.
        const cues = passages && n.type === file ? n[passages.field] : null;
        if (cues?.length) {
            const id = passagesId(n.path, passages.idSuffix);
            // `embed.vecs` is POSITIONAL against the passage list — nothing else
            // binds a vector to its passage. Committing them in the same vertex is
            // what keeps them from drifting apart.
            vertices.push({
                id, tag: passages.tag,
                payload: {
                    kind: passages.tag, [passages.parentField]: n.path, name: n.name,
                    [passages.field]: cues, ...(n[passages.embedField] ? { embed: n[passages.embedField] } : {}),
                },
            });
            edges.push({ rel: passages.rel, from: n.path, to: id });
        }

        const parent = parentOf(n.path);
        if (parent && keep.has(parent)) edges.push({ rel: "contains", from: parent, to: n.path });
    }
    return { vertices, edges };
}

/** Remote graph contents { vertices:[{cid?,payload}] } → nested tree for the
 *  viewer. Rebuilt from each vertex payload's `path` (authoritative), so it
 *  doesn't depend on how edges were serialized. */
export function treeFromGraph(contents) {
    const flat = (contents.vertices ?? [])
        .map((v) => v.payload)
        .filter((p) => p && p.path)
        .map((p) => ({ ...p, type: p.kind })); // kind → type for nest()
    return nest(flat);
}

// ── self-check: fs nodes → graph → tree round-trips structure ─────────────────
// `process` doesn't exist in the browser, and consumers import nest() from here
// to build a viewer tree — so this guard has to survive being evaluated by a
// browser.
if (typeof process !== "undefined" && import.meta.url === `file://${process.argv[1]}` && process.argv[1].endsWith("/graph.js")) {
    // sond3r's pinned names, which is also the case with every option exercised.
    const SOND3R = {
        file: "video",
        pointerFields: ["resourceId", "workerUrl", "plaintextHash", "chunks", "size", "chunkSize"],
        passages: { tag: "subtitles", rel: "subtitles", parentField: "videoPath", idSuffix: "#subtitles", field: "cues", embedField: "cueEmbed" },
    };
    const pub = (resourceId, hash) => ({ resourceId, workerUrl: "w", plaintextHash: hash });
    const nodes = [
        { path: "Show", name: "Show", type: "folder" },
        { path: "Show/S1", name: "S1", type: "folder" },
        { path: "Show/S1/b.mp4", name: "b.mp4", type: "video", mime: "video/mp4", price: "1000", published: pub("0xbb", "0x02"), cues: [{ start: 0, end: 2, text: "four to the floor" }] },
        { path: "Show/S1/a.mp4", name: "a.mp4", type: "video", mime: "video/mp4", price: "1000", published: pub("0xaa", "0x01") },
        { path: "Show/empty", name: "empty", type: "folder" }, // no published file → pruned
        { path: "draft.mp4", name: "draft.mp4", type: "video", price: "1000" }, // unpublished → dropped
    ];
    const g = buildTreeGraph(nodes, SOND3R);
    if (g.vertices.some((v) => v.id === "Show/empty")) throw new Error("empty folder not pruned");
    if (g.vertices.some((v) => v.id === "draft.mp4")) throw new Error("unpublished file not dropped");

    // Catalog entries: in the graph, searchable, carrying NO purchase pointer.
    // This is the bulk-ingest path — a vertex that costs no per-item transaction —
    // so the thing to guard is that it never looks buyable to anything downstream.
    const withEntry = buildTreeGraph([
        ...nodes,
        { path: "Papers", name: "Papers", type: "folder" },
        { path: "Papers/abstract.txt", name: "abstract.txt", type: "video", mime: "text/plain", price: "1000", forSale: false, desc: "on umwelt", embed: { model: "m", dim: 256, vec: "AA==" }, url: "https://archive.org/download/x/y.pdf" },
    ], SOND3R);
    const entry = withEntry.vertices.find((v) => v.id === "Papers/abstract.txt");
    if (!entry) throw new Error("catalog entry dropped from the graph");
    if (entry.payload.desc !== "on umwelt" || entry.payload.embed?.vec !== "AA==") throw new Error("a catalog entry must keep the semantic half — it is the only half it has");
    if ("resourceId" in entry.payload) throw new Error("a catalog entry must carry no resourceId — that is what makes it free to publish");
    if ("price" in entry.payload) throw new Error("a price with nothing to buy is a lie");
    if (entry.payload.url !== "https://archive.org/download/x/y.pdf") throw new Error("free content's url lost — the entry is findable but unplayable without it");
    if (!withEntry.vertices.some((v) => v.id === "Papers")) throw new Error("a folder holding only catalog entries was pruned");
    if (!withEntry.edges.some((e) => e.rel === "contains" && e.from === "Papers" && e.to === "Papers/abstract.txt")) throw new Error("catalog entry not linked to its folder");
    if (withEntry.vertices.some((v) => v.id === "draft.mp4")) throw new Error("forSale defaulting changed — staged files must stay private");

    const contents = { vertices: g.vertices.map((v) => ({ payload: v.payload })) };
    const tree = treeFromGraph(contents);
    const s1 = tree[0].children.find((c) => c.name === "S1");
    if (tree[0].name !== "Show" || !s1) throw new Error("structure lost");
    if (s1.children.map((c) => c.name).join(",") !== "a.mp4,b.mp4") throw new Error("files not sorted/nested");
    if (s1.children[0].resourceId !== "0xaa") throw new Error("file pointer lost");

    // Passages become their own vertex, reachable from the file, and must NOT show
    // up as a phantom entry in the viewer's folder tree.
    const subs = g.vertices.find((v) => v.id === passagesId("Show/S1/b.mp4", "#subtitles"));
    if (!subs || subs.payload.cues[0].text !== "four to the floor") throw new Error("passages lost");
    if (subs.payload.videoPath !== "Show/S1/b.mp4") throw new Error("back-pointer lost — the passages belong to no file");
    if (!g.edges.some((e) => e.rel === "subtitles" && e.from === "Show/S1/b.mp4" && e.to === subs.id)) throw new Error("file→passages edge missing");
    if (s1.children.length !== 2) throw new Error("passages vertex leaked into the tree");

    // Semantic content rides into the graph: the description on the file vertex,
    // the vectors alongside the passages that produced them. Absent when not
    // supplied — an undefined `embed` key would serialize into every payload.
    const withMeta = buildTreeGraph(nodes.map((n) => (n.path === "Show/S1/b.mp4"
        ? { ...n, desc: "deep spanish house", embed: { model: "m", dim: 256, vec: "AA==" }, cueEmbed: { model: "m", dim: 256, vecs: ["AA=="] } }
        : n)), SOND3R);
    const b = withMeta.vertices.find((v) => v.id === "Show/S1/b.mp4").payload;
    if (b.desc !== "deep spanish house") throw new Error("description lost on the way to the graph");
    if (b.embed?.vec !== "AA==") throw new Error("file vector lost on the way to the graph");
    const bs = withMeta.vertices.find((v) => v.id === passagesId("Show/S1/b.mp4", "#subtitles")).payload;
    if (bs.embed?.vecs?.[0] !== "AA==") throw new Error("passage vectors lost on the way to the graph");
    const a = withMeta.vertices.find((v) => v.id === "Show/S1/a.mp4").payload;
    if ("desc" in a || "embed" in a) throw new Error("empty semantic fields must be omitted, not serialized");

    // A pinned pointer list drops everything else, so a field added upstream (the
    // relay stamps `enc` and `mime` onto `published`) cannot silently start
    // appearing in committed payloads.
    const stamped = buildTreeGraph([{ path: "x.mp4", name: "x.mp4", type: "video", price: "1", published: { ...pub("0xcc", "0x03"), chunks: 2, size: 9, chunkSize: 4, enc: "v2", mime: "video/mp4" } }], SOND3R);
    const xp = stamped.vertices[0].payload;
    if ("enc" in xp) throw new Error("an unlisted pointer field reached the payload");
    if (xp.chunks !== 2 || xp.chunkSize !== 4 || xp.size !== 9) throw new Error("chunk geometry lost — a buyer cannot reassemble the file");
    // …and with no pin, the blob is opaque and passes through whole.
    const loose = buildTreeGraph([{ path: "n.md", name: "n.md", type: "file", forSale: false, published: { at: "ipfs://x" } }]);
    if (loose.vertices[0].payload.at !== "ipfs://x") throw new Error("an unpinned pointer must pass through whole");

    // ── and the same tree under the defaults a new app takes ────────────────
    // The whole reason this file is parameterized: an app with no sale and no
    // timeline gets vertices with no app-specific spelling anywhere in them.
    const wiki = buildTreeGraph([
        { path: "notes", name: "notes", type: "folder" },
        { path: "notes/umwelt.md", name: "umwelt.md", type: "file", mime: "text/markdown", forSale: false, desc: "on umwelt", cues: [{ start: 0, text: "ignored" }] },
    ]);
    const note = wiki.vertices.find((v) => v.id === "notes/umwelt.md");
    if (note.tag !== "file" || note.payload.kind !== "file") throw new Error("default tag must be `file`, not an app's spelling");
    if (wiki.vertices.some((v) => v.tag === "subtitles" || v.id.includes("#"))) throw new Error("passages: null must emit no sidecar, even when the node carries cues");
    if (buildTreeGraph(nodes).vertices.length) throw new Error("sond3r's `video` nodes must not publish under the default file type");

        // A FLAT file list — no folder nodes at all, which is what a headless
    // publisher sends. Every `contains` edge must land on a vertex that exists,
    // because the chain SDK rejects the commit otherwise and does it AFTER the
    // bytes have been encrypted, uploaded and paid for in bandwidth.
    {
        const g = buildTreeGraph([
            { path: "supercuts/a.mp4", name: "a.mp4", type: "video", desc: "x", published: pub("0xaa", "0x01") },
            { path: "deep/nest/b.mp4", name: "b.mp4", type: "video", desc: "y", forSale: false },
        ], SOND3R);
        const ids = new Set(g.vertices.map((v) => v.id));
        for (const e of g.edges) {
            if (!ids.has(e.from)) throw new Error(`edge from a vertex that was never emitted: ${e.from}`);
            if (e.rel === "contains" && !ids.has(e.to)) throw new Error(`contains edge to nothing: ${e.to}`);
        }
        for (const f of ["supercuts", "deep", "deep/nest"]) {
            if (!ids.has(f)) throw new Error(`ancestor ${f} must be emitted as a folder vertex`);
        }
        if (!g.edges.some((e) => e.rel === "contains" && e.from === "deep" && e.to === "deep/nest")) {
            throw new Error("a synthesized folder must be contained by its own parent");
        }
        const order = g.vertices.map((v) => v.id);
        if (order.indexOf("deep") > order.indexOf("deep/nest")) throw new Error("a parent must be emitted before its child");
        // A caller that DOES describe its folders must not get them twice.
        const both = buildTreeGraph([
            { path: "Show", name: "Show", type: "folder" },
            { path: "Show/b.mp4", name: "b.mp4", type: "video", desc: "z", forSale: false },
        ], SOND3R);
        if (both.vertices.filter((v) => v.id === "Show").length !== 1) throw new Error("a described folder must not be duplicated");
    }

    console.log("graph.js self-check ok — sond3r's pinned names, passages vertex + edge + tree exclusion, catalog entries carry no pointer, a flat file list still gets its folder vertices, defaults stay app-neutral");
}
