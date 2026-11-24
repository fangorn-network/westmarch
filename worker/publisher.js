// Publishing into a person's own repo through an app: the record goes in THEIR repo, under their address, and the
// head only moves on their EIP-712 signature. The app builds the commit, gets it signed, and relays it (paying the gas).
//
// Signing is fangorn.network's: the person allows the app once at fangorn.network/#/connect (email sign-in), which
// gives their agent a grant token scoped to the app's repos. The app passes it on: GET /api/grant says whose it is,
// POST /api/sign signs an Update with their wallet if the grant covers it. The app holds no keys of theirs.
//
// The app relays with INDEXER_KEY, paying the gas: the SDK estimates first (a reverting update costs nothing) and
// waits for the receipt. One call can carry many records into one commit, and commits to many repos: those are
// signed in one /api/sign call and relayed in one transaction through Multicall3 (src/multicall.js).
// ponytail: one wallet, so two publishes in the same instant can collide on a nonce and one fails (the caller retries).
// Callers that publish on a timer (a logbook gateway) send one call per window, which never collides with itself.

import { recoverTypedDataAddress } from "viem";
import { stitchFilter } from "@fangorn-network/sdk";
import { patternsOf, reposOf, repoMatches } from "../src/stitcher.js";
import { relayAll } from "../src/multicall.js";
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

const wire = (message) => ({ ...message, epoch: String(message.epoch) });
/** sign(typedData) for publishAs, by fangorn.network on the grant's wallet: only the message travels. */
export const signerFor = (token, base = FANGORN) => async ({ message }) =>
    (await call(base, token, "/api/sign", { message: wire(message) })).signature;
/** signAll([typedData]) → [signature], in one /api/sign call (fangorn.network signs up to 50, all or none). */
export const batchSignerFor = (token, base = FANGORN) => async (typed) =>
    typed.length === 1 ? [await signerFor(token, base)(typed[0])]
        : (await call(base, token, "/api/sign", { messages: typed.map((t) => wire(t.message)) })).signatures;

/**
 * A commit of `records` on top of `owner`'s head of `repo`, ready to sign: { update, typedData, recordCids }.
 * Built the way the SDK's own reset builds one; settleable checks it's the next head.
 */
export async function prepare({ fangorn, owner, domain }, repo, records) {
    const base = await fangorn.engine.resolveHeadCommit(owner, repo);
    const { commitCid, recordCids } = await fangorn.engine.createCommit({ repo, base, records });
    const update = await fangorn.engine.settleable(owner, repo, commitCid);
    const config = fangorn.getConfig();
    const typedData = {
        domain: domain ?? dataDomain(config.chain.id, config.dataRegistryContractAddress),
        types: UPDATE_TYPES, primaryType: "Update", message: updateMessage(owner, update),
    };
    return { repo, records, update, typedData, recordCids };
}

/**
 * Commits ([{ repo, records }]) into `owner`'s repos: prepared by `fangorn` (the app), signed by
 * `signAll([typedData]) → [0x…]` (the owner's wallet, in one call), checked, relayed in one transaction, read back.
 * → [{ repo, cids: { id: cid }, txHash }]
 */
export async function publishAllAs({ fangorn, owner, signAll, domain, relay = relayAll }, commits) {
    const prepared = await Promise.all(commits.map((c) => prepare({ fangorn, owner, domain }, c.repo, c.records)));
    const signatures = await signAll(prepared.map((p) => p.typedData));
    for (const [i, p] of prepared.entries())
        if ((await recoverTypedDataAddress({ ...p.typedData, signature: signatures[i] })).toLowerCase() !== owner.toLowerCase())
            throw new Error("that signature isn't your wallet's: connect the app again at fangorn.network");
    const txHash = await relay(fangorn, prepared.map((p, i) => ({ publisher: owner, update: p.update, signature: signatures[i] })));
    for (const p of prepared) {
        const last = p.records.at(-1), landed = await fangorn.engine.readRecord(owner, p.repo, last.id).catch(() => null);
        if (landed?.cid !== p.recordCids[last.id]) throw new Error(`${p.repo}/${last.id}: tx ${txHash} didn't land; the head doesn't hold it. Publish again.`);
    }
    return prepared.map((p) => ({ repo: p.repo, cids: Object.fromEntries(p.records.map((r) => [r.id, p.recordCids[r.id]])), txHash }));
}

/**
 * One record ({ id, type, payload }) into `owner`'s `repo`: committed by `fangorn` (the app), signed by
 * `sign(typedData) → 0x…` (the owner's wallet), checked, relayed. → { publisher, repo, id, type, cid, txHash }
 * `domain`: the EIP-712 domain, by default the network's Fangorn Data registry's (tests pass their registry's).
 */
export async function publishAs({ fangorn, owner, sign, domain, relay }, repo, record) {
    const [out] = await publishAllAs({ fangorn, owner, domain, relay, signAll: async ([t]) => [await sign(t)] }, [{ repo, records: [record] }]);
    return { publisher: owner.toLowerCase(), repo, id: record.id, type: record.type, cid: out.cids[record.id], txHash: out.txHash };
}

const fail = (status, message) => Object.assign(new Error(message), { status });

