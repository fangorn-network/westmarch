// The SDK client from a config: { network, fromBlock?, rpcUrl?, gateway?, deployment? }.
// `"network": "sandbox"` runs on `node src/sandbox.js` (its dir: `sandbox`, default .sandbox).
// RPC_URL and IPFS_GATEWAY in the environment win over the config.

import { Fangorn, SupportedNetworks } from "@fangorn-network/sdk";
import { generatePrivateKey } from "viem/accounts";
import { readSandbox } from "./sandbox.js";

/**
 * `key` signs the stitch blocks' uploads (and nothing else: the index is local). None given, a fresh one
 * is made: fine, since the state lives in the index file, not with the key.
 */
export function client(config, key = process.env.INDEXER_KEY) {
    if (config.network === "sandbox") { // a local chain + storage (src/sandbox.js), on Base Sepolia's chain id
        const { deployment, keys } = readSandbox(config.sandbox);
        return client({ ...config, network: "baseSepolia", deployment: { ...deployment, ...config.deployment } }, key ?? keys.indexer);
    }
    const net = config.network ?? "baseSepolia";
    if (!SupportedNetworks[net]) throw new Error(`unknown network "${net}": one of ${Object.keys(SupportedNetworks).join(", ")}`);
    const rpcUrl = process.env.RPC_URL ?? config.rpcUrl, gateway = process.env.IPFS_GATEWAY ?? config.gateway;
    const fromBlock = config.fromBlock ?? config.deployment?.fromBlock;
    return Fangorn.create({
        privateKey: key ?? generatePrivateKey(),
        // Not over FangornConfig: Base mainnet would inherit Base Sepolia's upload worker and SettlementRegistry.
        // rpcRetry: a run here (a seed, a catch-up) waits out a rate-limited RPC, about 4 min a read, rather
        // than failing on a 429. (The Worker keeps the SDK's short retries: its next cron run is the retry.)
        config: { ...SupportedNetworks[net], rpcRetry: { retryCount: 8, retryDelay: 500 }, ...config.deployment,
                  ...(fromBlock != null && { fromBlock: BigInt(fromBlock) }), ...(rpcUrl && { rpcUrl }) },
        storage: { signedUrl: gateway ? { gateway } : {} },
    });
}
