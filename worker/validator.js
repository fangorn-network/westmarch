// An app's validation, made ready at deploy time from the CIDs in its config (see src/validate.js):
//   - every schema given as a CID is fetched and inlined into CONFIG, so nothing is fetched at run time;
//   - every hook (CONFIG.rules, CONFIG.types[t].rules) is fetched and built into ONE Worker, <app>-validator, each
//     hook's modules under rules/<cid>/, which the app calls over a service binding, VALIDATOR:
//     validate(rules, record, ctx) runs those hooks in order and answers true or the first refusal.
// The CIDs in apps.json pin exactly what runs, and changing one is an apps.json change, which redeploys anyway.
//
// The validator Worker has no bindings and no secrets, so it can't reach the app's gas wallet or its database, and it
// isn't routed anywhere (no workers.dev, no domain), so only the app can call it.
// ponytail: a hook can still fetch() out (a normal Worker can't be denied the network). It holds nothing worth leaking,
// but a hook that calls out may not answer the same way twice; a Dynamic Worker can run hooks with globalOutbound null
// (paid plan) if that matters.
//
//   node worker/validator.js <config.json> <name> <outdir>
//     writes <outdir>/config.json (schemas inlined) and, when the config has hooks, <outdir>/validator/ (wrangler.json
//     and the modules)

import { Validator } from "@cfworker/json-schema";
import { allRules, listOf, ruleOf, rulesOf } from "../src/validate.js";

const MAIN = "westmarch-validate.js";
const CID = /^[a-zA-Z0-9]+$/; // a path segment too (rules/<cid>/): alphanumerics only

const bytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/** One hook bundle → its modules: { files: { name: string | Uint8Array }, types: { name: wrangler module type }, main }. */
export function hookModules(bundle) {
    const { mainModule, modules } = typeof bundle?.js === "string" ? { mainModule: "validator.js", modules: { "validator.js": bundle.js } } : bundle ?? {};
    if (!modules || typeof modules !== "object" || modules[mainModule] === undefined) throw new Error("a hook bundle is { js } or { mainModule, modules }");
    const files = {}, types = {};
    for (const [name, m] of Object.entries(modules)) {
        if (!/^[\w.-]+(\/[\w.-]+)*$/.test(name) || name.split("/").some((p) => p === "." || p === "..")) throw new Error(`module name "${name}" isn't a plain relative path`);
        const [type, content] =
            typeof m === "string" ? ["ESModule", m]
            : typeof m?.js === "string" ? ["ESModule", m.js]
            : typeof m?.cjs === "string" ? ["CommonJS", m.cjs]
            : typeof m?.text === "string" ? ["Text", m.text]
            : m && "json" in m ? ["ESModule", `export default ${JSON.stringify(m.json)};\n`]
            : typeof m?.wasm === "string" ? ["CompiledWasm", bytes(m.wasm)]
            : typeof m?.data === "string" ? ["Data", bytes(m.data)]
            : [];
        if (!type) throw new Error(`module "${name}" is a string, { js }, { cjs }, { text }, { json }, { wasm } or { data }`);
        files[name] = content;
        types[name] = type;
    }
    return { files, types, main: mainModule };
}

/** The entrypoint the app calls: each rule ({ name, src, params }) in turn, a refusal (anything but true, or a throw) as `<name>: <reason>`. */
const entrypoint = (mains) => `import { WorkerEntrypoint } from "cloudflare:workers";
${mains.map(([cid, main], i) => `import * as h${i} from ${JSON.stringify(`./rules/${cid}/${main}`)};`).join("\n")}
const HOOKS = { ${mains.map(([cid], i) => `${JSON.stringify(cid)}: h${i}`).join(", ")} };
export default class extends WorkerEntrypoint {
    // Cloudflare refuses a Worker with no event handler (10068), and RPC methods don't count. It has no route, so this never runs.
    fetch() { return new Response(null, { status: 404 }); }
    async validate(rules, record, ctx) {
        for (const { name, src, params } of rules) {
            const hook = HOOKS[src];
            if (!hook) throw new Error("no hook " + src + " in this validator: redeploy the app"); // not a verdict: the app retries
            let v;
            try { v = await (hook.validate ?? hook.default)(record, { ...ctx, params: params ?? {} }); }
            catch (e) { return name + ": threw: " + (e?.message ?? e); }
            if (v !== true) return name + ": " + String(v || "refused");
        }
        return true;
    }
}
`;

/** Hook bundles by CID → the validator Worker: { files, rules } (wrangler's module rules, unbundled). */
export function validatorFiles(bundles) {
    const files = { [MAIN]: "" }, byType = { ESModule: [MAIN] }, mains = [];
    for (const [cid, bundle] of Object.entries(bundles)) {
        if (!CID.test(cid)) throw new Error(`"${cid}" isn't a CID`);
        let hook;
        try { hook = hookModules(bundle); } catch (e) { throw new Error(`hook ${cid}: ${e.message}`); }
        for (const [name, content] of Object.entries(hook.files)) {
            files[`rules/${cid}/${name}`] = content;
            (byType[hook.types[name]] ??= []).push(`rules/${cid}/${name}`);
        }
        mains.push([cid, hook.main]);
    }
    files[MAIN] = entrypoint(mains);
    // fallthrough: wrangler refuses a file that a later default rule (e.g. **/*.wasm) also matches when ours of that type
    // stops there. Ours come first, so they still decide each module's type.
    return { files, rules: Object.entries(byType).map(([type, globs]) => ({ type, globs, fallthrough: true })) };
}

