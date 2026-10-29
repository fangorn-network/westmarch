// The network's one embedding model, on both sides of every search. The query
// vector MUST come out of the same model, prompt and post-processing as the
// document vectors in the shard, or cosine is meaningless.
//
// EmbeddingGemma-300m, asymmetric by prompt (QUERY / DOCUMENT below), truncated
// to 256 dims (it is Matryoshka-trained) and L2-normalized. Two runtimes run it:
//   - a Fangorn app's Worker (Workers AI `@cf/google/embeddinggemma-300m`), the
//     free tier's indexer (site/worker.js), on the document side;
//   - transformers.js here, in a reader's tab or a Node publisher, on either side.
// They agree closely but not bit for bit, so a view names its `embedder` and is only
// ever appended to by the runtime that made it (view.js).
//
// transformers.js is dynamically imported so its runtime stays out of the main
// bundle and a load failure degrades to lexical search instead of breaking the app.

const MODEL = "google/embeddinggemma-300m";
const ONNX = "onnx-community/embeddinggemma-300m-ONNX";
const DIM = 256;
/** The model card's retrieval prompts. Exported so every runtime uses the same text. */
export const QUERY = "task: search result | query: ";
export const DOCUMENT = "title: none | text: ";
// The document side's precision in transformers.js. q8 by default (the browser's queries are q8).
// EmbeddingGemma's activations do not survive fp16; WESTMARCH_EMBED_DTYPE=fp32 is the slow exact one.
const DTYPE = globalThis.process?.env?.WESTMARCH_EMBED_DTYPE ?? "q8";
export const EMBED_DTYPE = DTYPE;

// Stamped onto every view. Vectors from different models (or dims) are not
// comparable — cosine between them is noise, and silently so.
export const EMBED_MODEL = MODEL;
export const EMBED_DIM = DIM;
/** A short name for the space a taste or a reaction lives in. */
export const SPACE = `embeddinggemma-${DIM}`;

let _model = null, _progress = null;
/** Hear the model download: transformers.js's own events ({status, file, loaded, total}), on
 *  the thread that loads it (the page's own worker, when it calls the *Direct functions). */
export const onModelProgress = (f) => { _progress = f; };
const model = () => (_model ??= (async () => {
    const { AutoModel, AutoTokenizer } = await import("@huggingface/transformers");
    // WESTMARCH_EMBED_DEVICE=cuda puts a Node publisher's document side on a GPU.
    const device = globalThis.process?.env?.WESTMARCH_EMBED_DEVICE;
    const progress_callback = (p) => _progress?.(p);
    const [tokenizer, m] = await Promise.all([AutoTokenizer.from_pretrained(ONNX, { progress_callback }),
        AutoModel.from_pretrained(ONNX, { dtype: DTYPE, progress_callback, ...(device && { device }) })]);
    // `sentence_embedding`, not mean pooling: the model's dense head runs after the pool.
    return async (texts) => {
        const { sentence_embedding: e } = await m(await tokenizer(texts, { padding: true, truncation: true }));
        const d = e.dims.at(-1);
        return texts.map((_, j) => matryoshka(e.data.slice(j * d, (j + 1) * d)));
    };
})());

/** Truncate to `dim` and L2-normalize: EmbeddingGemma's Matryoshka truncation. */
export function matryoshka(vec, dim = DIM) {
    const out = Array.from(vec.slice(0, dim), Number);
    let norm = 0;
    for (const x of out) norm += x * x;
    norm = Math.sqrt(norm);
    if (norm) for (let i = 0; i < out.length; i++) out[i] /= norm;
    return out;
}

/** Free text → 256-d L2-normalized vector. Throws if the model can't load —
 *  callers fall back to lexical. First call downloads the model (slow). */
export async function embedQueryDirect(text) {
    const [v] = await (await model())([QUERY + text]);
    return v;
}

/** One document, in-process. Calls made together are embedded as one batch (a GPU's
 *  speed); q8 stays at batch 1, since batching moves its activation quantization. */
export function embedDocumentDirect(text) {
    return new Promise((resolve, reject) => {
        pending.push({ text, resolve, reject });
        if (pending.length === 1) setTimeout(flushDocuments, 0);
    });
}
const BATCH = DTYPE === "q8" ? 1 : 32;
let pending = [];
async function flushDocuments() {
    const all = pending;
    pending = [];
    try {
        const vs = await embedRaw(all.map((p) => DOCUMENT + p.text));
        all.forEach((p, j) => p.resolve(vs[j]));
    } catch (e) {
        for (const p of all) p.reject(e);
    }
}

