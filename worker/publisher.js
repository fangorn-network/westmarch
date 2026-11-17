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

/**
 * POST /publish, `{ repo, record }` with a fangorn.network grant token as the bearer: publishAs, for the grant's
 * holder, into a repo both the app (`config.repos`) and the grant cover. Off unless `config.publishPerDay` is set:
 * the app pays the gas, so that many publishes per UTC day, across everyone, is what its plan allows. `meta`
 * ({ get, set }) keeps the count, `published:<day>`, which is also the app's usage to bill.
 * Throws an Error with an HTTP `status`.
 */
export async function publish({ fangorn, config, meta, base = FANGORN, domain }, token, { repo, record } = {}) {
    if (!config.publishPerDay || !config.repos.includes(repo)) throw fail(404, `this app doesn't publish to "${repo}"`);
    if (!record?.id || !record?.type) throw fail(400, "the body is { repo, record: { id, type, payload } }");
    const grant = await grantOf(token, base).catch((e) => { throw fail(401, e.message); });
    if (!grant.repos?.includes(repo)) throw fail(403, `your grant doesn't cover "${repo}": connect the app again at fangorn.network`);
    // ponytail: read, then write, so a burst can overshoot the quota by a few. A Durable Object if it must be exact.
    const day = `published:${new Date().toISOString().slice(0, 10)}`, used = (await meta.get(day)) ?? 0;
    if (used >= config.publishPerDay) throw fail(429, `this app's ${config.publishPerDay} publishes for today are used`);
    const out = await publishAs({ fangorn, owner: grant.address, sign: signerFor(token, base), domain }, repo, record);
    await meta.set(day, used + 1);
    return out;
}
