// ─── Policy — swap quote sanity check ───
// A quote is only as good as the pool behind it. Testnet pools are never
// arbitraged and a thin mainnet pool can be far off market, so before a swap is
// offered or executed its quoted output is compared against what the input is
// worth at the reference price feed. A quote that gives back much less than
// that is refused — no transaction is built. Pure: prices come from the cache.

import { getPriceUsd } from "./priceFeed";

/** Refuse a quote that returns more than this fraction below market value. */
export const DEFAULT_MAX_SWAP_SHORTFALL = 0.05;

export function resolveMaxSwapShortfall(configured: unknown = process.env.SWAP_MAX_SHORTFALL): number {
  const n = typeof configured === "string" ? Number(configured) : configured;
  return typeof n === "number" && n > 0 && n < 1 ? n : DEFAULT_MAX_SWAP_SHORTFALL;
}

export interface QuoteCheckInput {
  symbolIn: string;
  amountIn: number;
  symbolOut: string;
  /** What the quote says the swap returns, in whole tokens. */
  amountOut: number;
  maxShortfall?: number;
}

export interface QuoteCheck {
  amountOut: number;
  /** What the input buys at the reference prices. */
  marketOut: number;
  /** 1 - amountOut / marketOut. Negative when the quote beats the market. */
  shortfall: number;
  ok: boolean;
  /** Human-readable refusal when !ok. */
  reason?: string;
}

/** Compare a quote to the reference prices. Null when either token has no price. */
export function checkSwapQuote(input: QuoteCheckInput): QuoteCheck | null {
  const { symbolIn, amountIn, symbolOut, amountOut } = input;
  const priceIn = getPriceUsd(symbolIn);
  const priceOut = getPriceUsd(symbolOut);
  if (!(priceIn > 0 && priceOut > 0 && amountIn > 0)) return null;

  const maxShortfall = input.maxShortfall ?? resolveMaxSwapShortfall();
  const marketOut = (amountIn * priceIn) / priceOut;
  const shortfall = 1 - amountOut / marketOut;
  if (shortfall <= maxShortfall + 1e-9) return { amountOut, marketOut, shortfall, ok: true };

  const pct = Math.round(shortfall * 100);
  return {
    amountOut,
    marketOut,
    shortfall,
    ok: false,
    reason:
      `Not swapping: the best Uniswap route gives ~${formatTokenAmount(amountOut, symbolOut)} ${symbolOut} ` +
      `for ${formatTokenAmount(amountIn, symbolIn)} ${symbolIn}, ${pct}% less than the ` +
      `~${formatTokenAmount(marketOut, symbolOut)} ${symbolOut} it's worth at market price. ` +
      `The pool's price is far off the market.`,
  };
}

/** Compact display amount: cents for stablecoins, 4 significant digits otherwise. */
export function formatTokenAmount(n: number, symbol: string): string {
  if (!(n > 0)) return "0";
  const s = symbol.toUpperCase();
  if (s === "USDC" || s === "USDT") return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (n >= 1) return String(Number(n.toFixed(4)));
  return String(Number(n.toPrecision(4)));
}
