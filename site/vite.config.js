// The stock page every `westmarch ship` app deploys. Built once, here, into site/dist;
// ship copies dist into the app's site. No app writes frontend code to exist.
export default {
    base: "./",
    build: { outDir: "dist", emptyOutDir: true },
    // embed.js finds its worker by `new URL(…, import.meta.url)`; keep it a real file.
    worker: { format: "es" },
};
