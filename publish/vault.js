// Your taste, sealed to your wallet, kept in Fangorn.
//
// WHY NOT localStorage, AND WHY NOT A URL
// ---------------------------------------
// `localStorage` is origin-scoped, so a taste learned in one app is invisible to
// the next, and gone when the browser is. Passing it in a `?taste=` query fixes
// the first problem and none of the others: it cannot survive a new machine, it
// leaks the object into every referrer header and server log along the way, and
// it makes the person responsible for carrying their own state around by hand.
//
// So the taste goes where every other durable thing in this system goes — the
// graph — and the wallet is what opens it. Same wallet on a new laptop, same
// taste, no export, no backup file, nothing to lose.
//
// WHY IT IS ENCRYPTED, WHICH IS NOT OPTIONAL
// ------------------------------------------
// A taste vector is not metadata about behaviour, it IS the behaviour: μ is where
// you are, `no` is what you rejected, and both are directly comparable to every
// corpus on the network. Publishing that in the clear, on a public chain, bound
// permanently to an address, would build exactly the profile this project exists
// to refuse — and worse than the ad networks do, because a chain does not forget
// and cannot be asked to delete.
//
// The key is derived from ONE deterministic signature over a fixed string, which
// is the same trick `sond3r/src/pay/buy.js:deriveBuyer` already uses to re-derive
// a Semaphore identity on a machine that has never seen it. ECDSA signing is
// deterministic (RFC 6979), so the wallet is the only input.
//
// The string is DIFFERENT from the identity one on purpose. Two secrets derived
// from one signature are one secret, and the buyer identity is used to prove
// payment — a vault that shared it would let anyone who could open your taste
// also spend your entitlements.
//
// ponytail: a single key for the whole vault, rotated by nobody. Rotation needs
// somewhere to put the version, and there is no second reader to coordinate with
// yet. Add a `keyEpoch` to the vertex when one exists.

const ENC = new TextEncoder();
const DEC = new TextDecoder();

/** The string the wallet signs. Domain-separated from `fangorn:identity:v1`. */
export const VAULT_MESSAGE = "fangorn:taste-vault:v1";
/** What a sealed blob announces itself as, so a reader can refuse politely. */
export const VAULT_VERSION = 1;

const b64 = (u8) => btoa(String.fromCharCode(...u8));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/**
 * Wallet → the AES key that opens this person's vault.
 *
 * `walletClient` is anything with `signMessage({ account, message })` — viem's
 * local account, a browser wallet, or a Privy signer. The signature never leaves
 * this function; what comes back is a non-extractable CryptoKey.
 */
export async function vaultKey(walletClient) {
    const account = walletClient.account;
    const signature = await walletClient.signMessage({ account, message: VAULT_MESSAGE });
    // HKDF, not the raw signature. A signature is 65 bytes of structured data
    // with a recoverable public key in it — fine as key MATERIAL, wrong as a key.
    const material = await crypto.subtle.importKey("raw", ENC.encode(signature), "HKDF", false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
        { name: "HKDF", hash: "SHA-256", salt: ENC.encode("fangorn/taste-vault"), info: ENC.encode(VAULT_VERSION.toString()) },
        material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"],
    );
}

/** Seal any JSON-able object. A fresh IV every time, so two seals of the same
 *  taste are not recognisably the same taste to anyone watching the chain. */
export async function seal(key, obj) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, ENC.encode(JSON.stringify(obj)));
    return { v: VAULT_VERSION, iv: b64(iv), ct: b64(new Uint8Array(ct)) };
}

/** Open a sealed blob, or null. Null rather than throw: the common failure is
 *  the wrong wallet, which is a question to ask the person, not a crash. */
export async function open(key, blob) {
    if (!blob || blob.v !== VAULT_VERSION || !blob.iv || !blob.ct) return null;
    try {
        const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(blob.iv) }, key, unb64(blob.ct));
        return JSON.parse(DEC.decode(pt));
    } catch { return null; }
}

/**
 * The vertex this becomes in the reader's own namespace.
 *
 * One id, overwritten on every sync, because a taste has no history worth keeping
 * on-chain — and a chain of past selves is precisely the profile the encryption
 * exists to prevent. The payload carries no `path`, so it never appears in an
 * app's file tree; it is state, not content.
 */
export const TASTE_ID = "self/taste";
export const tasteVertex = (blob) => ({
    id: TASTE_ID, tag: "taste",
    payload: { kind: "taste", model: "nomic-256", enc: `vault-v${VAULT_VERSION}`, blob: JSON.stringify(blob) },
});

