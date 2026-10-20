// The reader's wallet: sign in (Privy: email or Google, an embedded wallet made on first
// login, no passwords), see the balance, add funds, and pay for a record over x402, the same
// way an agent does. One Privy app for every Fangorn app, so one wallet across all of them.
//
// Loaded only when a reader asks for it (Sign in, Buy): React and Privy are a large download,
// and a reader who only searches never needs them. The page is plain JS; Privy's SDK is React,
// so a React root with no UI of its own holds the hooks and hands their functions to the page.
//
// VITE_PRIVY_APP_ID is set at build time (site/.env). The Privy app must list every app's
// domain under allowed origins.
import { arbitrum, arbitrumSepolia, base, baseSepolia } from "viem/chains";
import { buyPass, buyRecord, readAsMember } from "../src/agent/x402.js";

const APP_ID = import.meta.env.VITE_PRIVY_APP_ID;
// By x402 network (CAIP-2), as the card names it.
const CHAINS = Object.fromEntries([baseSepolia, base, arbitrumSepolia, arbitrum].map((c) => [`eip155:${c.id}`, c]));
// Card onramps sell real USDC only, so a testnet app sends readers to a faucet instead.
const FAUCET = Object.fromEntries([baseSepolia, arbitrumSepolia].map((c) => [`eip155:${c.id}`, "https://faucet.circle.com/"]));

let booted = null;
/** The wallet, once Privy is ready. `paid` is the agent card's paid params (network, asset, …). */
export function wallet(paid) {
    return (booted ??= boot(paid));
}

