// ─── Policy — Market data & token helpers ───
// Token metadata + USD estimation. `estimateUsd` reads live prices from the
// cached price feed (falling back to stub prices when the cache is cold).

import { ethers } from "ethers";
import { WETH_SEPOLIA, USDC_SEPOLIA } from "../integrations/uniswap/types";
import { getPriceUsd } from "./priceFeed";

// ─── Decimals ───
export const TOKEN_DECIMALS: Record<string, number> = {
  [USDC_SEPOLIA.toLowerCase()]: 6,                                        // USDC Sepolia
  ["0xaA8E23Fb1079EA71e0a56F48a2aA51851D8433D0".toLowerCase()]: 6,        // USDT Sepolia
  [WETH_SEPOLIA.toLowerCase()]: 18,                                       // WETH Sepolia
  ["0xC558DBdd856501FCd9aaF1E62eae57A9F0629a3c".toLowerCase()]: 18,       // WETH alt Sepolia
};

export function toTokenWei(amount: string, tokenAddress: string): bigint {
  const decimals = TOKEN_DECIMALS[tokenAddress.toLowerCase()] ?? 18;
  return ethers.parseUnits(amount, decimals);
}

// ─── Address → symbol lookup ───
export const TOKEN_SYMBOLS: Record<string, string> = {
  [WETH_SEPOLIA.toLowerCase()]: "ETH",
  ["0xC558DBdd856501FCd9aaF1E62eae57A9F0629a3c".toLowerCase()]: "ETH",
  [USDC_SEPOLIA.toLowerCase()]: "USDC",
  ["0xaA8E23Fb1079EA71e0a56F48a2aA51851D8433D0".toLowerCase()]: "USDT",
  // Mainnet
  ["0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2".toLowerCase()]: "ETH",
  ["0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48".toLowerCase()]: "USDC",
};

export function symbolFromAddress(address: string, fallback: string = "UNKNOWN"): string {
  return TOKEN_SYMBOLS[address.toLowerCase()] || fallback;
}

// ─── USD estimation (live cached prices) ───
export function estimateUsd(symbol: string, amount: number): number {
  const price = getPriceUsd(symbol);
  // Unknown symbols (price 0) fall back to a $1 valuation, as before.
  return price > 0 ? amount * price : amount;
}
