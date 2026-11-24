import { test, expect } from "vitest";
import { memoryNetwork } from "@fangorn-network/sdk/lib/test/testbed.js";
import { MEM_DOMAIN } from "@fangorn-network/sdk/lib/test/mem-registry.js";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { UPDATE_TYPES } from "@fangorn-network/sdk/lib/contracts/data-registry/index.js";
import { publishAs, publish, grantOf, signerFor, batchSignerFor } from "./publisher.js";
import { relayEach } from "../src/multicall.js";

test("the app publishes into the publisher's own repo, on the publisher's signature only", async () => {
    const net = memoryNetwork();
    const app = await net.client(), alice = privateKeyToAccount(generatePrivateKey()), mallory = privateKeyToAccount(generatePrivateKey());
    const as = (signer) => ({ fangorn: app, owner: alice.address, domain: MEM_DOMAIN, sign: (td) => signer.signTypedData(td) });

    const r = await publishAs(as(alice), "notes", { id: "a", type: "note", payload: { title: "a" } });
    expect(r).toMatchObject({ publisher: alice.address.toLowerCase(), repo: "notes", id: "a" });
    expect((await app.engine.readRecord(alice.address, "notes", "a")).cid).toBe(r.cid);
    expect(await app.engine.readRecord(app.getAddress(), "notes", "a").catch(() => null)).toBeFalsy(); // not the app's

    // a second commit builds on alice's head
    await publishAs(as(alice), "notes", { id: "b", type: "note", payload: { title: "b" } });
    expect((await app.engine.readRecord(alice.address, "notes", "a")).cid).toBe(r.cid);
    expect(await app.engine.readRecord(alice.address, "notes", "b")).toBeTruthy();

    // anyone else's signature is refused before anything is sent
    await expect(publishAs(as(mallory), "notes", { id: "evil", type: "note", payload: {} })).rejects.toThrow(/isn't your wallet's/);
    expect(await app.engine.readRecord(alice.address, "notes", "evil").catch(() => null)).toBeFalsy();
});

test("the handoff to fangorn.network: the grant token as bearer, only the message sent, epoch as a string", async () => {
    const seen = [], real = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
        seen.push({ url, init });
        if (url.endsWith("/api/grant")) return new Response(JSON.stringify({ address: "0xA", repos: ["notes"] }), { headers: { "content-type": "application/json" } });
        if (init.headers.authorization !== "Bearer fgn_ok") return new Response(JSON.stringify({ error: "no such grant" }), { status: 401, headers: { "content-type": "application/json" } });
        return new Response(JSON.stringify({ signature: "0xsig" }), { headers: { "content-type": "application/json" } });
    };
    try {
        expect(await grantOf("fgn_ok", "https://f")).toEqual({ address: "0xA", repos: ["notes"] });
        const typed = { domain: { name: "anything" }, types: {}, primaryType: "Update", message: { publisher: "0xA", repo: "notes", epoch: 7n } };
        expect(await signerFor("fgn_ok", "https://f")(typed)).toBe("0xsig");
        expect(JSON.parse(seen[1].init.body)).toEqual({ message: { publisher: "0xA", repo: "notes", epoch: "7" } }); // no domain: fangorn.network picks it
        await expect(signerFor("fgn_bad", "https://f")(typed)).rejects.toThrow(/no such grant/);
        globalThis.fetch = async () => new Response("<!doctype html>", { headers: { "content-type": "text/html" } }); // the site, no API
        await expect(grantOf("fgn_ok", "https://f")).rejects.toThrow(/without its API/);
    } finally { globalThis.fetch = real; }
});

