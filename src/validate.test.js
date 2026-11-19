import { test, expect } from "vitest";
import { checkerOf, gatesOf, gateFor, describe, rulesOf } from "./validate.js";
import { hookModules, validatorFiles, validatorConfig, resolve } from "../worker/validator.js";

const BASE = { type: "object", required: ["title"], properties: { title: { type: "string", minLength: 1 } } };
const CONFIG = {
    schema: BASE,
    rules: ["bafyBaseRule"],
    types: {
        asset: { description: "a file", schema: { type: "object", required: ["src", "mime"] }, rules: ["bafyMime", "bafyGlb"] },
        skill: { description: "a SKILL.md", rules: "bafyNoInjection" },
        note: "free text: base checks only",
    },
};

test("gatesOf: null when the app checks nothing; one id per type, changing only with that type's checks", async () => {
    expect(await gatesOf({})).toBe(null);
    expect(await gatesOf({ types: { note: "just described" } })).toBe(null);
    const g = await gatesOf(CONFIG);
    expect(Object.keys(g.types)).toEqual(["asset", "skill", "note"]);
    expect(new Set([...Object.values(g.types), g.other]).size).toBe(4);
    expect(gateFor(g, "asset")).toBe(g.types.asset);
    expect(gateFor(g, "malware")).toBe(g.other);
    expect(gateFor(g, null)).toBe(g.other);

    const assetRules = await gatesOf({ ...CONFIG, types: { ...CONFIG.types, asset: { ...CONFIG.types.asset, rules: ["bafyMime"] } } });
    expect(assetRules.types.asset).not.toBe(g.types.asset);                    // asset's checks changed: assets rechecked
    expect(assetRules.types.skill).toBe(g.types.skill);                        // nothing else
    expect((await gatesOf({ ...CONFIG, types: { ...CONFIG.types, asset: { ...CONFIG.types.asset, description: "reworded" } } })).all).toBe(g.all);
    const baseRules = await gatesOf({ ...CONFIG, rules: [] });
    expect(Object.keys(g.types).every((t) => baseRules.types[t] !== g.types[t])).toBe(true); // the base changed: everything
    expect(rulesOf(CONFIG)).toEqual(["bafyBaseRule", "bafyMime", "bafyGlb", "bafyNoInjection"]);
    expect(describe(CONFIG.types.asset)).toBe("a file");
    expect(describe(CONFIG.types.note)).toBe("free text: base checks only");
});

