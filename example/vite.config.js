// No build config to speak of, except one dev-server guard.
//
// @fangorn/westmarch is linked source, so vite must NOT pre-bundle it — its
// embed.worker.js is resolved by `new URL(…, import.meta.url)` and a pre-bundled
// copy loses that. And because the link resolves outside this directory, dev
// serves those files from /@fs/…, which `fs.allow` denies by default: the app
// still runs, the embed worker alone fails to start, and search silently drops
// to lexical. Production builds are unaffected.
export default {
    optimizeDeps: { exclude: ["@fangorn/westmarch"] },
    server: { port: 5180, fs: { allow: [".", "../.."] } },
    // Two entries, not one. `index.html` is about the catalogue; `you.html` is
    // about the reader, and it has to be a real page on THIS origin rather than
    // a view inside an app — localStorage is origin-scoped, so a taste kept by
    // fangorn.tv is not readable here and vice versa. The index is where the
    // person lives; the apps hand them back with `?taste=`.
    build: { rollupOptions: { input: { index: "index.html", you: "you.html" } } },
};