// A stand-in fangorn.network: one grant (alice's, for `repos`), signing with alice's key.
function fakeFangornNetwork(alice, repos) {
    const real = globalThis.fetch, ok = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
    globalThis.fetch = async (url, init) => {
        if (init.headers.authorization !== "Bearer fgn_alice") return ok({ error: "no such grant" }, 401);
        if (url.endsWith("/api/grant")) return ok({ address: alice.address, app: "test", repos });
        const sign = (m) => alice.signTypedData({ domain: MEM_DOMAIN, types: UPDATE_TYPES, primaryType: "Update", message: { ...m, epoch: BigInt(m.epoch) } });
        const body = JSON.parse(init.body);
        if (body.messages) return ok({ signatures: await Promise.all(body.messages.map(sign)) });
        return ok({ signature: await sign(body.message) });
    };
    return () => { globalThis.fetch = real; };
}

test("POST /publish: a grant publishes into its holder's repo, within the app's daily quota", async () => {
    const net = memoryNetwork(), app = await net.client(), alice = privateKeyToAccount(generatePrivateKey());
    const meta = new Map(), restore = fakeFangornNetwork(alice, ["notes", "other"]);
    const at = (config) => ({ fangorn: app, config, meta: { get: async (k) => meta.get(k), set: async (k, v) => meta.set(k, v) }, base: "https://f", domain: MEM_DOMAIN });
    const on = at({ repos: ["notes"], publishPerDay: 2 });
    const note = (id) => ({ repo: "notes", record: { id, type: "note", payload: { id } } });
    const status = (p) => p.then(() => 200, (e) => e.status);
    try {
        const r = await publish(on, "fgn_alice", note("a"));
        expect(r).toMatchObject({ publisher: alice.address.toLowerCase(), repo: "notes", id: "a" });
        expect((await app.engine.readRecord(alice.address, "notes", "a")).cid).toBe(r.cid);

        expect(await status(publish(on, "fgn_mallory", note("x")))).toBe(401); // not a grant
        expect(await status(publish(on, "fgn_alice", { repo: "notes", record: { payload: {} } }))).toBe(400);
        expect(await status(publish(on, "fgn_alice", { ...note("x"), repo: "other" }))).toBe(404); // granted, not this app's
        expect(await status(publish(at({ repos: ["notes", "x"], publishPerDay: 9 }), "fgn_alice", { ...note("x"), repo: "x" }))).toBe(403); // the app's, not granted
        expect(await status(publish(at({ repos: ["notes"] }), "fgn_alice", note("x")))).toBe(404); // publishing off
        expect(await status(publish(at({ follow: ["0x0000000000000000000000000000000000000001/notes"], publishPerDay: 9 }), "fgn_alice", note("x")))).toBe(403); // the app follows someone else's "notes"

        await publish(on, "fgn_alice", note("b"));
        expect(await status(publish(on, "fgn_alice", note("c")))).toBe(429);
        expect([...meta.values()]).toEqual([2]); // usage per UTC day: what the app is billed on
    } finally { restore(); }
});