async function boot(paid) {
    if (!APP_ID) throw new Error("this site was built without VITE_PRIVY_APP_ID");
    const [React, { createRoot }, privy, viem] = await Promise.all([
        import("react"), import("react-dom/client"), import("@privy-io/react-auth"), import("viem")]);
    const chain = CHAINS[paid.network];
    if (!chain) throw new Error(`no chain for ${paid.network}`);
    const rpc = viem.createPublicClient({ chain, transport: viem.http() });
    const M = paid.membership ?? null;
    const REG = viem.parseAbi(["function canRead(uint256 tokenId, address who) view returns (bytes32, uint64)",
                               "function planOf(bytes32 app_id) view returns (uint256 price, uint64 period)"]);
    const listeners = new Set();
    const api = {
        chain, faucet: FAUCET[paid.network] ?? null, address: null, authenticated: false,
        /** Calls `f(api)` now and on every change (signed in, wallet made, signed out). */
        onChange(f) { listeners.add(f); f(api); return () => listeners.delete(f); },
        /** Signed in with a wallet, opening Privy's login if need be. */
        async signIn() {
            // onChange calls back at once: with an address already, `off` below would not exist yet.
            if (api.address) return api;
            if (!api.authenticated) api.login();
            return new Promise((ok) => { const off = api.onChange((a) => { if (a.address) { off(); ok(a); } }); });
        },
        /** The wallet's balance in the app's token, as a number of whole tokens. */
        async balance() {
            if (!api.address) return null;
            const units = await rpc.readContract({ address: paid.asset, abi: viem.erc20Abi, functionName: "balanceOf", args: [api.address] });
            return Number(units) / 10 ** (paid.decimals ?? 6);
        },
        /** The signed-in wallet as a viem-shaped account. Privy's signer takes JSON, so BigInts go as strings. */
        account() {
            const plain = (o) => JSON.parse(JSON.stringify(o, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
            const quiet = { address: api.address, uiOptions: { showWalletUIs: false } };
            return { address: api.address,
                signTypedData: async (td) => (await api.sign(plain(td), quiet)).signature,
                signMessage: async ({ message }) => (await api.signMsg({ message }, quiet)).signature };
        },
        /** Buy one record's key, open the row's sealed copy (`ct`) and check it against `want`. */
        async buy(key, want, ct) {
            await api.signIn();
            return buyRecord(paid, key, { want, ct, account: api.account() });
        },
        /** A private app's pass (`paid` is then the card's `access`): one payment, a bearer token. */
        async buyPass() {
            await api.signIn();
            return buyPass(paid, { account: api.account() });
        },
        /** Add funds: on a testnet, free test USDC from Barliman (or the faucet page); on a mainnet, the card onramp. */
        async addFunds() {
            if (M?.barliman && api.faucet) {
                const r = await fetch(`${M.barliman}/drip`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: api.address }) });
                const b = await r.json();
                if (!r.ok) throw new Error(b.error ?? `HTTP ${r.status}`);
                return b;
            }
            if (api.faucet) return window.open(api.faucet, "_blank", "noopener");
            return api.deposit({ destination: { wallet: api.walletId, asset: "usdc", chain: `eip155:${chain.id}` },
                                 fiat: { source: { assets: ["usd"] }, environment: "production", defaultAmount: "10" } });
        },
        // ── Membership (MembershipRegistry, through Barliman) ──
        // The person pays from their wallet into this period's group; a proof then gives the
        // membership to an address derived for this app, which nobody can tie to the payment.
        // That address's key signs reads. It is re-derived from one signature, and kept on this
        // device so the next visit needs none. ponytail: a stolen key reads this app until the
        // membership lapses, nothing more.
        membership: M,
        /** {tokenId, until} if this device holds a membership for this app, else null. */
        async member() {
            const m = held();
            if (!M || !m) return null;
            const holder = (await import("viem/accounts")).privateKeyToAccount(m.key).address;
            const [, until] = await rpc.readContract({ address: M.registry, abi: REG, functionName: "canRead", args: [BigInt(m.tokenId), holder] });
            return { tokenId: m.tokenId, until: Number(until) };
        },
        /** The plan: {price (whole tokens), days}. */
        async plan() {
            const [price, period] = await rpc.readContract({ address: M.registry, abi: REG, functionName: "planOf", args: [M.appId] });
            return { price: Number(price) / 10 ** (paid.decimals ?? 6), units: price, period: Number(period), days: Math.round(Number(period) / 86400) };
        },
        /** Pay for one period and claim it. `step(text)` hears where it is. */
        async join(step = () => {}) {
            await api.signIn();
            const f = await import("@fangorn-network/barliman");
            const account = api.account();
            step("Preparing your membership…");
            const identity = await f.identityFrom(account);
            const { holder, key } = f.holderFor(identity, M.appId);
            const plan = await api.plan();
            const epoch = BigInt(Math.floor(Date.now() / 1000 / plan.period));
            const claimArgs = () => f.buildClaim({ publicClient: rpc, registry: M.registry, identity, appId: M.appId, epoch, holder, fromBlock: BigInt(M.fromBlock ?? 0) });
            // Already paid this period (a claim that did not finish)? Then only claim.
            let claim = await claimArgs().catch(() => null);
            if (!claim) {
                step("Paying for the membership…");
                const j = await f.signJoin({ wallet: account, identity, registry: M.registry, appId: M.appId, epoch, price: plan.units, usdc: paid.asset, chainId: chain.id });
                await relay("join", j);
                step("Proving your membership…");
                claim = await claimArgs();
            }
            const c = await relay("claim", claim).catch((e) => (/AlreadyClaimed/.test(e.message) ? { tokenId: f.membershipTokenId(M.appId, holder).toString() } : Promise.reject(e)));
            hold({ tokenId: String(c.tokenId), key });
            return api.member();
        },
        /** Records' keys with this device's membership; open each row's sealed copy. */
        async read(ids, ct, want) {
            const m = held();
            if (!m) throw new Error("no membership on this device");
            const { privateKeyToAccount } = await import("viem/accounts");
            return readAsMember(paid, ids, { reader: privateKeyToAccount(m.key), tokenId: m.tokenId, ct, want });
        },
    };
    const slot = () => `fangorn:membership:${M?.appId}:${api.address}`;
    function held() { try { return JSON.parse(localStorage.getItem(slot())); } catch { return null; } }
    function hold(v) { try { localStorage.setItem(slot(), JSON.stringify(v)); } catch { /* not kept: the next visit signs once more */ } }
    async function relay(path, body) {
        const r = await fetch(`${M.barliman}/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        const b = await r.json();
        if (!r.ok) throw new Error(b.error ?? `HTTP ${r.status}`);
        return b;
    }
    const host = document.body.appendChild(document.createElement("div"));
    return new Promise((ready) => {
        function Bridge() {
            const p = privy.usePrivy(), { wallets } = privy.useWallets();
            const { signTypedData } = privy.useSignTypedData(), { signMessage } = privy.useSignMessage(), { depositFunds } = privy.useDepositFunds();
            const w = wallets.find((x) => x.walletClientType === "privy");
            // After a reload Privy is signed in before useWallets lists the embedded wallet (it fills
            // in once something touches it), so the address comes from the user too.
            Object.assign(api, { login: p.login, logout: p.logout, authenticated: p.authenticated, address: w?.address ?? p.user?.wallet?.address ?? null,
                                 email: p.user?.email?.address ?? p.user?.google?.email ?? null,
                                 walletId: w?.id ?? null, sign: signTypedData, signMsg: signMessage, deposit: depositFunds });
            React.useEffect(() => { for (const f of listeners) f(api); });
            React.useEffect(() => { if (p.ready) ready(api); }, [p.ready]);
            return null;
        }
        createRoot(host).render(React.createElement(privy.PrivyProvider, {
            appId: APP_ID,
            config: { loginMethods: ["email", "google"], defaultChain: chain, supportedChains: [chain],
                      embeddedWallets: { ethereum: { createOnLogin: "users-without-wallets" } } },
        }, React.createElement(Bridge)));
    });
}
