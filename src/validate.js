// What an app lets into its index, for apps that follow repos of publishers they don't know.
//
// A record is { id, type, payload }, and its publisher picks the type. So the type only picks which checks run; it
// earns nothing by itself. Each record must pass, in order (the first refusal is the verdict):
//
//   1. its type is one of CONFIG.types (when the app lists types);
//   2. CONFIG.schema, the base: a JSON Schema every payload must match (fields every type shares);
//   3. CONFIG.types[type].schema, its type's;
//   4. CONFIG.rules, then CONFIG.types[type].rules: the app owner's hooks (checks).
//
// A rule names a check: { check: "<publisher>/<repo>/<id>", with: { …params } }, a `check` record whose payload.src is
// its bundle and payload.params the JSON Schema its `with` must match; or a bundle's CID, bare. deploy.sh resolves each
// to { check, record, src, with } (worker/validator.js): the record's CID and its bundle's, pinned. That resolved
// config is the app's lockfile, served in /api.json: anyone can see exactly which checks ran, at which version.
//
// A schema is a JSON Schema (2020-12), inline or as a CID that deploy.sh inlines at deploy time (worker/validator.js):
// nothing is fetched at run time, and the CID pins it. Schemas run here, in the app's Worker; the hooks run in the app's
// validator Worker (worker/validator.js), one call per record for all its hooks.
//
// A hook bundle is JSON: { js } (one ES module, dependencies bundled in) or { mainModule, modules } (several, e.g. a
// wasm decoder: { "glb.wasm": { wasm: "<base64>" } }). Its main module exports
//
//   validate(record, { publisher, repo, file, params }) → true | "why not"      (or a Promise of one)
//
// record is { id, type, cid, payload }; file is the bytes at payload.src (a Uint8Array), when it has one; params is
// the rule's `with`. Anything but
// true refuses the record with that reason; so does a throw. Keep it to the record and its file (no fetches), so
// anyone rerunning the app's hooks over its stitch gets the same verdicts.
//
// The checks run at POST /publish (before the app pays gas) and on every record the index takes in, since a publisher
// can push to their own repo without the app.

import { Validator } from "@cfworker/json-schema";

export const MAX_CHECKED_FILE = 25 * 1024 * 1024; // files published straight to a repo can be bigger than /publish takes; Workers RPC carries ~32 MiB

/** A type's description, whether CONFIG.types gives it as a string or as { description, schema, rules }. */
export const describe = (t) => (typeof t === "string" ? t : t?.description ?? "");

/** `rules` as a list: one rule, a list of them, or nothing. */
export const listOf = (rules) => (rules == null ? [] : [].concat(rules));

/** A rule, resolved or not → { name, src, params }. `src` is undefined until deploy.sh resolves a check reference. */
export const ruleOf = (r) => (typeof r === "string"
    ? { name: r, src: r.includes("/") ? undefined : r, params: {} }
    : { name: r?.check, src: r?.src ?? (typeof r?.check === "string" && !r.check.includes("/") ? r.check : undefined), params: r?.with ?? {} });

const entryOf = (types, type) => (types && type != null && Object.hasOwn(types, type) && typeof types[type] === "object" ? types[type] : null);

/** Every rule the app's config names, base then per type (unresolved references included). */
export const allRules = (config) =>
    [...listOf(config.rules), ...Object.values(config.types ?? {}).flatMap((t) => (typeof t === "object" ? listOf(t?.rules) : []))];

/** Every hook bundle's CID the app's (resolved) config runs, each once. */
export const rulesOf = (config) => [...new Set(allRules(config).map((r) => ruleOf(r).src).filter(Boolean))];