/** The validator Worker's wrangler config. */
export const validatorConfig = (name, rules) => ({
    name: `${name}-validator`, main: MAIN, no_bundle: true, rules,
    compatibility_date: "2025-09-15", compatibility_flags: ["nodejs_compat"],
    workers_dev: false, preview_urls: false,
});

/**
 * The config with every schema CID inlined and every check reference resolved, and every hook's bundle:
 * { config, bundles: { cid: bundle } }. `get(cid)` → the JSON at that CID; `read(publisher, repo, id)` → that record
 * now ({ cid, type, payload }), or null.
 * A reference resolves to { check, record, src, with }: the `check` record's CID and its bundle's, so the deployed
 * config pins both. `with` must match the record's payload.params. A check needing capabilities (payload.needs) is
 * refused: nothing grants them yet.
 */
export async function resolve(config, get, read) {
    const schema = async (s, what) => {
        if (s == null || typeof s === "object") return s;
        if (typeof s !== "string" || !CID.test(s)) throw new Error(`${what} schema is a JSON Schema or its CID, not ${JSON.stringify(s)}`);
        return get(s);
    };
    const out = { ...config, schema: await schema(config.schema, "the app's") };
    if (out.schema === undefined) delete out.schema;
    if (config.types) {
        out.types = {};
        for (const [t, e] of Object.entries(config.types))
            out.types[t] = typeof e === "object" && e ? { ...e, ...(e.schema !== undefined && { schema: await schema(e.schema, `the ${t}`) }) } : e;
    }
    const resolved = new Map();
    const rule = async (r) => {
        const { name, params } = ruleOf(r), key = JSON.stringify(r);
        if (resolved.has(key)) return resolved.get(key);
        let out;
        if (typeof name === "string" && CID.test(name)) out = typeof r === "string" ? name : { check: name, src: name, ...(r.with && { with: r.with }) };
        else {
            const m = typeof name === "string" && name.match(/^(0x[0-9a-fA-F]{40})\/([^/]+)\/([^/]+)$/);
            if (!m) throw new Error(`a rule is { check: "<publisher>/<repo>/<id>", with? } or a bundle's CID, not ${JSON.stringify(r)}`);
            const rec = await read(m[1], m[2], m[3]);
            if (!rec) throw new Error(`${name}: no such record`);
            if (rec.type !== "check" || typeof rec.payload?.src !== "string") throw new Error(`${name}: not a check (a "check" record with payload.src)`);
            if (listOf(rec.payload.needs).length) throw new Error(`${name} needs ${listOf(rec.payload.needs).join(", ")}: capabilities aren't supported yet`);
            if (rec.payload.params) {
                const v = new Validator(rec.payload.params, "2020-12", false).validate(params);
                if (!v.valid) throw new Error(`${name}: its "with" doesn't match its params: ${v.errors.slice(-3).map((e) => `${e.instanceLocation} ${e.error}`).join("; ")}`);
            }
            out = { check: name, record: String(rec.cid), src: rec.payload.src, ...(r.with && { with: r.with }) };
        }
        resolved.set(key, out);
        return out;
    };
    const rules = async (rs) => (rs === undefined ? undefined : Promise.all(listOf(rs).map(rule)));
    if (config.rules !== undefined) out.rules = await rules(config.rules);
    for (const [t, e] of Object.entries(out.types ?? {}))
        if (typeof e === "object" && e?.rules !== undefined) out.types[t] = { ...e, rules: await rules(e.rules) };
    const bundles = {};
    for (const cid of rulesOf(out)) bundles[cid] = await get(cid);
    return { config: out, bundles };
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const [configPath, name, out] = process.argv.slice(2);
    if (!out) { console.error("usage: node worker/validator.js <config.json> <name> <outdir>"); process.exit(2); }
    const { mkdirSync, readFileSync, writeFileSync } = await import("node:fs"), { dirname, join } = await import("node:path");
    const { client } = await import("../src/client.js");
    const raw = JSON.parse(readFileSync(configPath, "utf8")), fangorn = client(raw);
    // ponytail: trusts the network's gateway to serve what the CID names; verify the bytes against the CID if it ever isn't ours
    const get = async (cid) => JSON.parse(new TextDecoder().decode(await fangorn.getStorage().getFile(cid)));
    const read = (publisher, repo, id) => fangorn.engine.readRecord(publisher, repo, id).catch((e) => { if (/no on-chain commits|not found/i.test(e?.message)) return null; throw e; });
    const { config, bundles } = await resolve(raw, get, read);
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "config.json"), JSON.stringify(config));
    if (Object.keys(bundles).length) {
        const { files, rules } = validatorFiles(bundles), dir = join(out, "validator");
        for (const [file, content] of Object.entries(files)) {
            mkdirSync(dirname(join(dir, file)), { recursive: true });
            writeFileSync(join(dir, file), content);
        }
        writeFileSync(join(dir, "wrangler.json"), JSON.stringify(validatorConfig(name, rules)));
    }
}
