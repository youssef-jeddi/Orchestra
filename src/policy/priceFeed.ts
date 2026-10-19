// ─── Policy — live price feed (cached, fails closed) ───
// The risk engine values plans in USD synchronously, so prices live in an in-memory cache that an
// async refresher keeps warm. `getPriceUsd` is a pure, synchronous read; `refreshPrices` pulls live
// quotes (CoinGecko, no key) and is self-throttled.
//
// The cache starts empty and there are no built-in default prices: a made-up $2500/ETH let a
// 0.035 ETH ($140) send count as $87.50 under a $100 limit and run on its own. Whether the cache can
// be trusted is `pricesUsable()` — false if no fetch ever succeeded or the last one is older than
// MAX_PRICE_AGE_MS. Anything that needs a USD value for the daily limit refuses when it is false.
//
// Sepolia tokens are valued at their mainnet reference (WETH≈ETH, USDC≈$1);
// what matters for the guardrails is the dollar magnitude, not the testnet asset.

import { faultOn, injectFault } from "../utils/faultInject";

const prices: Record<string, number> = {};
let lastFetch = 0;
let lastSuccessAt = 0; // ms of the last successful fetch or setPrices; 0 = never
const TTL_MS = 60_000;

/** A price older than this is not used to value a spend. */
export const MAX_PRICE_AGE_MS = 5 * 60_000;

const COINGECKO_URL =
  "https://api.coingecko.com/api/v3/simple/price?ids=ethereum,usd-coin,tether&vs_currencies=usd";

/** Synchronous price read from cache. Returns 0 for unknown symbols; may be the last known value when stale (display only). */
export function getPriceUsd(symbol: string): number {
  return prices[symbol.toUpperCase()] ?? 0;
}

/** Current cache snapshot (for debug / display). */
export function getPrices(): Record<string, number> {
  return { ...prices };
}

/** Can the cached prices value a spend? False when never fetched, too old, or a price fault is injected. */
export function pricesUsable(now: number = Date.now()): boolean {
  if (faultOn("price-read") || faultOn("price-stale")) return false;
  if (lastSuccessAt === 0) return false;
  return now - lastSuccessAt <= MAX_PRICE_AGE_MS;
}

/** Test/manual override — set one or more prices directly (counts as a fresh fetch). */
export function setPrices(overrides: Record<string, number>): void {
  for (const [k, v] of Object.entries(overrides)) {
    if (typeof v === "number" && v > 0) prices[k.toUpperCase()] = v;
  }
  lastSuccessAt = Date.now();
}

/** Forget every price and fetch time. Tests only. */
export function _resetPriceFeedForTests(): void {
  for (const k of Object.keys(prices)) delete prices[k];
  lastSuccessAt = 0;
  lastFetch = 0;
}

/** Pull live quotes into the cache. Self-throttled to one fetch per TTL. A failure keeps the old values but not their freshness. */
export async function refreshPrices(): Promise<void> {
  const now = Date.now();
  if (now - lastFetch < TTL_MS) return;
  lastFetch = now; // set early to avoid concurrent stampede

  try {
    await injectFault("price-read");
    const res = await fetch(COINGECKO_URL);
    if (!res.ok) throw new Error(`price fetch ${res.status}`);
    const data = (await res.json()) as Record<string, { usd?: number }>;

    const eth = data.ethereum?.usd;
    const usdc = data["usd-coin"]?.usd;
    const usdt = data.tether?.usd;

    // Without an ETH quote the cache is not fresh, whatever else came back.
    if (!(typeof eth === "number" && eth > 0)) throw new Error("price fetch returned no ETH price");
    prices.ETH = eth; prices.WETH = eth;
    if (typeof usdc === "number" && usdc > 0) prices.USDC = usdc;
    if (typeof usdt === "number" && usdt > 0) prices.USDT = usdt;
    lastSuccessAt = Date.now();

    console.log(`[prices] refreshed — ETH=$${prices.ETH} USDC=${prices.USDC ?? "n/a"}`);
  } catch (err: any) {
    lastFetch = 0; // allow the next request to retry immediately (the early stampede lock only matters while a fetch is in flight)
    console.warn(`[prices] refresh failed, prices not trusted until the next success: ${err.message}`);
  }
}
