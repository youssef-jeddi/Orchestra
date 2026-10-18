// ─── RPC helpers ───
// Shared Sepolia / mainnet providers. `staticNetwork` skips ethers' chain-id
// detection loop, which otherwise retries forever when an endpoint rate-limits
// (e.g. the Alchemy "demo" key returns 429) and hangs every request behind it.

import { ethers } from "ethers";

export const SEPOLIA_CHAIN_ID = 11155111;
export const DEFAULT_SEPOLIA_RPC = "https://ethereum-sepolia-rpc.publicnode.com";
export const DEFAULT_MAINNET_RPC = "https://ethereum-rpc.publicnode.com";

export function sepoliaRpcUrl(): string {
  return process.env.SEPOLIA_RPC_URL || DEFAULT_SEPOLIA_RPC;
}

export function makeSepoliaProvider(url: string = sepoliaRpcUrl()): ethers.JsonRpcProvider {
  const network = ethers.Network.from(SEPOLIA_CHAIN_ID);
  return new ethers.JsonRpcProvider(url, network, { staticNetwork: network });
}

let mainnet: ethers.JsonRpcProvider | null = null;

/** Mainnet provider, used only for ENS resolution. */
export function mainnetProvider(): ethers.JsonRpcProvider {
  if (!mainnet) {
    const network = ethers.Network.from(1);
    mainnet = new ethers.JsonRpcProvider(process.env.MAINNET_RPC_URL || DEFAULT_MAINNET_RPC, network, {
      staticNetwork: network,
    });
  }
  return mainnet;
}

/** Resolve `p` or return `fallback` after `ms`. Never rejects. */
export async function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([p.catch(() => fallback), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
