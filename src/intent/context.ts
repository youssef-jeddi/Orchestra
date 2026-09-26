// ─── Intent — live context (balances, ENS) ───
// Network lookups the resolver needs, each bounded by a timeout so a slow RPC
// degrades one answer instead of hanging the request.

import { ethers } from "ethers";
import type { Balances } from "../executor/adapters";
import { estimateUsd } from "../policy";
import { USDC_SEPOLIA, WETH_SEPOLIA } from "../integrations/uniswap/types";
import { mainnetProvider, withTimeout } from "../utils/rpc";

const BALANCE_TIMEOUT_MS = 4_000;
const ENS_TIMEOUT_MS = 4_000;
const ENS_TTL_MS = 10 * 60_000;
const ERC20 = ["function balanceOf(address) view returns (uint256)"];

export async function fetchBalances(provider: ethers.Provider, address: string): Promise<Balances | null> {
  const read = async (): Promise<Balances> => {
    const usdc = new ethers.Contract(USDC_SEPOLIA, ERC20, provider);
    const weth = new ethers.Contract(WETH_SEPOLIA, ERC20, provider);
    const [ethRaw, usdcRaw, wethRaw] = await Promise.all([
      provider.getBalance(address),
      usdc.balanceOf(address).catch(() => 0n),
      weth.balanceOf(address).catch(() => 0n),
    ]);
    const eth = Number(ethers.formatEther(ethRaw));
    const wethBal = Number(ethers.formatEther(wethRaw));
    const usdcBal = Number(ethers.formatUnits(usdcRaw, 6));
    return { eth, weth: wethBal, usdc: usdcBal, totalUsd: estimateUsd("ETH", eth + wethBal) + estimateUsd("USDC", usdcBal) };
  };
  return withTimeout(read(), BALANCE_TIMEOUT_MS, null);
}

const ensCache = new Map<string, { address: string | null; expires: number }>();

/** Resolve an ENS name on mainnet (the name → address mapping users mean). */
export async function resolveEnsName(name: string): Promise<string | null> {
  const key = name.toLowerCase();
  const hit = ensCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.address;
  const address = await withTimeout(mainnetProvider().resolveName(key), ENS_TIMEOUT_MS, null);
  // A miss may just be a timeout — don't pin it for long.
  ensCache.set(key, { address, expires: Date.now() + (address ? ENS_TTL_MS : 30_000) });
  return address;
}
