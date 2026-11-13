// An embedder is `{ id, embed(texts) → vectors, query(text) → vector }`. `id` names the vector space:
// vectors from two models are not comparable, and nothing would say so.

import { DOCUMENT, EMBED_DIM, EMBED_DTYPE, EMBED_MODEL, QUERY, embedRaw } from "./gemma.js";

/** EmbeddingGemma in-process (transformers.js, via westmarch): the same space westmarch searches. */
export const localEmbedder = () => ({
    id: { model: EMBED_MODEL, dim: EMBED_DIM, dtype: EMBED_DTYPE },
    embed: (texts) => embedRaw(texts.map((t) => DOCUMENT + t)),
    query: async (text) => (await embedRaw([QUERY + text]))[0],
});

/** A record's text to embed and to match words in: every leaf of its payload as `path: value`, one per line. */
export function textOf(payload, path = "") {
    if (payload == null) return "";
    if (typeof payload !== "object") return `${path}: ${payload}`;
    return Object.entries(payload).map(([k, v]) => textOf(v, path ? `${path}.${k}` : k)).filter(Boolean).join("\n");
}
