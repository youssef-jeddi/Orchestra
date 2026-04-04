// ─── SafeSwarm × Uniswap — Swap Execution & Gas Watch ───
// Submits swaps/orders and provides gas-aware execution.

import { ethers } from "ethers";
import { submitSwap, submitOrder } from "./api";
import type { PermitData, RoutingType } from "./types";

export interface SwapResult {
  type: "classic" | "uniswapx";
  txHash?: string;
  orderId?: string;
}

/**
 * Execute a swap or gasless order based on routing type.
 *
 * - CLASSIC routing: returns the ready-to-broadcast tx (caller must send it)
 * - DUTCH_V2/V3: submits a gasless order to the UniswapX filler network
 */
export async function executeSwap(
  quote: Record<string, any>,
  routing: RoutingType,
  permitData: PermitData | null,
  signature?: string
): Promise<SwapResult> {
  if (routing === "DUTCH_V2" || routing === "DUTCH_V3") {
    if (!signature) throw new Error("UniswapX orders require a Permit2 signature");
    const order = await submitOrder(quote, signature);
    return { type: "uniswapx", orderId: order.orderId };
  }

  // Classic swap — returns tx to broadcast
  const swapTx = await submitSwap(quote, permitData, signature);
  return { type: "classic", txHash: swapTx.to };
}

/**
 * Wait until on-chain gas price drops below a threshold.
 * Resolves when gas is affordable, or rejects on timeout.
 */
export async function waitForLowGas(
  provider: ethers.JsonRpcProvider,
  maxGwei: number,
  opts?: { intervalMs?: number; timeoutMs?: number }
): Promise<number> {
  const interval = opts?.intervalMs ?? 15_000;
  const timeout = opts?.timeoutMs ?? 600_000; // 10 min default
  const start = Date.now();

  while (true) {
    const feeData = await provider.getFeeData();
    const currentGwei = Number(feeData.gasPrice ?? 0n) / 1e9;

    if (currentGwei <= maxGwei) return currentGwei;

    if (Date.now() - start > timeout) {
      throw new Error(
        `Gas still at ${currentGwei.toFixed(1)} gwei after ${timeout / 1000}s timeout`
      );
    }

    console.log(
      `Gas at ${currentGwei.toFixed(1)} gwei — waiting for <=${maxGwei}...`
    );
    await new Promise((r) => setTimeout(r, interval));
  }
}
