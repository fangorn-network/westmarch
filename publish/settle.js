// Encrypting a file into the access worker, from Node.
//
// This is the publisher's byte path, and it is the half of publishing that no
// relay can do for you: the DEK is generated here, sealed to the worker's public
// key here, and the plaintext never leaves the machine that owns it. A relay
// that offered to do this step would be a relay that had your file.
//
// The browser has its own copy of this walk (an app's own encrypt.js, over
// File.slice instead of fs.read). They must agree byte for byte — they share
// `pack`, `aadFor` and `chunkKey` from envelope.js precisely so that the only
// thing that differs between them is how bytes are read off a disk.
import { open } from "node:fs/promises";
import { createHash } from "node:crypto";
import { seal } from "@fangorn-network/sdk";
import { bytesToHex } from "viem";
import {
    CHUNK_SIZE, NONCE_LEN, aadFor, chunkKey, deleteResource,
    getWorkerPubkey, pack, putChunk, unpack,
} from "./envelope.js";

export { CHUNK_SIZE, aadFor, chunkKey, deleteResource, getWorkerPubkey };

/**
 * Envelope-encrypt the file at `file` chunk by chunk and upload each
 * {ciphertext, sealed DEK} to the access worker's R2. Reads one chunk at a time,
 * so peak memory is ~2x chunkSize no matter how big the file is.
 *
 * @returns { plaintextHash, chunks, size, chunkSize } — the hash to commit
 *          on-chain, the chunk count the buyer reassembles, and the plaintext
 *          byte geometry a streaming player needs to map a Range request onto a
 *          chunk (chunk i starts at i * chunkSize).
 */
export async function encryptAndUpload({ file, resourceId, workerUrl, uploadToken, chunkSize = CHUNK_SIZE, onProgress }) {
    const dek = crypto.getRandomValues(new Uint8Array(32));
    const aesKey = await crypto.subtle.importKey("raw", dek, "AES-GCM", false, ["encrypt"]);
    const sealedDek = bytesToHex(seal(dek, await getWorkerPubkey(workerUrl), resourceId));

    const fh = await open(file, "r");
    try {
        const { size } = await fh.stat();
        const chunks = Math.max(1, Math.ceil(size / chunkSize));
        const hash = createHash("sha256");
        const buf = Buffer.allocUnsafe(Math.min(size, chunkSize) || 1);

        for (let i = 0; i < chunks; i++) {
            const { bytesRead } = await fh.read(buf, 0, buf.length, i * chunkSize);
            const plain = buf.subarray(0, bytesRead);
            hash.update(plain);

            const nonce = crypto.getRandomValues(new Uint8Array(NONCE_LEN));
            const aesCt = new Uint8Array(
                await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: aadFor(i) }, aesKey, await pack(plain)),
            );
            const body = new Uint8Array(NONCE_LEN + aesCt.length);
            body.set(nonce, 0);
            body.set(aesCt, NONCE_LEN);

            await putChunk({ workerUrl, uploadToken, key: chunkKey(resourceId, i), body, sealedDek });
            onProgress?.(i + 1, chunks);
        }
        return { plaintextHash: `0x${hash.digest("hex")}`, chunks, size, chunkSize };
    } finally {
        await fh.close();
    }
}

