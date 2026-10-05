// fangorn-mcp as one file: no node, no npm install, the embedder included.
//
//   bun scripts/build-bin.js                          this machine → dist/fangorn-mcp-<target>
//   bun scripts/build-bin.js linux-arm64 darwin-arm64 cross-compile
//   bun scripts/build-bin.js all --npm 0.0.2          every target, plus npm packages in npm/:
//
//     @fangorn-network/fangorn-mcp             a small launcher (`npx -y @fangorn-network/fangorn-mcp`)
//     @fangorn-network/fangorn-mcp-<target>    the binary and its onnxruntime library, one per
//                                              platform; npm installs only the one that matches
//
// Publish the platform packages first, then the launcher (it depends on them by version):
//   for d in npm/fangorn-mcp-*/ npm/fangorn-mcp/; do (cd $d && npm publish --access public); done
//
// Needs bun >= 1.2 (1.1 miscompiles modules with top-level await).
// The launcher puts the library's folder on LD_LIBRARY_PATH / DYLD_LIBRARY_PATH, which is
// how the binding finds it on macOS; on Linux the binary also carries it (ort-preload.js),
// so the bare binary works on its own too.
// ponytail: no Windows build; add win32-x64 (onnxruntime.dll + PATH) when someone asks.
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";

const ALL = ["linux-x64", "linux-arm64", "darwin-arm64"];
const args = process.argv.slice(2);
const npmAt = args.indexOf("--npm");
const version = npmAt >= 0 ? args[npmAt + 1] : null;
if (npmAt >= 0 && !version) throw new Error("--npm needs a version, e.g. --npm 0.0.2");
const named = args.filter((a, i) => !a.startsWith("--") && i !== npmAt + 1);
const targets = named.includes("all") ? ALL : named.length ? named : [`${process.platform}-${process.arch}`];
const root = `${import.meta.dir}/..`;

const ortLib = (target) => {
    const dir = `${root}/node_modules/onnxruntime-node/bin/napi-v6/${target.replace("-", "/")}`;
    const lib = existsSync(dir) && readdirSync(dir).find((f) => f.startsWith("libonnxruntime"));
    if (!lib) throw new Error(`no onnxruntime for ${target} in ${dir} (npm install first)`);
    return { path: `${dir}/${lib}`, name: lib };
};

async function build(target) {
    const lib = ortLib(target);
    mkdirSync(`${root}/dist/ort`, { recursive: true });
    copyFileSync(lib.path, `${root}/dist/ort/libonnxruntime.so.1`);   // ort-preload.js embeds it from here
    const outfile = `${root}/dist/fangorn-mcp-${target}`;
    const r = await Bun.build({
        entrypoints: [`${root}/src/agent/mcp-bin.js`],
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
    if (version) platformPackage(target, outfile, lib);
}

function platformPackage(target, binary, lib) {
    const [os, cpu] = target.split("-");
    const dir = `${root}/npm/fangorn-mcp-${target}`;
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    copyFileSync(binary, `${dir}/fangorn-mcp`);
    chmodSync(`${dir}/fangorn-mcp`, 0o755);
    copyFileSync(lib.path, `${dir}/${lib.name}`);
    writeFileSync(`${dir}/package.json`, JSON.stringify({
        name: `@fangorn-network/fangorn-mcp-${target}`, version, license: "MIT",
        description: `fangorn-mcp for ${target}. Installed by @fangorn-network/fangorn-mcp; not used directly.`,
        os: [os], cpu: [cpu], files: ["fangorn-mcp", lib.name], publishConfig: { access: "public" },
    }, null, 2));
}

function launcher() {
    const dir = `${root}/npm/fangorn-mcp`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/package.json`, JSON.stringify({
        name: "@fangorn-network/fangorn-mcp", version, license: "MIT",
        description: "One MCP server for every Fangorn app: find, verify and search apps registered on chain.",
        bin: { "fangorn-mcp": "bin.js" }, files: ["bin.js"],
        optionalDependencies: Object.fromEntries(ALL.map((t) => [`@fangorn-network/fangorn-mcp-${t}`, version])),
        engines: { node: ">=18" }, publishConfig: { access: "public" },
    }, null, 2));
    copyFileSync(`${root}/scripts/npm-launcher.js`, `${dir}/bin.js`);
    chmodSync(`${dir}/bin.js`, 0o755);
    console.log(`${dir} (launcher ${version})`);
}

for (const t of targets) await build(t);
if (version) launcher();