/** Texts that already carry their prompt → vectors, in-process: a stand-in for the Worker's AI binding (devnet.js). */
export async function embedRaw(texts) {
    const run = await model(), out = [];
    for (let i = 0; i < texts.length; i += BATCH) out.push(...await run(texts.slice(i, i + BATCH)));
    return out;
}

/** Load the model in-process, and settle when it is actually ready. */
export const warmDirect = () => model().then(() => {});

// ── off the main thread ──────────────────────────────────────────────────────
//
// The public API below is unchanged, so no caller knows where the work happens.
// In a browser it happens in embed.worker.js; in Node (the publish script, the
// self-checks) and inside the worker itself there is no Worker to spawn, so it
// runs in-process. `window`, not `Worker`: a worker context HAS Worker and would
// otherwise spawn a worker per query, forever.
const offThread = () => typeof window !== "undefined" && typeof Worker !== "undefined";

let _w = null, _seq = 0;
const _pending = new Map();

function hub() {
    if (_w) return _w;
    _w = new Worker(new URL("./embed.worker.js", import.meta.url), { type: "module" });
    _w.onmessage = ({ data }) => {
        const job = _pending.get(data.id);
        if (!job) return;
        _pending.delete(data.id);
        data.error ? job.reject(new Error(data.error)) : job.resolve(data.vec);
    };
    // A worker that fails to BOOT never answers a message, so every caller would
    // hang. Fail them all and drop the worker, so the next call retries.
    _w.onerror = (e) => {
        for (const job of _pending.values()) job.reject(new Error(`embed worker: ${e?.message ?? "failed to start"}`));
        _pending.clear();
        _w = null;
    };
    return _w;
}

const ask = (kind, text) => new Promise((resolve, reject) => {
    const id = ++_seq;
    _pending.set(id, { resolve, reject });
    hub().postMessage({ id, kind, text });
});

/** Free text → 256-d L2-normalized vector. Throws if the model can't load —
 *  callers fall back to lexical. First call downloads the model (slow). */
export const embedQuery = (text) => (offThread() ? ask("query", text) : embedQueryDirect(text));

/**
 * Document side. Same model, the OTHER prompt — it's asymmetric, so documents
 * embedded with the query prompt rank against real queries worse.
 *
 * Runs one at a time on purpose: this executes in a publisher's browser during
 * publish, and a batch large enough to matter is a batch large enough to lock
 * the tab. `onProgress(done, total)` drives the publish progress bar.
 */
export async function embedDocuments(texts, onProgress) {
    const one = offThread() ? (t) => ask("document", t) : embedDocumentDirect;
    const out = [];
    for (const text of texts) {
        out.push(await one(text));
        onProgress?.(out.length, texts.length);
    }
    return out;
}

// ── wire format ───────────────────────────────────────────────────────────────
// Vectors are L2-normalized, so every component is in [-1, 1] and int8 costs one
// byte instead of ~9 for a JSON float. 256 floats: ~2.3 KB as JSON, 344 chars as
// base64 int8. That matters twice over — the vectors ride in the on-chain graph
// payload (which /api/catalog walks on every cold hit) AND in the shard every
// buyer downloads.
//
// ponytail: flat int8, no per-vector scale. Components of a unit vector in 256
// dims are ~0.06 RMS, so 1/127 steps cost far less recall than the retrieval
// noise floor. Add a scale factor only if a measured recall drop says to.

/** Float vector → base64 int8. */
export function packVec(vec) {
    const q = new Uint8Array(vec.length);
    for (let i = 0; i < vec.length; i++) {
        const v = Math.round(Math.max(-1, Math.min(1, vec[i])) * 127);
        q[i] = v < 0 ? v + 256 : v; // two's complement in a byte
    }
    let s = "";
    for (const b of q) s += String.fromCharCode(b);
    return btoa(s);
}

/** base64 int8 → Float16Array (Float32Array where there is none). Returns null on anything malformed — a bad vector
 *  must degrade that row to lexical, never throw mid-search. */
export function unpackVec(b64) {
    try {
        const s = atob(b64);
        // Half the memory of Float32 where the browser has it: every row holds one of these, and
        // an int8 source loses nothing at 16 bits. Consumers read plain numbers either way.
        const out = new (globalThis.Float16Array ?? Float32Array)(s.length);
        for (let i = 0; i < s.length; i++) {
            const b = s.charCodeAt(i);
            out[i] = (b > 127 ? b - 256 : b) / 127;
        }
        return out.length ? out : null;
    } catch { return null; }
}

