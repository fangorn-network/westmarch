#!/usr/bin/env node
// @fangorn-network/fangorn-mcp: run this platform's prebuilt fangorn-mcp.
//
//   claude mcp add fangorn -- npx -y @fangorn-network/fangorn-mcp
//
// npm installed exactly one @fangorn-network/fangorn-mcp-<os>-<cpu> next to this file
// (optionalDependencies + os/cpu). It holds the binary and the onnxruntime library the
// embedder links against; putting that folder on the loader path is what lets the
// binding find the library on every platform. stdio is the MCP transport, so it is
// handed straight through.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname } from "node:path";

const target = `${process.platform}-${process.arch}`;
let dir;
try {
    dir = dirname(createRequire(import.meta.url).resolve(`@fangorn-network/fangorn-mcp-${target}/package.json`));
} catch {
    console.error(`fangorn-mcp has no build for ${target} (there are linux-x64, linux-arm64 and darwin-arm64).\n` +
        "Run it on node instead: npx -y -p @fangorn-network/westmarch -p @huggingface/transformers fangorn-mcp");
    process.exit(1);
}
const libVar = process.platform === "darwin" ? "DYLD_LIBRARY_PATH" : "LD_LIBRARY_PATH";
const child = spawn(`${dir}/fangorn-mcp`, process.argv.slice(2), {
    stdio: "inherit",
    env: { ...process.env, [libVar]: [dir, process.env[libVar]].filter(Boolean).join(":") },
});
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
child.on("exit", (code, signal) => (signal ? process.kill(process.pid, signal) : process.exit(code ?? 1)));
