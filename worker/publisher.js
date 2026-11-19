// Publishing into a person's own repo through an app: the record goes in THEIR repo, under their address, and the
// head only moves on their EIP-712 signature. The app builds the commit, gets it signed, and relays it (paying the gas).
//
// Signing is fangorn.network's: the person allows the app once at fangorn.network/#/connect (email sign-in), which
// gives their agent a grant token scoped to the app's repos. The app passes it on: GET /api/grant says whose it is,
// POST /api/sign signs an Update with their wallet if the grant covers it. The app holds no keys of theirs.
//
// The app relays with INDEXER_KEY, paying the gas: the SDK estimates first (a reverting update costs nothing) and
// waits for the receipt.
// ponytail: one wallet, so two publishes in the same instant can collide on a nonce and one fails (the caller retries).
// Queue them and send in batches through Multicall3 (updateBySig doesn't care who sends it) when that shows up.

import { recoverTypedDataAddress } from "viem";
import { stitchFilter } from "@fangorn-network/sdk";
import { patternsOf, reposOf } from "../src/stitcher.js";
import { UPDATE_TYPES, dataDomain, updateMessage } from "@fangorn-network/sdk/lib/contracts/data-registry/index.js";

export const FANGORN = "https://fangorn.network";

const call = async (base, token, path, body) => {
    const res = await fetch(`${base}${path}`, { method: body ? "POST" : "GET", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body && JSON.stringify(body) });
    // Not JSON is a fangorn.network without /api (its site answers every path): as much a failure as an error status.
    const out = res.headers.get("content-type")?.includes("json") ? await res.json().catch(() => null) : null;
    if (!res.ok || !out) throw new Error(`fangorn.network: ${out?.error ?? `answered ${res.status} without its API; is it deployed?`}`);
    return out;
};

/** Whose grant a token is: { address, app, repos }. */
export const grantOf = (token, base = FANGORN) => call(base, token, "/api/grant");

/** sign(typedData) for publishAs, by fangorn.network on the grant's wallet: only the message travels. */
export const signerFor = (token, base = FANGORN) => async ({ message }) =>
    (await call(base, token, "/api/sign", { message: { ...message, epoch: String(message.epoch) } })).signature;

/**
 * One record ({ id, type, payload }) into `owner`'s `repo`: committed by `fangorn` (the app), signed by
 * `sign(typedData) → 0x…` (the owner's wallet), checked, relayed. → { publisher, repo, id, type, cid, txHash }
 * `domain`: the EIP-712 domain, by default the network's Fangorn Data registry's (tests pass their registry's).
 */
export async function publishAs({ fangorn, owner, sign, domain }, repo, record) {
    // The commit on top of the owner's head, the way the SDK's own reset builds one; settleable checks it's the next head.
    const base = await fangorn.engine.resolveHeadCommit(owner, repo);
    const { commitCid, recordCids } = await fangorn.engine.createCommit({ repo, base, records: [record] });
    const update = await fangorn.engine.settleable(owner, repo, commitCid);
    const config = fangorn.getConfig();
    const typedData = {
        domain: domain ?? dataDomain(config.chain.id, config.dataRegistryContractAddress),
        types: UPDATE_TYPES, primaryType: "Update", message: updateMessage(owner, update),
    };
    const signature = await sign(typedData);
    if ((await recoverTypedDataAddress({ ...typedData, signature })).toLowerCase() !== owner.toLowerCase())
        throw new Error("that signature isn't your wallet's: connect the app again at fangorn.network");
    const txHash = await fangorn.relayPush({ publisher: owner, update, signature });
    const landed = await fangorn.engine.readRecord(owner, repo, record.id).catch(() => null);
    if (landed?.cid !== recordCids[record.id]) throw new Error(`${record.id}: tx ${txHash} didn't land; the head doesn't hold it. Publish again.`);
    return { publisher: owner.toLowerCase(), repo, id: record.id, type: record.type, cid: recordCids[record.id], txHash };
}

const fail = (status, message) => Object.assign(new Error(message), { status });

export const MAX_FILE = 5 * 1024 * 1024; // ponytail: base64 through one JSON body; signed uploads straight to storage past this

/** A publish's `file` → its bytes, or a 400. `{ json }` is stored as JSON, `{ base64, mime }` as the bytes. */
function bytesOf(file) {
    let bytes;
    if (file && typeof file === "object" && "json" in file) bytes = new TextEncoder().encode(JSON.stringify(file.json));
    else if (typeof file?.base64 === "string" && typeof file.mime === "string" && file.mime) {
        try { bytes = Uint8Array.from(atob(file.base64), (c) => c.charCodeAt(0)); } catch { throw fail(400, "file.base64 isn't base64"); }
    } else throw fail(400, "file is { json } or { base64, mime }");
    if (bytes.length > MAX_FILE) throw fail(400, `files are up to ${MAX_FILE >> 20} MB`);
    return bytes;
}

