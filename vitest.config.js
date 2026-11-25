import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
    // worker/pool.js imports the Workers runtime's DurableObject; tests get a stand-in.
    resolve: { alias: { "cloudflare:workers": fileURLToPath(new URL("./worker/testing-cf.js", import.meta.url)) } },
});