/**
 * A unit vector as SIGN BITS — one bit per dimension, eight to a byte, base64.
 *
 * For LINKS, not for ranking storage: 256 dims land in 32 bytes (43 chars)
 * instead of int8's 256 bytes (344 chars), which is the difference between a
 * channel link you can paste in a message and one that wraps four times.
 *
 * The sign vector is a worse query than the float one, but not by much, and the
 * cost is measurable rather than a guess: over 7k real catalog vectors, the
 * top-80 pool it selects sits at mean cosine 0.808 to the true query where the
 * float query's own pool sits at 0.824 — a ~2% dilution of the neighbourhood for
 * an 8x shorter link. Both sides of a shared channel walk the SAME sign vector
 * (see tuned()), so there is no drift between them either way.
 *
 * ponytail: 1 bit. If the neighbourhood ever reads as visibly loose, 4 bits with
 * a per-vector scale measured 0.822 — indistinguishable from float — at 172 chars.
 */
export function packBits(vec) {
    const q = new Uint8Array(Math.ceil(vec.length / 8));
    for (let i = 0; i < vec.length; i++) if (vec[i] >= 0) q[i >> 3] |= 128 >> (i & 7);
    let s = "";
    for (const b of q) s += String.fromCharCode(b);
    return btoa(s);
}

/** base64 sign bits → Float32Array of ±1. Null on anything malformed, same
 *  contract as unpackVec: a pasted link is untrusted input. */
export function unpackBits(b64) {
    try {
        // atob is strict about length: a stripped "=" is normal in a URL.
        const s = atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "="));
        const out = new Float32Array(s.length * 8);
        for (let i = 0; i < out.length; i++) out[i] = (s.charCodeAt(i >> 3) >> (7 - (i & 7))) & 1 ? 1 : -1;
        return out.length ? out : null;
    } catch { return null; }
}

/**
 * Start loading the model. Never rejects, and safe to call on every keystroke or
 * focus — the pipeline is a memoized singleton on whichever thread owns it.
 *
 * Call this on INTENT (the search box taking focus), never on page load: it is a
 * ~300MB download, and until someone types there is nothing for it to embed. The
 * whole first-paint path — browse, shelves, channels, the field, the compass —
 * runs on the document vectors already in the shard.
 */
export const warmEmbedder = () => {
    if (offThread()) ask("warm").catch(() => {});
    else warmDirect().catch(() => {});
};

// ── self-check: `node src/llm/embed.js` — quantization only, no model download ────
if (typeof process !== "undefined" && import.meta.url === `file://${process.argv[1]}` && process.argv[1].endsWith("/embed.js")) {
    const v = matryoshka(Array.from({ length: 768 }, (_, i) => Math.sin(i)));
    let norm = 0;
    for (const x of v) norm += x * x;
    if (Math.abs(Math.sqrt(norm) - 1) > 1e-6) throw new Error("matryoshka must L2-normalize");
    if (v.length !== DIM) throw new Error(`matryoshka must truncate to ${DIM}`);

    const round = unpackVec(packVec(v));
    if (round.length !== v.length) throw new Error("pack/unpack changed the dimension");
    // Round-trip must stay near-parallel, or cosine ranking shifts under quantization.
    let dot = 0, n2 = 0;
    for (let i = 0; i < v.length; i++) { dot += v[i] * round[i]; n2 += round[i] * round[i]; }
    const cos = dot / Math.sqrt(n2);
    if (cos < 0.999) throw new Error(`int8 round-trip cosine ${cos} — too lossy to rank with`);

    // Negatives are the easy thing to get wrong in a byte round-trip.
    const neg = unpackVec(packVec([-1, -0.5, 0, 0.5, 1]));
    if (neg[0] > -0.99 || neg[1] > -0.49 || neg[1] < -0.51) throw new Error(`negative components corrupted: ${[...neg]}`);

    if (unpackVec("!!!not base64!!!") !== null) throw new Error("malformed vector must return null, not throw");

    // Sign bits: the link encoding. Idempotent (packing a sign vector again
    // changes nothing), which is what lets tuned() walk the shared vector.
    const bits = packBits(v);
    if (bits.length > 48) throw new Error(`sign bits must stay link-sized, got ${bits.length} chars`);
    const back = unpackBits(bits);
    if (back.length !== v.length) throw new Error("sign round-trip changed the dimension");
    for (let i = 0; i < v.length; i++) {
        if (Math.sign(back[i]) !== (v[i] < 0 ? -1 : 1)) throw new Error(`sign flipped at ${i}`);
    }
    if (packBits(back) !== bits) throw new Error("sign packing must be idempotent");
    if (unpackBits("!!!not base64!!!") !== null) throw new Error("malformed bits must return null, not throw");

    console.log("embed.js self-check ok — matryoshka norm, int8 round-trip, negatives, malformed input, sign bits");
}
