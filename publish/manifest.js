// The publisher's working library, kept in their own bucket.
//
// It records what a relay must never hold: the per-file price, description, and
// the stable `uid` that keeps a file's PAID identity across a rename. Storing it
// in the bucket rather than on the relay is what lets a library follow its
// publisher between machines, and what stops the relay from being the thing that
// remembers who sells what.
//
// It is a CACHE of something already public — the commit graph carries every
// published file's path, price, description and pointer — so an empty bucket is
// recoverable (`manifestFromTree`) rather than fatal.
//
// `ns` is the app's namespace and is NOT defaulted, for the same reason
// envelope.js refuses to default it: the key is derived from it, so a changed ns
// silently addresses a DIFFERENT manifest and the next publish re-mints every
// uid in a library that looks empty.
import { keccak256, stringToBytes } from "viem";
import { putChunk } from "./envelope.js";

/** R2 key for `owner`'s manifest under app `ns`. A bytes32, because that is the
 *  only key shape the worker accepts — see isObjectKey. */
export const manifestKey = (ns, owner) => keccak256(stringToBytes(`${ns}:manifest:${owner.toLowerCase()}`));

// A FUNCTION, not a constant. `{ ...EMPTY }` is a shallow copy — every caller
// would share one `files` object, so in any process that serves more than one
// publisher a first-publish read hands back the previous publisher's staged
// entries and the next write commits them to the wrong library.
const empty = () => ({ files: {} });

/** Read `owner`'s manifest back. A worker that has never seen one answers 404,
 *  which is the ordinary first-publish state, not an error. */
export async function readManifest({ ns, workerUrl, uploadToken, owner }) {
    const res = await fetch(`${workerUrl}/upload/${manifestKey(ns, owner)}`, {
        headers: uploadToken ? { Authorization: `Bearer ${uploadToken}` } : {},
    });
    if (res.status === 404) return empty();
    if (!res.ok) throw new Error(`could not read your library manifest from ${workerUrl}: ${res.status} ${await res.text()}`);
    try {
        return JSON.parse(new TextDecoder().decode(await res.arrayBuffer()));
    } catch {
        // Better to say so than to hand back an empty manifest, which would look
        // like an empty library and re-mint every uid on the next publish.
        throw new Error(`your library manifest at ${workerUrl} is corrupt — it did not parse as JSON`);
    }
}

export async function writeManifest({ ns, workerUrl, uploadToken, owner, manifest }) {
    await putChunk({
        workerUrl, uploadToken, key: manifestKey(ns, owner),
        body: new TextEncoder().encode(JSON.stringify(manifest, null, 2)),
    });
    return manifest;
}

export const newUid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/**
 * Rebuild manifest entries from a publisher's own on-chain library tree.
 *
 * Two things it deliberately does not recover:
 *  - `uid`. resourceId is keccak(owner ++ keccak(ns+":"+uid)), which is one-way.
 *    It does not matter: identity is carried by `published.resourceId`, and every
 *    path that could re-derive an id prefers the recorded one. So a fresh uid on
 *    a recovered entry never changes what a buyer already paid for.
 *  - Unpublished files. They were never on-chain.
 */
export function manifestFromTree(files, { defaultPrice = "1000", newUid: uid = newUid } = {}) {
    const out = {};
    for (const n of files ?? []) {
        if (!n?.path) continue;
        out[n.path] = {
            uid: uid(),
            ...(n.mime ? { mime: n.mime } : {}),
            ...(n.desc ? { desc: n.desc } : {}),
            price: String(n.price ?? defaultPrice),
            // No resourceId in the payload means a free catalog entry — that
            // absence is the signal everywhere downstream, so it round-trips as
            // `forSale: false` rather than as a price with nothing to buy.
            ...(n.resourceId
                ? {
                    published: {
                        resourceId: n.resourceId, workerUrl: n.workerUrl, plaintextHash: n.plaintextHash,
                        chunks: n.chunks ?? 1, size: n.size, chunkSize: n.chunkSize, mime: n.mime,
                    },
                }
                : { forSale: false }),
        };
    }
    return out;
}

// ── self-check: `node publish/manifest.js` ───────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
    const assert = (c, m) => { if (!c) throw new Error(m); };

    // PINNED. sond3r's manifests are already in R2 under this exact key; if this
    // value moves, every existing publisher's library reads back as empty and the
    // next publish re-mints every uid they own.
    const owner = "0x147c24c5Ea2f1EE1ac42AD16820De23bBba45Ef6";
    assert(manifestKey("sond3r", owner) === keccak256(stringToBytes(`sond3r:manifest:${owner.toLowerCase()}`)),
        "the sond3r manifest key must not move");
    assert(manifestKey("sond3r", owner) === manifestKey("sond3r", owner.toLowerCase()),
        "address casing is not identity");
    assert(manifestKey("sond3r", owner) !== manifestKey("other", owner),
        "two apps must not share one manifest key");

    // A 404 is the first-publish state, and it must not be confused with a read
    // that failed — one returns an empty library, the other has to raise.
    const real = globalThis.fetch;
    try {
        globalThis.fetch = async () => ({ status: 404 });
        assert((await readManifest({ ns: "x", workerUrl: "http://w", owner })).files &&
            Object.keys((await readManifest({ ns: "x", workerUrl: "http://w", owner })).files).length === 0,
            "404 is an empty library");
        globalThis.fetch = async () => ({ status: 500, ok: false, text: async () => "boom" });
        await readManifest({ ns: "x", workerUrl: "http://w", owner }).then(
            () => { throw new Error("a failed read must raise, not look empty"); },
            (e) => assert(/could not read/.test(e.message), e.message));
        globalThis.fetch = async () => ({ status: 200, ok: true, arrayBuffer: async () => new TextEncoder().encode("{not json").buffer });
        await readManifest({ ns: "x", workerUrl: "http://w", owner }).then(
            () => { throw new Error("corrupt JSON must raise — an empty manifest re-mints every uid"); },
            (e) => assert(/corrupt/.test(e.message), e.message));

        // The empty read must not be a shared object two callers can edit.
        globalThis.fetch = async () => ({ status: 404 });
        const a = await readManifest({ ns: "x", workerUrl: "http://w", owner });
        a.files.poisoned = true;
        assert(!(await readManifest({ ns: "x", workerUrl: "http://w", owner })).files.poisoned,
            "the empty manifest must be a fresh object");
    } finally { globalThis.fetch = real; }

    // A tree with no resourceId is a free catalog entry, not a price with
    // nothing behind it.
    const built = manifestFromTree(
        [{ path: "a.mp4", resourceId: "0xabc", chunks: 2, price: 500 }, { path: "b.txt" }, { bad: 1 }],
        { newUid: () => "uid" });
    assert(Object.keys(built).length === 2, "a node with no path is not a file");
    assert(built["a.mp4"].published.resourceId === "0xabc" && built["a.mp4"].price === "500", "a sold file keeps its pointer");
    assert(built["b.txt"].forSale === false && !built["b.txt"].published, "no resourceId means a free catalog entry");

    console.log("manifest.js self-check ok — key pinned + ns-scoped, 404 vs failure, corrupt read raises, free entries");
}
