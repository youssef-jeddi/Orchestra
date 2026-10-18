// ─── Intent — supported token registry ───
// The only tokens the planner may reference. The model outputs symbols; the
// server maps them to addresses here, so an address never comes from the LLM.

import { WETH_SEPOLIA, USDC_SEPOLIA } from "../integrations/uniswap/types";

export interface TokenDef {
  symbol: "ETH" | "WETH" | "USDC";
  /**
   * Address used in plan params. Native ETH maps to WETH because the Uniswap
   * routing and the policy's token/valuation tables key ETH swaps on WETH;
   * sends distinguish native ETH by `symbol`.
   */
  address: string;
  decimals: number;
  native: boolean;
  /** How many decimals to keep when a derived amount (USD, %, all) is rounded. */
  displayDecimals: number;
}

export const TOKENS: Record<TokenDef["symbol"], TokenDef> = {
  ETH: { symbol: "ETH", address: WETH_SEPOLIA, decimals: 18, native: true, displayDecimals: 6 },
  WETH: { symbol: "WETH", address: WETH_SEPOLIA, decimals: 18, native: false, displayDecimals: 6 },
  USDC: { symbol: "USDC", address: USDC_SEPOLIA, decimals: 6, native: false, displayDecimals: 2 },
};

export const SUPPORTED_SYMBOLS = Object.keys(TOKENS) as TokenDef["symbol"][];

const ALIASES: Record<string, TokenDef["symbol"]> = {
  ETH: "ETH",
  ETHER: "ETH",
  ETHEREUM: "ETH",
  WETH: "WETH",
  "WRAPPED ETH": "WETH",
  "WRAPPED ETHER": "WETH",
  USDC: "USDC",
  "USD COIN": "USDC",
};

export function lookupToken(raw: unknown): TokenDef | null {
  if (typeof raw !== "string") return null;
  const key = raw.trim().replace(/^\$/, "").toUpperCase();
  const symbol = ALIASES[key];
  return symbol ? TOKENS[symbol] : null;
}

/** The ERC-20 registry token at an address (WETH, not native ETH, for the WETH address). */
export function tokenByAddress(address: string): TokenDef | null {
  const a = address.toLowerCase();
  return Object.values(TOKENS).find((t) => !t.native && t.address.toLowerCase() === a) ?? null;
}
