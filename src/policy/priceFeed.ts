// ─── Policy — live price feed (cached) ───
// The risk engine values plans in USD synchronously, so prices live in an
// in-memory cache that an async refresher keeps warm. `getPriceUsd` is a pure,
// synchronous read; `refreshPrices` pulls live quotes (CoinGecko, no key) and is
// self-throttled. If a refresh never runs or fails, the cache holds the stub
// defaults below — so valuation degrades gracefully instead of breaking.
//
// Sepolia tokens are valued at their mainnet reference (WETH≈ETH, USDC≈$1);
// what matters for the guardrails is the dollar magnitude, not the testnet asset.

const STUB_PRICES: Record<string, number> = {
  ETH: 2500,
  WETH: 2500,
  USDC: 1,
  USDT: 1,
};

const prices: Record<string, number> = { ...STUB_PRICES };
let lastFetch = 0;
const TTL_MS = 60_000;

const COINGECKO_URL =
  "https://api.coingecko.com/api/v3/simple/price?ids=ethereum,usd-coin,tether&vs_currencies=usd";

/** Synchronous price read from cache. Returns 0 for unknown symbols. */
export function getPriceUsd(symbol: string): number {
  return prices[symbol.toUpperCase()] ?? 0;
}

/** Current cache snapshot (for debug / display). */
export function getPrices(): Record<string, number> {
  return { ...prices };
}

/** Test/manual override — set one or more prices directly. */
export function setPrices(overrides: Record<string, number>): void {
  for (const [k, v] of Object.entries(overrides)) {
    if (typeof v === "number" && v > 0) prices[k.toUpperCase()] = v;
  }
}

/** Pull live quotes into the cache. Self-throttled to one fetch per TTL. */
export async function refreshPrices(): Promise<void> {
  const now = Date.now();
  if (now - lastFetch < TTL_MS) return;
  lastFetch = now; // set early to avoid concurrent stampede

  try {
    const res = await fetch(COINGECKO_URL);
    if (!res.ok) throw new Error(`price fetch ${res.status}`);
    const data = (await res.json()) as Record<string, { usd?: number }>;

    const eth = data.ethereum?.usd;
    const usdc = data["usd-coin"]?.usd;
    const usdt = data.tether?.usd;

    if (typeof eth === "number" && eth > 0) { prices.ETH = eth; prices.WETH = eth; }
    if (typeof usdc === "number" && usdc > 0) prices.USDC = usdc;
    if (typeof usdt === "number" && usdt > 0) prices.USDT = usdt;

    console.log(`[prices] refreshed — ETH=$${prices.ETH} USDC=$${prices.USDC}`);
  } catch (err: any) {
    console.warn(`[prices] refresh failed, using cached/stub: ${err.message}`);
  }
}