// ── self-check: `node publish/settle.js` — no network, no worker ─────────────
//
// It decrypts with bare AES-GCM rather than importing a buyer, because what is
// under test here is the ENCRYPTOR: chunk addressing, the AAD index binding, the
// ragged tail, and that pack/unpack round trip. An app's full publisher→buyer
// round trip belongs in that app, against its own buyer.
if (import.meta.url === `file://${process.argv[1]}` && process.argv[1].endsWith("/settle.js")) {
    const { writeFileSync, rmSync } = await import("node:fs");
    const { unseal } = await import("@fangorn-network/sdk");
    const { x25519 } = await import("@noble/curves/ed25519");
    const { hexToBytes, keccak256 } = await import("viem");

    const CHUNK = 1000;
    const tmp = `/tmp/westmarch-settle-${process.pid}.bin`;
    const workerSecret = crypto.getRandomValues(new Uint8Array(32));
    const workerPubkey = x25519.getPublicKey(workerSecret);
    const r2 = new Map();
    let sealedSeen = null;
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
        const u = String(url);
        if (u.endsWith("/pubkey")) return { ok: true, json: async () => ({ pubkey: bytesToHex(workerPubkey) }) };
        if (u.includes("/upload/")) {
            const key = u.split("/upload/")[1];
            if (init.method === "DELETE") return r2.delete(key), { ok: true };
            sealedSeen = init.headers["X-Sealed-Dek"];
            r2.set(key, new Uint8Array(init.body));
            return { ok: true };
        }
        return { ok: false, status: 404 };
    };

    const rid = keccak256(new Uint8Array([1]));
    /** Decrypt one stored chunk the way any buyer must. */
    const read = async (i) => {
        const dek = unseal(hexToBytes(sealedSeen), workerSecret, rid);
        const key = await crypto.subtle.importKey("raw", dek, "AES-GCM", false, ["decrypt"]);
        const body = r2.get(chunkKey(rid, i));
        return unpack(new Uint8Array(await crypto.subtle.decrypt(
            { name: "AES-GCM", iv: body.subarray(0, NONCE_LEN), additionalData: aadFor(i) },
            key, body.subarray(NONCE_LEN),
        )));
    };
    const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

    try {
        // Random bytes: 2.5 chunks → a ragged tail, and gzip must LOSE, so these
        // exercise pack()'s store-raw branch.
        const bytes = crypto.getRandomValues(new Uint8Array(2500));
        writeFileSync(tmp, bytes);
        const out = await encryptAndUpload({ file: tmp, resourceId: rid, workerUrl: "http://stub", chunkSize: CHUNK });
        if (out.chunks !== 3) throw new Error(`chunk count: got ${out.chunks}, want 3`);
        if (out.plaintextHash !== `0x${createHash("sha256").update(bytes).digest("hex")}`) throw new Error("streamed hash != whole-file sha256");
        if (!r2.has(rid)) throw new Error("chunk 0 must land on the resourceId — that is where /access looks");
        if (r2.size !== 3) throw new Error(`chunk keys collide: ${r2.size} objects for 3 chunks`);
        // nonce(12) + flag(1) + ct(500) + tag(16)
        if (r2.get(chunkKey(rid, 2)).length !== 12 + 1 + 500 + 16) throw new Error("ragged last chunk is the wrong size");

        const back = new Uint8Array([...await read(0), ...await read(1), ...await read(2)]);
        if (!same(back, bytes)) throw new Error("round trip corrupted the file");

        // AAD binds each chunk to its index: a chunk decrypted at the wrong index
        // must FAIL, not silently hand back scrambled bytes.
        let swallowed = false;
        try {
            const dek = unseal(hexToBytes(sealedSeen), workerSecret, rid);
            const key = await crypto.subtle.importKey("raw", dek, "AES-GCM", false, ["decrypt"]);
            const body = r2.get(chunkKey(rid, 0));
            await crypto.subtle.decrypt({ name: "AES-GCM", iv: body.subarray(0, NONCE_LEN), additionalData: aadFor(1) }, key, body.subarray(NONCE_LEN));
            swallowed = true;
        } catch { /* expected */ }
        if (swallowed) throw new Error("a chunk decrypted under the wrong index — AAD binding is broken");

        // Compressible payload: pack()'s other branch. Stored bytes must come in
        // well under the plaintext and still round trip.
        r2.clear();
        const text = new Uint8Array(3000).fill(65);
        writeFileSync(tmp, text);
        const packed = await encryptAndUpload({ file: tmp, resourceId: rid, workerUrl: "http://stub", chunkSize: CHUNK });
        const stored = [...r2.values()].reduce((n, b) => n + b.length, 0);
        if (stored > text.length / 2) throw new Error(`compressible payload barely shrank: ${stored} of ${text.length}`);
        const gzBack = new Uint8Array([...await read(0), ...await read(1), ...await read(2)]);
        if (!same(gzBack, text)) throw new Error("gzip round trip corrupted the file");

        // Delete frees every chunk, and a worker that refuses RAISES rather than
        // reporting freed space the operator is still billed for.
        if (await deleteResource({ workerUrl: "http://stub", uploadToken: "t", resourceId: rid, chunks: packed.chunks }) !== packed.chunks) throw new Error("deleteResource miscounted");
        if (r2.size !== 0) throw new Error(`delete left ${r2.size} chunk(s) behind`);
        globalThis.fetch = async () => ({ ok: false, status: 401, statusText: "Unauthorized" });
        let quiet = false;
        try { await deleteResource({ workerUrl: "http://stub", resourceId: rid, chunks: 2 }); quiet = true; } catch { /* expected */ }
        if (quiet) throw new Error("a refused delete was swallowed — the ledger would free bytes still in R2");

        console.log(`settle.js self-check ok — round trip, hash, ragged tail, AAD index binding, gzip ${stored}/${text.length} bytes, delete`);
    } finally {
        globalThis.fetch = realFetch;
        rmSync(tmp, { force: true });
    }
}