/** Pull the sealed blob back out of whatever `fangorn read` handed over. */
export function tasteFrom(vertices = []) {
    const v = vertices.find((x) => (x.payload ?? x)?.kind === "taste");
    if (!v) return null;
    try { return JSON.parse((v.payload ?? v).blob); } catch { return null; }
}

// ── self-check: `node publish/vault.js` ───────────────────────────────────
if (typeof process !== "undefined" && import.meta.url === `file://${process.argv[1]}`) {
    const { privateKeyToAccount } = await import("viem/accounts");
    const KEY_A = `0x${"11".repeat(32)}`, KEY_B = `0x${"22".repeat(32)}`;
    // A "machine": a fresh client over the same key, holding no state at all.
    const machine = (pk) => { const account = privateKeyToAccount(pk); return { account, signMessage: (a) => account.signMessage(a) }; };

    const TASTE = { v: 1, model: "nomic-256", q: "AQIDBA==", mu: "BQYHCA==", from: ["Nosferatu (1922)"], rejected: ["a sitcom"], n: 6 };

    const k1 = await vaultKey(machine(KEY_A));
    const blob = await seal(k1, TASTE);
    if (JSON.stringify(await open(k1, blob)) !== JSON.stringify(TASTE)) throw new Error("round trip must be exact");

    // THE POINT: a different machine, no shared state, same wallet — same taste.
    const k2 = await vaultKey(machine(KEY_A));
    if (JSON.stringify(await open(k2, blob)) !== JSON.stringify(TASTE)) throw new Error("the same wallet on a new machine must open the vault");

    // …and nobody else's wallet does.
    if (await open(await vaultKey(machine(KEY_B)), blob) !== null) throw new Error("another wallet must not open it");

    // The chain sees ciphertext and nothing else. The titles are the part that
    // would identify a person, so they are the part that must not survive.
    const wire = JSON.stringify(tasteVertex(blob));
    for (const secret of ["Nosferatu", "sitcom", "AQIDBA==", "nomic-256\",\"q\""]) {
        if (wire.includes(secret)) throw new Error(`the published vertex leaks ${JSON.stringify(secret)}`);
    }
    if (!wire.includes("vault-v1")) throw new Error("a reader must be able to tell what sealed this");
    if (wire.includes("\"path\"")) throw new Error("a taste is state, not a file — it must not enter an app's tree");

    // Two seals of one taste must not be recognisably equal to an observer.
    const again = await seal(k1, TASTE);
    if (again.ct === blob.ct || again.iv === blob.iv) throw new Error("a fresh IV every seal, or syncing twice announces 'unchanged'");
    if (JSON.stringify(await open(k1, again)) !== JSON.stringify(TASTE)) throw new Error("…and both must still open");

    // Tampering is caught by GCM rather than producing plausible garbage.
    const bad = { ...blob, ct: blob.ct.slice(0, -4) + (blob.ct.endsWith("A") ? "BBBB" : "AAAA") };
    if (await open(k1, bad) !== null) throw new Error("a modified blob must not open");
    if (await open(k1, { ...blob, v: 99 }) !== null) throw new Error("an unknown version must be refused, not guessed at");
    if (await open(k1, null) !== null || await open(k1, {}) !== null) throw new Error("absent input reads as absent, not as a crash");

    // Domain separation: the vault key must not be the buyer identity's secret.
    const acct = privateKeyToAccount(KEY_A);
    const idSig = await acct.signMessage({ message: "fangorn:identity:v1" });
    const vaultSig = await acct.signMessage({ message: VAULT_MESSAGE });
    if (idSig === vaultSig) throw new Error("one signature for two secrets is one secret — opening a vault would grant spending");

    // Round-trips out of the shape `fangorn read` returns.
    if (JSON.stringify(tasteFrom([{ payload: { kind: "other" } }, tasteVertex(blob).payload ? tasteVertex(blob) : null].filter(Boolean))) !== JSON.stringify(blob)) {
        throw new Error("the blob must survive a trip through the graph");
    }
    if (tasteFrom([]) !== null) throw new Error("an empty namespace is no taste, not a crash");

    console.log("vault.js self-check ok — one deterministic signature opens it on any machine, no other wallet opens it, "
        + "the published vertex carries ciphertext and no title, a fresh IV per sync, tampering and unknown versions refused, "
        + "and the vault key is domain-separated from the buyer identity");
}