test("POST /publish: the repo by default, types checked, a file uploaded as src, references pinned", async () => {
    const net = memoryNetwork(), app = await net.client(), alice = privateKeyToAccount(generatePrivateKey());
    const meta = new Map(), restore = fakeFangornNetwork(alice, ["parts"]);
    const on = { fangorn: app, config: { repos: ["parts"], publishPerDay: 9, types: { game: "g", asset: "a" } }, meta: { get: async (k) => meta.get(k), set: async (k, v) => meta.set(k, v) }, base: "https://f", domain: MEM_DOMAIN };
    const status = (p) => p.then(() => 200, (e) => e.status);
    const text = async (src) => new TextDecoder().decode(await app.getStorage().getFile(src));
    try {
        // no repo: the app's only one; a JSON file becomes payload.src, without mime
        const cube = await publish(on, "fgn_alice", { record: { id: "cube", type: "game", payload: { title: "cube", mime: "x/y" } }, file: { json: { html: "<p>cube</p>" } } });
        expect(cube).toMatchObject({ repo: "parts", id: "cube", src: expect.any(String) });
        const c = await app.engine.readRecord(alice.address, "parts", "cube");
        expect(c.payload).toEqual({ title: "cube", src: cube.src });
        expect(JSON.parse(await text(cube.src))).toEqual({ html: "<p>cube</p>" });

        // bytes keep their mime
        const orb = await publish(on, "fgn_alice", { record: { id: "orb", type: "asset", payload: {} }, file: { base64: btoa("\x01\x02"), mime: "model/gltf-binary" } });
        expect((await app.engine.readRecord(alice.address, "parts", "orb")).payload).toEqual({ src: orb.src, mime: "model/gltf-binary" });

        // references pinned to the version current now: one, and a list
        const cubes = await publish(on, "fgn_alice", { record: { id: "cubes", type: "game", payload: { parent: { id: "cube" }, uses: [{ id: "orb" }, { publisher: alice.address, repo: "parts", id: "cube" }] } }, pin: ["parent", "uses", "absent"] });
        const p = (await app.engine.readRecord(alice.address, "parts", "cubes")).payload, me = alice.address.toLowerCase();
        expect(p.parent).toEqual({ publisher: me, repo: "parts", id: "cube", cid: cube.cid, type: "game" });
        expect(p.uses).toEqual([{ publisher: me, repo: "parts", id: "orb", cid: orb.cid, type: "asset" }, p.parent]);
        expect(p.absent).toBeUndefined();
        expect(cubes.src).toBeUndefined();

        expect(await status(publish(on, "fgn_alice", { record: { id: "x", type: "memo" } }))).toBe(400); // not one of types
        expect(await status(publish(on, "fgn_alice", { record: { id: "x", type: "game", payload: { parent: { id: "nope" } } }, pin: ["parent"] }))).toBe(400);
        expect(await status(publish(on, "fgn_alice", { record: { id: "x", type: "game" }, file: { base64: "!!", mime: "a/b" } }))).toBe(400);
        expect(await status(publish(on, "fgn_alice", { record: { id: "x", type: "game" }, file: { base64: "AA==" } }))).toBe(400); // bytes need mime
        expect(await status(publish(on, "fgn_alice", { record: { id: "x", type: "game" }, file: { json: "x".repeat(5 * 1024 * 1024) } }))).toBe(400);
        expect(await status(publish(on, "fgn_alice", { record: { id: "x", type: "game" }, pin: "parent" }))).toBe(400);
        expect(await status(publish({ ...on, config: { repos: ["parts", "more"], publishPerDay: 9 } }, "fgn_alice", { record: { id: "x", type: "game" } }))).toBe(404); // two repos: name one
        expect([...meta.values()]).toEqual([3]); // refused publishes aren't counted
    } finally { restore(); }
});

test("POST /publish: the app's check refuses before any gas, with its reason, outside the quota", async () => {
    const net = memoryNetwork(), app = await net.client(), alice = privateKeyToAccount(generatePrivateKey());
    const meta = new Map(), restore = fakeFangornNetwork(alice, ["isw"]), seen = [];
    const check = async (record, ctx) => (seen.push({ record, ctx }), record.payload.title === "evil" ? "no evil" : null);
    const on = { fangorn: app, config: { repos: ["isw"], publishPerDay: 5 }, meta: { get: async (k) => meta.get(k), set: async (k, v) => meta.set(k, v) }, check, base: "https://f", domain: MEM_DOMAIN };
    try {
        const e = await publish(on, "fgn_alice", { record: { id: "x", type: "game", payload: { title: "evil" } }, file: { json: { html: "<p>" } } }).catch((e) => e);
        expect([e.status, e.message]).toEqual([422, "no evil"]);
        expect(await app.engine.readRecord(alice.address, "isw", "x").catch(() => null)).toBeFalsy();
        expect(meta.size).toBe(0);                                              // not counted
        // the check sees the record as it would land (src set) and the file's bytes
        expect(seen[0].record.payload.src).toBeTruthy();
        expect(seen[0].ctx).toMatchObject({ publisher: alice.address.toLowerCase(), repo: "isw" });
        expect(new TextDecoder().decode(seen[0].ctx.file)).toBe('{"html":"<p>"}');
        expect(await publish(on, "fgn_alice", { record: { id: "y", type: "game", payload: { title: "fine" } } })).toMatchObject({ id: "y" });
    } finally { restore(); }
});