test("checkerOf: type, base schema, type schema, then base and type rules in one call; file only when rules run", async () => {
    const calls = [];
    const validator = { validate: async (rules, record, ctx) => (calls.push([rules, record.id, ctx]), record.payload.title === "evil" ? "bafyBaseRule: no evil" : true) };
    const c = await checkerOf(CONFIG, validator);
    let fetched = 0;
    const file = async () => (fetched++, new Uint8Array([1, 2]));
    const ctx = { publisher: "0xa", repo: "isw", file };

    expect(await c.check({ id: "x", type: "malware", payload: { title: "t" } }, ctx)).toMatch(/type is one of asset, skill, note/);
    expect(await c.check({ id: "x", payload: { title: "t" } }, ctx)).toMatch(/type is one of/);
    expect(await c.check({ id: "x", type: "asset", payload: { src: "s", mime: "m" } }, ctx)).toMatch(/the app's schema/);  // base first
    expect(await c.check({ id: "x", type: "asset", payload: { title: "t" } }, ctx)).toMatch(/the asset schema/);
    expect([fetched, calls]).toEqual([0, []]);                                // schemas failed: no file read, no rules run

    expect(await c.check({ id: "a", type: "asset", payload: { title: "t", src: "s", mime: "m" } }, ctx)).toBe(null);
    expect(await c.check({ id: "s", type: "skill", payload: { title: "evil" } }, ctx)).toBe("bafyBaseRule: no evil");
    expect(await c.check({ id: "n", type: "note", payload: { title: "t" } }, { ...ctx, file: new Uint8Array([9]) })).toBe(null); // bytes in hand, as at /publish
    expect(calls.map(([rules, id, x]) => [rules.map((r) => r.src), id, x.publisher, x.repo, [...x.file]])).toEqual([
        [["bafyBaseRule", "bafyMime", "bafyGlb"], "a", "0xa", "isw", [1, 2]],
        [["bafyBaseRule", "bafyNoInjection"], "s", "0xa", "isw", [1, 2]],
        [["bafyBaseRule"], "n", "0xa", "isw", [9]]]);
    expect(calls[0][0][0]).toEqual({ name: "bafyBaseRule", src: "bafyBaseRule", params: {} });
    // a resolved reference: its name for the reason, its src to run, its `with` as params; an unresolved one is a deploy mistake
    const ref = { check: "0x0000000000000000000000000000000000000001/isw/mime", record: "bafyRec", src: "bafyMime", with: { allowed: ["image/png"] } };
    calls.length = 0;
    await (await checkerOf({ rules: [ref] }, validator)).check({ id: "p", type: "x", payload: { title: "t" } }, ctx);
    expect(calls[0][0]).toEqual([{ name: ref.check, src: "bafyMime", params: { allowed: ["image/png"] } }]);
    await expect(checkerOf({ rules: [{ check: ref.check }] }, validator)).rejects.toThrow(/isn't resolved/);

    expect(await c.check({ id: "b", type: "note", payload: { title: "t" } }, { ...ctx, file: new Uint8Array(25 * 1024 * 1024 + 1) })).toMatch(/over 25 MB/);
    const down = await checkerOf(CONFIG, { validate: async () => { throw new Error("validator down"); } });
    await expect(down.check({ id: "x", type: "note", payload: { title: "t" } }, ctx)).rejects.toThrow(/validator down/); // not a verdict
    await expect(checkerOf(CONFIG, undefined)).rejects.toThrow(/VALIDATOR/);  // rules, but not bound
    // schemas only: no validator needed; a schema CID left un-inlined is a deploy mistake, said loudly
    expect(await (await checkerOf({ schema: BASE }, undefined)).check({ id: "x", type: "any", payload: { title: "t" } }, ctx)).toBe(null);
    await expect(checkerOf({ schema: "bafySchema" }, undefined)).rejects.toThrow(/not inlined/);
});

test("validatorFiles: every hook under rules/<cid>/, one entrypoint that runs them in order", () => {
    const one = hookModules({ js: "export const validate = () => true;" });
    expect(one).toEqual({ files: { "validator.js": "export const validate = () => true;" }, types: { "validator.js": "ESModule" }, main: "validator.js" });

    const { files, rules } = validatorFiles({
        bafyMime: { js: "export const validate = () => true;" },
        bafyGlb: { mainModule: "src/main.js", modules: { "src/main.js": { js: "export default () => true" }, "glb.wasm": { wasm: btoa("\0asm") }, "magic.bin": { data: btoa("ab") }, "cfg.json": { json: { a: 1 } }, "old.cjs": { cjs: "module.exports = 1" }, "t.txt": { text: "hi" } } },
    });
    expect([...files["rules/bafyGlb/glb.wasm"]]).toEqual([0, 97, 115, 109]);
    expect(files["rules/bafyGlb/cfg.json"]).toBe('export default {"a":1};\n');
    expect(files["westmarch-validate.js"]).toContain('import * as h0 from "./rules/bafyMime/validator.js"');
    expect(files["westmarch-validate.js"]).toContain('import * as h1 from "./rules/bafyGlb/src/main.js"');
    expect(Object.fromEntries(rules.map((r) => [r.type, r.globs]))).toEqual({
        ESModule: ["westmarch-validate.js", "rules/bafyMime/validator.js", "rules/bafyGlb/src/main.js", "rules/bafyGlb/cfg.json"],
        CompiledWasm: ["rules/bafyGlb/glb.wasm"], Data: ["rules/bafyGlb/magic.bin"], CommonJS: ["rules/bafyGlb/old.cjs"], Text: ["rules/bafyGlb/t.txt"] });

    expect(() => hookModules({ mainModule: "x.js", modules: {} })).toThrow(/bundle is/);
    expect(() => hookModules({ html: "<p>" })).toThrow(/bundle is/);
    for (const name of ["../escape.js", "/abs.js", "a/./b.js"]) expect(() => hookModules({ mainModule: name, modules: { [name]: "" } })).toThrow(/plain relative path/);
    expect(() => hookModules({ mainModule: "a.js", modules: { "a.js": { exe: "x" } } })).toThrow(/module "a.js"/);
    expect(() => validatorFiles({ "../bafy": { js: "" } })).toThrow(/isn't a CID/);
    expect(() => validatorFiles({ bafyBroken1: { html: "" } })).toThrow(/hook bafyBroken1/);
    expect(validatorConfig("isw", rules)).toMatchObject({ name: "isw-validator", main: "westmarch-validate.js", no_bundle: true, workers_dev: false });
});

test("resolve: schema CIDs inlined, every hook fetched once, anything else refused", async () => {
    const store = { bafySchemaBase: BASE, bafySchemaAsset: { type: "object" }, bafyBaseRule: { js: "a" }, bafyMime: { js: "b" }, bafyGlb: { js: "c" }, bafyNoInjection: { js: "d" } };
    const got = [];
    const get = async (cid) => (got.push(cid), store[cid]);
    const { config, bundles } = await resolve({ ...CONFIG, schema: "bafySchemaBase", types: { ...CONFIG.types, asset: { ...CONFIG.types.asset, schema: "bafySchemaAsset" } } }, get, async () => null);
    expect(config.schema).toEqual(BASE);
    expect(config.types.asset.schema).toEqual({ type: "object" });
    expect(config.types.asset.rules).toEqual(["bafyMime", "bafyGlb"]);        // rules stay CIDs: the app sends them to its validator
    expect(config.types.note).toBe(CONFIG.types.note);
    expect(Object.keys(bundles)).toEqual(["bafyBaseRule", "bafyMime", "bafyGlb", "bafyNoInjection"]);
    expect(got.length).toBe(6);
    expect((await resolve({ types: { note: "x" } }, get, async () => null)).bundles).toEqual({});
    await expect(resolve({ schema: "https://schema.org/Thing" }, get, async () => null)).rejects.toThrow(/JSON Schema or its CID/);
    await expect(resolve({ rules: ["../x"] }, get, async () => null)).rejects.toThrow(/a rule is/);
});

test("resolve: a check reference pins its record and bundle, its `with` checked against its params", async () => {
    const P = "0x00000000000000000000000000000000000000aa", store = { bafyMimeBundle: { js: "x" } };
    const records = {
        [`${P}/isw/mime`]: { cid: "bafyMimeRec", type: "check", payload: { title: "mime", src: "bafyMimeBundle", params: { type: "object", required: ["allowed"], properties: { allowed: { type: "array", items: { type: "string" } } } } } },
        [`${P}/isw/game`]: { cid: "bafyGame", type: "game", payload: { src: "bafyHtml" } },
        [`${P}/isw/ai`]: { cid: "bafyAi", type: "check", payload: { src: "bafyAiBundle", needs: ["ai"] } },
    };
    const read = async (p, r, id) => records[`${p}/${r}/${id}`] ?? null, get = async (cid) => store[cid];
    const mime = { check: `${P}/isw/mime`, with: { allowed: ["image/png"] } };
    const { config, bundles } = await resolve({ types: { asset: { rules: [mime] } }, rules: [mime] }, get, read);
    expect(config.types.asset.rules).toEqual([{ check: `${P}/isw/mime`, record: "bafyMimeRec", src: "bafyMimeBundle", with: { allowed: ["image/png"] } }]);
    expect(config.rules).toEqual(config.types.asset.rules);
    expect(bundles).toEqual({ bafyMimeBundle: { js: "x" } });
    expect((await checkerOf(config, { validate: async () => true })).gates).toBeTruthy(); // what deploy writes, the Worker runs

    await expect(resolve({ rules: [{ check: `${P}/isw/mime`, with: { allowed: "png" } }] }, get, read)).rejects.toThrow(/doesn't match its params/);
    await expect(resolve({ rules: [{ check: `${P}/isw/mime` }] }, get, read)).rejects.toThrow(/doesn't match its params/);
    await expect(resolve({ rules: [{ check: `${P}/isw/game` }] }, get, read)).rejects.toThrow(/not a check/);
    await expect(resolve({ rules: [{ check: `${P}/isw/ai` }] }, get, read)).rejects.toThrow(/capabilities/);
    await expect(resolve({ rules: [{ check: `${P}/isw/nope` }] }, get, read)).rejects.toThrow(/no such record/);
    await expect(resolve({ rules: [{ check: "isw/mime" }] }, get, read)).rejects.toThrow(/a rule is/);
});
