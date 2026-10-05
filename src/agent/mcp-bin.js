// Entry for the single-file `fangorn-mcp` (build-bin.js), not for node.
// Static imports run in order, so the library is loaded before the server
// starts. Not `await import("./mcp.js")`: bun 1.1 then wraps each module in a
// function, and their top-level awaits stop parsing.
import "../core/ort-preload.js";
import "./mcp.js";