export const MAX_FILE = 5 * 1024 * 1024;
export const MAX_RECORDS = 500; // per commit: what one CAR upload carries reliably
export const MAX_COMMITS = 50;  // per call: what fangorn.network signs at once // ponytail: base64 through one JSON body; signed uploads straight to storage past this

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
 * POST /publish, with a fangorn.network grant token as the bearer, into repos both the app follows (for the grant's
 * holder) and the grant covers. Three shapes:
 *   { repo?, record, file?, pin? }              one record (with a file, uploaded as payload.src)
 *   { repo?, records: [...], pin? }             many records, one commit
 *   { commits: [{ repo, records, pin? }, ...] } many repos, one transaction (each repo its own commit)
 * Off unless `config.publishPerDay` is set: the app pays the gas, so that many commits per UTC day, across everyone,
 * is what its plan allows. `meta` ({ get, set }) keeps the count, `published:<day>`, which is also the app's usage to
 * bill. `pin` names payload keys whose references are pinned. See worker/API.md.
 * `check(record, { publisher, repo, file })` → null | reason (src/validate.js): the app's format and validator, as its
 * index applies them, run on each record as it would land, before any gas; a reason is a 422.
 * Throws an Error with an HTTP `status`.
 */
export async function publish({ fangorn, config, meta, check, base = FANGORN, domain, relay }, token, body = {}) {
    const names = reposOf(config);
    if (!config.publishPerDay) throw fail(404, "this app doesn't publish");
    const many = Array.isArray(body.commits);
    if (many && (body.record || body.records || body.file)) throw fail(400, "send commits, or record(s), not both");
    const commits = many ? body.commits : [{ repo: body.repo, records: body.records ?? (body.record ? [body.record] : null), pin: body.pin }];
    if (!commits.length || commits.length > MAX_COMMITS) throw fail(400, `commits: 1 to ${MAX_COMMITS}`);
    const file = body.file;
    if (file !== undefined && (many || body.records)) throw fail(400, "a file goes with one record");
    for (const c of commits) {
        c.repo ??= names?.length === 1 && !names[0].endsWith("*") ? names[0] : undefined;
        if (typeof c.repo !== "string" || (names && !repoMatches(names, c.repo)))
            throw fail(404, c.repo ? `this app doesn't publish to "${c.repo}"` : `name the repo: one of ${names?.join(", ") ?? "the app's"}`);
        if (!Array.isArray(c.records) || !c.records.length || c.records.length > MAX_RECORDS) throw fail(400, `the body is { repo, record: { id, type, payload }, file?, pin? }, records: 1 to ${MAX_RECORDS}`);
        for (const r of c.records) {
            if (typeof r?.id !== "string" || typeof r?.type !== "string" || !r.id || !r.type) throw fail(400, "the body is { repo, record: { id, type, payload }, file?, pin? }");
            if (config.types && !Object.hasOwn(config.types, r.type)) throw fail(400, `type is one of ${Object.keys(config.types).join(", ")}`);
        }
        c.pin ??= [];
        if (!Array.isArray(c.pin) || !c.pin.every((k) => typeof k === "string")) throw fail(400, "pin is a list of payload keys");
    }
    if (new Set(commits.map((c) => c.repo)).size !== commits.length) throw fail(400, "one commit per repo");
    const bytes = file === undefined ? null : bytesOf(file);
    const grant = await grantOf(token, base).catch((e) => { throw fail(401, e.message); });
    const covered = (repo) => (grant.repos ?? []).some((r) => r.endsWith("*") ? repo.startsWith(r.slice(0, -1)) : r === repo);
    for (const { repo } of commits) {
        if (!covered(repo)) throw fail(403, `your grant doesn't cover "${repo}": connect the app again at fangorn.network`);
        if (!stitchFilter(patternsOf(config))(grant.address, repo)) throw fail(403, `this app doesn't follow ${grant.address}'s "${repo}"`);
    }
    // ponytail: read, then write, so a burst can overshoot the quota by a few. A Durable Object if it must be exact.
    const day = `published:${new Date().toISOString().slice(0, 10)}`, used = (await meta.get(day)) ?? 0;
    if (used + commits.length > config.publishPerDay) throw fail(429, `this app's ${config.publishPerDay} publishes for today are used`);

    const owner = grant.address, publisher = owner.toLowerCase();
    for (const c of commits) c.records = await Promise.all(c.records.map(async (r) => ({ ...r, payload: await pinned(fangorn, r.payload ?? {}, c.pin, { owner, repo: c.repo }) })));
    if (bytes) {
        const r = commits[0].records[0], json = "json" in file;
        r.payload.src = await fangorn.getStorage().putFile(bytes, json ? `${r.id}.json` : r.id);
        if (json) delete r.payload.mime; // a file without mime is JSON
        else r.payload.mime = file.mime;
    }
    // ponytail: checked after the file's upload (a schema can require payload.src), so a refused record leaves an unpinned
    // file in storage. Check before uploading, with src stubbed, if that adds up.
    if (check) for (const c of commits) for (const r of c.records) {
        const reason = await check(r, { publisher, repo: c.repo, file: bytes ?? undefined });
        if (reason) throw fail(422, many || c.records.length > 1 ? `${c.repo}/${r.id}: ${reason}` : reason);
    }
    const out = await publishAllAs({ fangorn, owner, signAll: batchSignerFor(token, base), domain, relay }, commits.map(({ repo, records }) => ({ repo, records })));
    await meta.set(day, used + commits.length);
    if (!many && !body.records) {
        const r = commits[0].records[0];
        return { publisher, repo: out[0].repo, id: r.id, type: r.type, cid: out[0].cids[r.id], txHash: out[0].txHash, ...(bytes && { src: r.payload.src }) };
    }
    return many ? { publisher, txHash: out[0].txHash, commits: out } : { publisher, ...out[0] };
}
