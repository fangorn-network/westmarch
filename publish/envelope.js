// The on-the-wire envelope format, shared by everything that writes it.
//
// `ns` — the app's namespace string — is the first argument of the two id
// derivations and it is NOT defaulted. It is folded into every resourceId ever
// minted, so it is permanent: changing an app's ns orphans everything that app
// already published, and two apps that accidentally share one mint into each
// other's id space. An app pins it once (sond3r: src/pay/envelope.js) and never
// again. A default here would be a way to pick it by accident.
//
// Three implementations used to need these constants to agree — server/settle.js
// (relay-side publish), src/pay/encrypt.js (browser-side publish) and src/pay/stream.js /
// src/pay/buy.js (the buyer, unpacking). They agree because they import from here.
// A mismatch is not a crash: chunk `i` decrypts to garbage, or a key lands where
// the worker's /access gate isn't looking, and the file goes dark for everyone
// who paid for it.
//
// Browser-safe on purpose: viem only, no node builtins.
import { concat, encodePacked, hexToBytes, keccak256, numberToHex, stringToBytes } from "viem";

/** The bytes32 the publisher hands createResource. Stable per manifest uid. */
export const uidHashFor = (ns, uid) => keccak256(stringToBytes(`${ns}:${uid}`));

/** What that uid becomes on-chain: keccak(publisher ++ uid), derived by the
 *  registry (`resource_id_of`) and reproduced here. Two publishers with the same
 *  uid get two different resources, which is what makes an id impossible to
 *  squat — and it means this derivation must match the contract exactly, or a
 *  publish uploads ciphertext to a key no on-chain resource points at.
 *
 *  It lives here rather than in server/index.js because the BROWSER derives it
 *  too now (it names the R2 key it uploads ciphertext to) and the server derives
 *  it when minting the resource. Two copies that disagreed would put the bytes
 *  and the resource at different ids, and the file would be unbuyable. Pinned
 *  against the registry's own view in sond3r's server/index.js --selfcheck. */
export const resourceIdFor = (ns, owner, uid) => keccak256(concat([owner, uidHashFor(ns, uid)]));

export const NONCE_LEN = 12;

/** 64MiB — under Cloudflare's 100MB body cap with room for nonce/tag/headers. */
export const CHUNK_SIZE = 64 * 1024 * 1024;

/** R2 key for chunk `i`. Chunk 0 is the resourceId itself, so the sealed DEK
 *  lands exactly where the worker's /access gate looks for it and a small file
 *  is still a single object. Every buyer-side unpacker must match this. */
export const chunkKey = (resourceId, i) =>
    i === 0 ? resourceId : keccak256(encodePacked(["bytes32", "uint32"], [resourceId, i]));

/** AES-GCM additional data: the chunk index, big-endian. MUST match src/pay/buy.js. */
export const aadFor = (i) => hexToBytes(numberToHex(i, { size: 4 }));

/**
 * Compress-then-encrypt: what gets sealed is `flag(1) || bytes`, flag 1 = gzip.
 * ponytail: gzip only when it actually shrinks. mp4/webm/jpeg are already
 * compressed and gzip *grows* them, so the flag makes the store-raw case the
 * fallback instead of a 0.03% tax. MUST match unpack() in src/pay/stream.js.
 */
export async function pack(plain) {
    const gz = new Uint8Array(await new Response(
        new Response(plain).body.pipeThrough(new CompressionStream("gzip")),
    ).arrayBuffer());
    const win = gz.length < plain.length;
    const out = new Uint8Array((win ? gz.length : plain.length) + 1);
    out[0] = win ? 1 : 0;
    out.set(win ? gz : plain, 1);
    return out;
}

/** GET the worker's static X25519 pubkey (what DEKs are sealed to). */
export async function getWorkerPubkey(workerUrl) {
    const res = await fetch(`${workerUrl}/pubkey`);
    if (!res.ok) throw new Error(`/pubkey failed: ${res.status}`);
    const { pubkey } = await res.json();
    return hexToBytes(pubkey);
}

/**
 * POST one already-encrypted chunk to the access worker's R2.
 *
 * `sealedDek` is omitted for objects that are the publisher's own state rather
 * than something a buyer will pay for — the worker then writes no DEK object, so
 * /access has nothing to release. See handleUpload in the worker.
 */
