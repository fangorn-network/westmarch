import { test, expect } from "vitest";
import { memoryNetwork } from "@fangorn-network/sdk/lib/test/testbed.js";
import { MEM_DOMAIN } from "@fangorn-network/sdk/lib/test/mem-registry.js";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { publishAs, grantOf, signerFor } from "./publisher.js";

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
