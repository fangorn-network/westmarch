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
import { buyRecord } from "../src/agent/x402.js";

const APP_ID = import.meta.env.VITE_PRIVY_APP_ID;
const CHAINS = { "arbitrum-sepolia": arbitrumSepolia, arbitrum, "base-sepolia": baseSepolia, base };
// Card onramps sell real USDC only, so a testnet app sends readers to a faucet instead.
const FAUCET = { "arbitrum-sepolia": "https://faucet.circle.com/", "base-sepolia": "https://faucet.circle.com/" };

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
    const listeners = new Set();
    const api = {
        chain, faucet: FAUCET[paid.network] ?? null, address: null, authenticated: false,
        /** Calls `f(api)` now and on every change (signed in, wallet made, signed out). */
        onChange(f) { listeners.add(f); f(api); return () => listeners.delete(f); },
        /** Signed in with a wallet, opening Privy's login if need be. */
        async signIn() {
            if (!api.authenticated) api.login();
            return new Promise((ok) => { const off = api.onChange((a) => { if (a.address) { off(); ok(a); } }); });
        },
        /** The wallet's balance in the app's token, as a number of whole tokens. */
        async balance() {
            if (!api.address) return null;
            const units = await rpc.readContract({ address: paid.asset, abi: viem.erc20Abi, functionName: "balanceOf", args: [api.address] });
            return Number(units) / 10 ** (paid.decimals ?? 6);
        },
        /** Buy one record and check it against the sha256 the app published for it. */
        async buy(key, want) {
            await api.signIn();
            // x402.js signs with a viem-shaped account. Privy's signer takes JSON, so BigInts go as strings.
            const plain = (o) => JSON.parse(JSON.stringify(o, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
            const account = { address: api.address,
                signTypedData: async (td) => (await api.sign(plain(td), { address: api.address, uiOptions: { showWalletUIs: false } })).signature };
            return buyRecord(paid, key, { want, account });
        },
        /** Add funds: the card onramp on a mainnet, the faucet on a testnet. */
        addFunds() {
            if (api.faucet) return window.open(api.faucet, "_blank", "noopener");
            return api.deposit({ destination: { wallet: api.walletId, asset: "usdc", chain: `eip155:${chain.id}` },
                                 fiat: { source: { assets: ["usd"] }, environment: "production", defaultAmount: "10" } });
        },
    };
    const host = document.body.appendChild(document.createElement("div"));
    return new Promise((ready) => {
        function Bridge() {
            const p = privy.usePrivy(), { wallets } = privy.useWallets();
            const { signTypedData } = privy.useSignTypedData(), { depositFunds } = privy.useDepositFunds();
            const w = wallets.find((x) => x.walletClientType === "privy");
            Object.assign(api, { login: p.login, logout: p.logout, authenticated: p.authenticated, address: w?.address ?? null,
                                 walletId: w?.id ?? null, sign: signTypedData, deposit: depositFunds });
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