export async function putChunk({ workerUrl, uploadToken, key, body, sealedDek, immutable = false }) {
    const res = await fetch(`${workerUrl}/upload/${key}`, {
        method: "POST",
        headers: {
            "Content-Type": "application/octet-stream",
            ...(sealedDek ? { "X-Sealed-Dek": sealedDek } : {}),
            // Only for a key that IS its content's digest. A resourceId is derived
            // from (publisher, uid), so a re-publish rewrites it with new bytes
            // under a new DEK, and an edge still serving the old ones hands every
            // buyer ciphertext that decrypts to garbage. A shard named by its own
            // sha256 cannot have that problem, and is the reason this flag exists.
            ...(immutable ? { "X-Immutable": "1" } : {}),
            // The worker's upload gate. On a fresh publisher-owned worker the
            // first request carrying this claims the bucket to it.
            ...(uploadToken ? { Authorization: `Bearer ${uploadToken}` } : {}),
        },
        body,
    });
    if (!res.ok) {
        const text = await res.text();
        // A quota refusal is the one upload failure a publisher can act on, so its
        // message is passed through instead of buried in a URL and a status code.
        const reason = (() => { try { return JSON.parse(text).error; } catch { return null; } })();
        throw new Error(res.status === 413 && reason ? reason : `${workerUrl}/upload/${key}: ${res.status} ${text}`);
    }
    return res;
}

/**
 * Delete every chunk of a published resource, and its sealed DEK, from the
 * worker. Returns the number of chunks it asked the worker to drop.
 *
 * The chunk count comes from the caller's manifest rather than from the worker,
 * because the worker deliberately won't synthesize keys (see handleDelete in
 * webworker/fangorn-access-worker) — the key derivation lives here, next to the
 * upload that used it.
 *
 * Failures are RAISED, not swallowed. A delete that half-worked must not be
 * reported as freed space: the operator is still paying for whatever is left,
 * and silently crediting the publisher for it is how the storage ledger drifts
 * away from the R2 bill.
 */
export async function deleteResource({ workerUrl, uploadToken, resourceId, chunks = 1 }) {
    for (let i = 0; i < Math.max(1, chunks); i++) {
        const res = await fetch(`${workerUrl}/upload/${chunkKey(resourceId, i)}`, {
            method: "DELETE",
            headers: uploadToken ? { Authorization: `Bearer ${uploadToken}` } : {},
        });
        // 404 is a worker too old to have the route; that's a real failure, since
        // nothing was deleted and the caller is about to free the allowance.
        if (!res.ok) throw new Error(`${workerUrl} refused to delete chunk ${i} of ${resourceId}: ${res.status} ${res.statusText}`);
    }
    return Math.max(1, chunks);
}

// ── self-check: `node publish/envelope.js` ───────────────────────────────────
//
// These vectors are PINNED to the values sond3r's own envelope.js produced before
// this file was extracted from it, with ns = "sond3r". They are not a style test:
// every resourceId ever minted by fangorn.tv is derived by this function, and a
// change here that shifts one byte makes ciphertext already in R2 unreachable from
// the resource anyone paid for. If this fails, the extraction broke money.
if (typeof process !== "undefined" && import.meta.url === `file://${process.argv[1]}`) {
    const owner = `0x${"11".repeat(20)}`;
    const uid = "Show/S1/a.mp4";

    const h = uidHashFor("sond3r", uid);
    if (h !== "0x855b20df257479ad7d5d5be0bcddc8c8554bff19edb33adb818872dd3d9e0d04") {
        throw new Error(`uidHashFor drifted: ${h}`);
    }
    const r = resourceIdFor("sond3r", owner, uid);
    if (r !== "0x0f919abdf691fae94b36395e67f7ed3301f0faea6027ffe609612656556a28a5") {
        throw new Error(`resourceIdFor drifted: ${r}`);
    }

    // The namespace is what separates two apps' id spaces. Same owner, same uid,
    // different app → different resource, or one app could mint over another's.
    if (resourceIdFor("wiki", owner, uid) === r) throw new Error("ns does not reach the resourceId");
    if (uidHashFor("wiki", uid) === h) throw new Error("ns does not reach the uid hash");

    // Chunk 0 IS the resourceId — the worker's /access gate looks for the sealed
    // DEK there and nowhere else.
    if (chunkKey(r, 0) !== r) throw new Error("chunk 0 must be the resourceId itself");
    if (chunkKey(r, 1) === r) throw new Error("chunk 1 collided with chunk 0");
    if (aadFor(1).length !== 4) throw new Error("aad must be 4 bytes, big-endian");

    console.log("envelope.js self-check ok — pinned sond3r ids, ns separation, chunk keys");
}