const hash = async (v) => {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(v)));
    return [...new Uint8Array(digest).slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

/**
 * The checkers' ids, one per type: { types: { <type>: id }, other: id (a type the app doesn't list), all: id }. A
 * type's id changes when its checks do (the base's, or its own schema or rules), so the index checks again only the
 * records those checks cover. null when the app checks nothing: then the index lets every record in, as before.
 */
export async function gatesOf(config) {
    const base = { schema: config.schema ?? null, rules: listOf(config.rules) };
    const entries = Object.keys(config.types ?? {}).map((t) => [t, entryOf(config.types, t)]);
    if (!base.schema && !base.rules.length && !entries.some(([, e]) => e?.schema || listOf(e?.rules).length)) return null;
    const types = {};
    for (const [t, e] of entries) types[t] = await hash({ base, type: t, schema: e?.schema ?? null, rules: listOf(e?.rules) });
    const other = await hash({ base, known: config.types ? Object.keys(config.types).sort() : null });
    return { types, other, all: await hash({ types, other }) };
}

/** The gate a record of `type` is checked under. */
export const gateFor = (gates, type) => (type != null && Object.hasOwn(gates.types, type) ? gates.types[type] : gates.other);

const compile = (schema, what) => {
    if (schema == null) return null;
    if (typeof schema !== "object") throw new Error(`${what} schema is ${JSON.stringify(schema)}, not inlined: deploy.sh inlines schema CIDs (worker/validator.js)`);
    return new Validator(schema, "2020-12", false);
};

/**
 * { gates, check(record, { publisher, repo, file? }) → null | reason }, or null when the app checks nothing. `file` is
 * the bytes, or an async function that fetches them (fileOf): called only when the schemas passed and hooks run.
 * `validator`: { validate(rules, record, ctx) → true | reason }, the app's validator Worker (its VALIDATOR binding),
 * running `rules` ([{ name, src, params }]) in order. If it can't be reached, check throws: that's not the record's fault, so try again.
 */
export async function checkerOf(config, validator) {
    const gates = await gatesOf(config);
    if (!gates) return null;
    const unresolved = allRules(config).find((r) => !ruleOf(r).src);
    if (unresolved) throw new Error(`rule ${JSON.stringify(unresolved)} isn't resolved: deploy.sh resolves check references (worker/validator.js)`);
    if (rulesOf(config).length && !validator) throw new Error("CONFIG's rules need the VALIDATOR service binding (worker/deploy.sh adds it)");
    const types = config.types, base = compile(config.schema, "the app's");
    const schemas = Object.fromEntries(Object.keys(types ?? {}).map((t) => [t, compile(entryOf(types, t)?.schema, `the ${t}`)]));
    const mismatch = (what, result) => `payload doesn't match the ${what} schema: ${result.errors.slice(-3).map((e) => `${e.instanceLocation} ${e.error}`).join("; ")}`;
    return {
        gates,
        async check(record, ctx) {
            if (types && (record.type == null || !Object.hasOwn(types, record.type))) return `type is one of ${Object.keys(types).join(", ")}`;
            const payload = record.payload ?? {};
            let result = base?.validate(payload);
            if (result && !result.valid) return mismatch("app's", result);
            result = schemas[record.type]?.validate(payload);
            if (result && !result.valid) return mismatch(record.type, result);
            const rules = [...listOf(config.rules), ...listOf(entryOf(types, record.type)?.rules)].map(ruleOf);
            if (!rules.length) return null;
            const file = typeof ctx.file === "function" ? await ctx.file() : ctx.file;
            if (file?.length > MAX_CHECKED_FILE) return `its file is over ${MAX_CHECKED_FILE >> 20} MB`;
            const verdict = await validator.validate(rules, record, { publisher: ctx.publisher, repo: ctx.repo, file });
            return verdict === true ? null : String(verdict || "refused by the app's rules");
        },
    };
}

/** check's `file` for a record already published: fetches the bytes at its payload.src, if it has one. */
// ponytail: downloads the whole file before the size check; a HEAD for its length if big files show up
export const fileOf = (fangorn, record) => async () =>
    typeof record.payload?.src === "string" ? fangorn.getStorage().getFile(record.payload.src) : undefined;
