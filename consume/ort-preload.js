// Loads onnxruntime's library for the single-file `fangorn-mcp` (mcp-bin.js).
//
// bun embeds onnxruntime's binding and extracts it to a temp dir at run time,
// but not the library the binding links against, so the embedder fails to load.
// This embeds that library too, writes it to the cache once, and loads it before
// anything imports transformers: the binding then finds it already loaded, by name.
// A failure here only costs the embedder, and search falls back to words.
import { dlopen } from "bun:ffi";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
// build-bin.js puts the target's library here before it compiles.
import lib from "../dist/ort/libonnxruntime.so.1" with { type: "file" };

try {
    const dir = `${homedir()}/.cache/fangorn-mcp/lib/${lib.split("/").pop()}`;   // bun names it by content hash
    const path = `${dir}/libonnxruntime.so.1`;
    if (!existsSync(path)) {
        mkdirSync(dir, { recursive: true });
        writeFileSync(`${path}.${process.pid}`, readFileSync(lib));   // copyFile cannot read bun's embedded fs
        renameSync(`${path}.${process.pid}`, path);
    }
    dlopen(path, { OrtGetApiBase: { args: [], returns: "ptr" } });   // bun wants one symbol; this is the lib's entry point
} catch (e) {
    console.error(`[fangorn-mcp] onnxruntime not loaded, search will rank by words: ${e.message}`);
}
