// fangorn-mcp as one file: no node, no npm install, the embedder included.
//
//   bun build-bin.js                 this machine → dist/fangorn-mcp-linux-x64
//   bun build-bin.js linux-arm64     cross-compile
//
// Needs bun >= 1.2 (1.1 miscompiles modules with top-level await).
// ponytail: linux only. macOS/Windows need their own preload in ort-preload.js
// (dyld / LoadLibrary, not soname matching); add them when someone runs there.
import { copyFileSync, existsSync, mkdirSync } from "node:fs";

const target = process.argv[2] ?? `${process.platform}-${process.arch}`;
const ort = `node_modules/onnxruntime-node/bin/napi-v6/${target.replace("-", "/")}/libonnxruntime.so.1`;
if (!existsSync(ort)) throw new Error(`no onnxruntime for ${target} at ${ort} (npm install first)`);
mkdirSync(`${import.meta.dir}/dist/ort`, { recursive: true });
copyFileSync(ort, `${import.meta.dir}/dist/ort/libonnxruntime.so.1`);   // ort-preload.js embeds it from here

const outfile = `${import.meta.dir}/dist/fangorn-mcp-${target}`;
const r = await Bun.build({
    entrypoints: [`${import.meta.dir}/consume/mcp-bin.js`],
    compile: { target: `bun-${target}`, outfile },
    plugins: [{
        // transformers imports sharp for images, and throws at import without it.
        // Text never calls it, and its native binary does not survive the embedding.
        name: "no-sharp",
        setup(b) {
            b.onResolve({ filter: /^sharp$/ }, () => ({ path: "sharp", namespace: "no-sharp" }));
            b.onLoad({ filter: /.*/, namespace: "no-sharp" }, () => ({ contents: 'export default () => { throw new Error("fangorn-mcp embeds text, not images"); };', loader: "js" }));
        },
    }],
});
if (!r.success) { console.error(r.logs.join("\n")); process.exit(1); }
console.log(`${outfile} ${(Bun.file(outfile).size / 1048576).toFixed(0)} MB`);