/**
 * The payload with each `pin` key's reference ({ publisher?, repo?, id }, or an array of them) replaced by that record
 * at its current version: { publisher, repo, id, cid, type }. One head and one state read per repo, however many
 * references it holds (a Worker run has few subrequests). A reference to nothing is a 400.
 */
async function pinned(fangorn, payload, pin, { owner, repo }) {
    const repos = new Map();
    const stateOf = (publisher, name) => {
        const key = `${publisher.toLowerCase()}/${name}`;
        if (!repos.has(key)) repos.set(key, (async () => {
            const head = await fangorn.engine.resolveHeadCommit(publisher, name)
                .catch((e) => { if (/has no on-chain commits/.test(e?.message)) return null; throw e; });
            return head && { head, state: (await fangorn.engine.stateAt(head)).state };
        })());
        return repos.get(key);
    };
    const one = async (ref) => {
        if (typeof ref?.id !== "string") throw fail(400, "a pinned reference is { publisher?, repo?, id }");
        const publisher = ref.publisher ?? owner, name = ref.repo ?? repo, at = await stateOf(publisher, name), cid = at?.state.get(ref.id);
        if (!cid) throw fail(400, `no record ${publisher}/${name}/${ref.id} to pin`);
        const record = await fangorn.engine.decodeRecord(ref.id, cid, at.head);
        return { publisher: publisher.toLowerCase(), repo: name, id: ref.id, cid: record.cid ?? cid.toString(), type: record.type };
    };
    const out = { ...payload };
    for (const key of pin) {
        if (out[key] == null) continue;
        out[key] = Array.isArray(out[key]) ? await Promise.all(out[key].map(one)) : await one(out[key]);
    }
    return out;
}

/**
 * POST /publish, `{ repo?, record, file?, pin? }` with a fangorn.network grant token as the bearer: publishAs, for
 * the grant's holder, into a repo both the app follows (for that holder) and the grant covers. Off unless
 * `config.publishPerDay` is set: the app pays the gas, so that many publishes per UTC day, across everyone, is what its
 * plan allows. `meta` ({ get, set }) keeps the count, `published:<day>`, which is also the app's usage to bill.
 * `file` goes to storage as `payload.src`; `pin` names payload keys whose references are pinned. See worker/API.md.
 * `check(record, { publisher, repo, file })` → null | reason (src/validate.js): the app's format and validator, as its
 * index applies them, run on the record as it would land, before any gas; a reason is a 422.
 * Throws an Error with an HTTP `status`.
 */
export async function publish({ fangorn, config, meta, check, base = FANGORN, domain }, token, { repo, record, file, pin = [] } = {}) {
    const names = reposOf(config);
    repo ??= names?.length === 1 ? names[0] : undefined;
    if (!config.publishPerDay || (names && !names.includes(repo))) throw fail(404, repo ? `this app doesn't publish to "${repo}"` : `name the repo: one of ${names?.join(", ") ?? "the app's"}`);
    if (typeof record?.id !== "string" || typeof record?.type !== "string" || !record.id || !record.type)
        throw fail(400, "the body is { repo, record: { id, type, payload }, file?, pin? }");
    if (config.types && !Object.hasOwn(config.types, record.type)) throw fail(400, `type is one of ${Object.keys(config.types).join(", ")}`);
    if (!Array.isArray(pin) || !pin.every((k) => typeof k === "string")) throw fail(400, "pin is a list of payload keys");
    const bytes = file === undefined ? null : bytesOf(file);
    const grant = await grantOf(token, base).catch((e) => { throw fail(401, e.message); });
    if (!grant.repos?.includes(repo)) throw fail(403, `your grant doesn't cover "${repo}": connect the app again at fangorn.network`);
    if (!stitchFilter(patternsOf(config))(grant.address, repo)) throw fail(403, `this app doesn't follow ${grant.address}'s "${repo}"`);
    // ponytail: read, then write, so a burst can overshoot the quota by a few. A Durable Object if it must be exact.
    const day = `published:${new Date().toISOString().slice(0, 10)}`, used = (await meta.get(day)) ?? 0;
    if (used >= config.publishPerDay) throw fail(429, `this app's ${config.publishPerDay} publishes for today are used`);

    const payload = await pinned(fangorn, record.payload ?? {}, pin, { owner: grant.address, repo });
    if (bytes) {
        const json = "json" in file;
        payload.src = await fangorn.getStorage().putFile(bytes, json ? `${record.id}.json` : record.id);
        if (json) delete payload.mime; // a file without mime is JSON
        else payload.mime = file.mime;
    }
    // ponytail: checked after the file's upload (a schema can require payload.src), so a refused record leaves an unpinned
    // file in storage. Check before uploading, with src stubbed, if that adds up.
    const reason = check && await check({ ...record, payload }, { publisher: grant.address.toLowerCase(), repo, file: bytes ?? undefined });
    if (reason) throw fail(422, reason);
    const out = await publishAs({ fangorn, owner: grant.address, sign: signerFor(token, base), domain }, repo, { ...record, payload });
    await meta.set(day, used + 1);
    return bytes ? { ...out, src: payload.src } : out;
}
