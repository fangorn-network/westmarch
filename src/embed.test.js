import { test, expect } from "vitest";
import { localEmbedder, textOf } from "./embed.js";

test("textOf: every leaf as `path: value`", () => {
    expect(textOf({ name: "oak", dims: { w: 2 }, tags: ["a", "b"] })).toBe("name: oak\ndims.w: 2\ntags.0: a\ntags.1: b");
});

// The real model: EmbeddingGemma via westmarch (downloads ~300 MB once). EMBED_LOCAL=1 npm test
test.skipIf(!process.env.EMBED_LOCAL)("localEmbedder: 256-d unit vectors, near for near texts, queries in the same space", async () => {
    const e = localEmbedder();
    const [a, b, c] = await e.embed(["an oak dining table", "a wooden kitchen table", "quarterly tax filing"]);
    const dot = (x, y) => x.reduce((s, v, i) => s + v * y[i], 0);
    expect(a).toHaveLength(256);
    expect(dot(a, a)).toBeCloseTo(1, 4);
    expect(dot(a, b)).toBeGreaterThan(dot(a, c));
    const q = await e.query("somewhere to eat dinner");
    expect(dot(q, a)).toBeGreaterThan(dot(q, c));
}, 120_000);
