// ─── SafeSwarm × Ledger — Clear Signing / ERC-7730 Utilities ───
// Loads and works with the ERC-7730 descriptor for human-readable Ledger display.

import type { ProposedTrade } from "./types";

/** Fields displayed on the Ledger screen during clear signing */
export interface ClearSigningDisplay {
  intent: string;
  fields: Array<{ label: string; value: string }>;
}

/**
 * Format a proposed trade into the fields the Ledger screen should show.
 * This is the programmatic counterpart to the static ERC-7730 JSON descriptor.
 */
export function formatForDevice(trade: ProposedTrade): ClearSigningDisplay {
  return {
    intent: `Swap ${trade.fromToken} → ${trade.toToken}`,
    fields: [
      { label: "Amount", value: trade.amountIn },
      { label: "Value", value: `~$${trade.valueUSD.toFixed(2)}` },
      { label: "Router", value: formatRouterName(trade.routerAddress) },
      { label: "Token Verified", value: trade.tokenVerified ? "Yes" : "No" },
      { label: "Liquidity", value: `$${formatNumber(trade.liquidityUSD)}` },
    ],
  };
}

/** Map known router addresses to human-readable names */
function formatRouterName(address: string): string {
  const routers: Record<string, string> = {
    "0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD": "Uniswap Universal Router",
    "0xEf1c6E67703c7BD7107eed8303Fbe6EC2554BF6B": "Uniswap Universal Router (old)",
  };
  return routers[address] ?? `Unknown (${address.slice(0, 10)}…)`;
}

/** Format large numbers with commas */
function formatNumber(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
}
