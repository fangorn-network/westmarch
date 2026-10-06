// The stock page every `westmarch ship` app deploys. Built once, here, into site/dist;
// ship copies dist into the app's site. No app writes frontend code to exist.
// onnxruntime's wasm loads from jsdelivr at runtime (transformers.js's default wasmPaths), but
// newer transformers names it by URL too, so vite emits an unused 25.6 MiB copy, over Pages'
// 25 MiB file limit. Drop it.
const noWasm = () => ({ name: "no-local-ort-wasm", generateBundle(_, bundle) { for (const k of Object.keys(bundle)) if (k.endsWith(".wasm")) delete bundle[k]; } });
export default {
    base: "./",
    build: { outDir: "dist", emptyOutDir: true },
    plugins: [noWasm()],
    // embed.js finds its worker by `new URL(…, import.meta.url)`; keep it a real file.
    worker: { format: "es", plugins: () => [noWasm()] },
};