test("POST /publish: many records in one commit, and commits to many repos (by prefix) in one call", async () => {
    const net = memoryNetwork(), app = await net.client(), alice = privateKeyToAccount(generatePrivateKey());
    const meta = new Map(), restore = fakeFangornNetwork(alice, ["lb-*"]);
    const on = { fangorn: app, config: { repos: ["lb-*"], publishPerDay: 4 }, meta: { get: async (k) => meta.get(k), set: async (k, v) => meta.set(k, v) }, base: "https://f", domain: MEM_DOMAIN, relay: relayEach };
    const status = (p) => p.then(() => 200, (e) => e.status);
    const ev = (n) => ({ id: `e/${n}`, type: "event", payload: { n } });
    try {
        const one = await publish(on, "fgn_alice", { repo: "lb-storms", records: [ev(0), ev(1), ev(2)] });
        expect(Object.keys(one.cids)).toEqual(["e/0", "e/1", "e/2"]);
        expect((await app.engine.readRecord(alice.address, "lb-storms", "e/1")).cid).toBe(one.cids["e/1"]);

        const out = await publish(on, "fgn_alice", { commits: [
            { repo: "lb-storms", records: [ev(3), { id: "b/1", type: "batch", payload: { prev: { id: "e/2" } } }], pin: ["prev"] },
            { repo: "lb-rivers", records: [ev(0)] },
        ] });
        expect(out.commits.map((c) => c.repo)).toEqual(["lb-storms", "lb-rivers"]);
        expect((await app.engine.readRecord(alice.address, "lb-rivers", "e/0")).cid).toBe(out.commits[1].cids["e/0"]);
        expect((await app.engine.readRecord(alice.address, "lb-storms", "b/1")).payload.prev).toMatchObject({ id: "e/2", cid: one.cids["e/2"] });
        expect([...meta.values()]).toEqual([3]); // one per commit

        expect(await status(publish(on, "fgn_alice", { commits: [{ repo: "lb-a", records: [ev(0)] }, { repo: "lb-b", records: [ev(0)] }] }))).toBe(429); // 3 + 2 > 4
        expect(await status(publish(on, "fgn_alice", { commits: [{ repo: "notes", records: [ev(0)] }] }))).toBe(404);          // not the app's
        expect(await status(publish(on, "fgn_alice", { commits: [{ repo: "lb-a", records: [ev(0)] }, { repo: "lb-a", records: [ev(1)] }] }))).toBe(400);
        expect(await status(publish(on, "fgn_alice", { records: [ev(0)] }))).toBe(404);                                        // a prefix isn't a default repo
        expect(await status(publish(on, "fgn_alice", { repo: "lb-a", records: [ev(0)], file: { json: {} } }))).toBe(400);
        expect(await status(publish({ ...on, config: { repos: ["lb-*", "x-*"], publishPerDay: 9 } }, "fgn_alice", { repo: "x-1", records: [ev(0)] }))).toBe(403); // the app's, not granted
    } finally { restore(); }
});

test("batch signing: one /api/sign call with every message, epochs as strings", async () => {
    const seen = [], real = globalThis.fetch;
    globalThis.fetch = async (url, init) => { seen.push(JSON.parse(init.body)); return new Response(JSON.stringify({ signatures: ["0x1", "0x2"] }), { headers: { "content-type": "application/json" } }); };
    try {
        const t = (repo) => ({ message: { publisher: "0xA", repo, epoch: 7n } });
        expect(await batchSignerFor("fgn_ok", "https://f")([t("a"), t("b")])).toEqual(["0x1", "0x2"]);
        expect(seen).toEqual([{ messages: [{ publisher: "0xA", repo: "a", epoch: "7" }, { publisher: "0xA", repo: "b", epoch: "7" }] }]);
    } finally { globalThis.fetch = real; }
});
