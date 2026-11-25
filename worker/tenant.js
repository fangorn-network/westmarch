// One app in the pool (worker/pool.js): its config checked, its gas key sealed, and the env that worker/index.js runs
// it with. Plain functions, so they're tested without a Durable Object (worker/pool.test.js).

import { SupportedNetworks } from "@fangorn-network/sdk";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { allRules } from "../src/validate.js";
import { ORIGIN_HEADER } from "./index.js";

/** How often each app runs its update (worker/pool.js): the per-app Worker's cron interval. */
export const RUN_EVERY = 60_000;

/** App names, as the ops repo has them: lowercase letters, digits and dashes. */
export const NAME = /^[a-z0-9](?:[a-z0-9-]{0,56}[a-z0-9])?$/;
/** Names no app gets: hostnames the zone uses for other things, and the pool's own. */
export const RESERVED = new Set(["pool", "www", "api", "app", "docs", "mcp", "registry", "registry-sepolia", "ipfs", "ipfs-test", "mail", "admin", "status"]);

const FIELDS = new Set(["name", "network", "follow", "repos", "publishers", "instructions", "types", "schema", "publishView", "publishPerDay", "grantPerDay"]);

/**
 * An app's config as the pool takes it, or throws saying why not. What the pool doesn't run yet:
 *  - `rules` (check code): a shared pool can't build each app's validator Worker. Schemas are fine, inline.
 *  - `index: "repos"`: the registry stays its own Worker; it's the pool's one chain reader.
 *  - `x402`, ASSETS and custom MCP tools: per-deploy things.
 * `name` defaults to the app's name in the pool.
 */
export function configOf(name, input) {
    if (!NAME.test(name)) throw new Error(`app name "${name}": lowercase letters, digits and dashes, up to 58`);
    if (RESERVED.has(name)) throw new Error(`app name "${name}" is reserved`);
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("config: a JSON object");
    const extra = Object.keys(input).filter((k) => !FIELDS.has(k));
    if (extra.length) throw new Error(`config: the pool doesn't take ${extra.join(", ")} (yet)`);
    if (allRules(input).length) throw new Error("config: rules (check code) aren't run in the pool yet; schemas are");
    const net = input.network ?? "baseSepolia";
    if (!SupportedNetworks[net]) throw new Error(`config: network "${net}": one of ${Object.keys(SupportedNetworks).join(", ")}`);
    const follow = input.follow ?? input.repos;
    if (!Array.isArray(follow) || !follow.length || !follow.every((p) => typeof p === "string" && p))
        throw new Error("config: follow (publisher/repo patterns) or repos (names), a non-empty list");
    if (follow.includes("*")) throw new Error(`config: following "*" is the registry's job`);
    const inline = (s, what) => { if (s != null && (typeof s !== "object" || Array.isArray(s))) throw new Error(`config: ${what} schema must be inline JSON Schema`); };
    inline(input.schema, "the app's");
    for (const [t, e] of Object.entries(input.types ?? {})) if (typeof e === "object") inline(e?.schema, `type ${t}'s`);
    return { ...input, name: input.name ?? name, network: net };
}

// The app's gas key, sealed under the pool's MASTER_KEY (a secret: 32 bytes, hex) with AES-GCM, so the Durable Object's
// storage alone doesn't give it away. Each app has its own key, so its stitches and views are signed as its own.
const hexToBytes = (h) => Uint8Array.from(h.replace(/^0x/, "").match(/../g), (b) => parseInt(b, 16));
const b64 = (u8) => btoa(String.fromCharCode(...u8)), unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const aesKey = (master) => {
    if (!/^(0x)?[0-9a-fA-F]{64}$/.test(master ?? "")) throw new Error("MASTER_KEY: 32 bytes of hex (wrangler secret put MASTER_KEY)");
    return crypto.subtle.importKey("raw", hexToBytes(master), "AES-GCM", false, ["encrypt", "decrypt"]);
};
/** A fresh gas key for an app → { address, sealed }. */
export async function newKey(master) {
    const key = generatePrivateKey(), iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(master), new TextEncoder().encode(key)));
    return { address: privateKeyToAccount(key).address, sealed: `${b64(iv)}.${b64(ct)}` };
}
export async function openKey(master, sealed) {
    const [iv, ct] = sealed.split(".").map(unb64);
    return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, await aesKey(master), ct));
}

/**
 * The env worker/index.js runs one app with: the pool's AI, the app's CONFIG, DB and INDEXER_KEY, and EMBED_CACHE
 * (`({ model, prompt }) → cache`, worker/embeds.js) when the pool has one.
 */
export const appEnv = (env, { config, db, key, embedCache }) => ({ AI: env.AI, CONFIG: config, DB: db, INDEXER_KEY: key, ...(embedCache && { EMBED_CACHE: embedCache }) });

/**
 * Which app a request is for, and the request as the app sees it: by host (<name>.<POOL_ZONE>, a reserved name falls
 * through) or by path (/apps/<name>/…, told its public base in ORIGIN_HEADER). A client's own ORIGIN_HEADER is dropped.
 */
export function routeOf(req, zone) {
    const url = new URL(req.url), headers = new Headers(req.headers);
    headers.delete(ORIGIN_HEADER);
    if (zone && url.hostname.endsWith(`.${zone}`)) {
        const name = url.hostname.slice(0, -zone.length - 1);
        if (NAME.test(name) && !RESERVED.has(name)) return { name, req: new Request(req, { headers }) };
    }
    const m = url.pathname.match(/^\/apps\/([^/]+)(\/.*)?$/);
    if (!m || !NAME.test(m[1]) || RESERVED.has(m[1])) return null;
    headers.set(ORIGIN_HEADER, `${url.origin}/apps/${m[1]}`);
    url.pathname = m[2] ?? "/";
    return { name: m[1], req: new Request(url, new Request(req, { headers })) };
}
