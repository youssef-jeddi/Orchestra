// ─── Uniswap v3 — full-range liquidity ───
// Mints a full-range position through the v3 NonfungiblePositionManager. The
// pool's current price decides how much of each token is actually deposited;
// what doesn't fit the ratio stays with the owner (the Safe).
//
// Before anything is built or executed, the pool's price is compared with the
// reference price feed: depositing at a mispriced pool hands value to the first
// arbitrageur (testnet pools are often wildly off). Pure except readPool().

import { ethers } from "ethers";
import { getPriceUsd } from "../../policy";

// Verified on Sepolia: NPM.factory() = V3_FACTORY, NPM.WETH9() = WETH_SEPOLIA.
export const POSITION_MANAGER_SEPOLIA = "0x1238536071E1c677A632429e3655c799b22cDA52";
export const V3_FACTORY_SEPOLIA = "0x0227628f3F023bb0B980b67D528571c95c6DaC1c";

const MIN_TICK = -887272;
const MAX_TICK = 887272;
const TICK_SPACING: Record<number, number> = { 100: 1, 500: 10, 3000: 60, 10000: 200 };

/** Slippage allowed on the deposited amounts between the price read and execution. */
export const LP_SLIPPAGE = 0.01;
/** Refuse when the pool's price is further than this from market (either direction). */
export const DEFAULT_LP_MAX_PRICE_DEVIATION = 0.05;

export const NPM_ABI = [
  "function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline)) payable returns (uint256 tokenId,uint128 liquidity,uint256 amount0,uint256 amount1)",
  "function multicall(bytes[] data) payable returns (bytes[] results)",
  "function refundETH() payable",
  "function positions(uint256 tokenId) view returns (uint96 nonce,address operator,address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint128 liquidity,uint256 feeGrowthInside0LastX128,uint256 feeGrowthInside1LastX128,uint128 tokensOwed0,uint128 tokensOwed1)",
  "function balanceOf(address owner) view returns (uint256)",
  "function tokenOfOwnerByIndex(address owner,uint256 index) view returns (uint256)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function decreaseLiquidity((uint256 tokenId,uint128 liquidity,uint256 amount0Min,uint256 amount1Min,uint256 deadline)) payable returns (uint256 amount0,uint256 amount1)",
  "function collect((uint256 tokenId,address recipient,uint128 amount0Max,uint128 amount1Max)) payable returns (uint256 amount0,uint256 amount1)",
  "function unwrapWETH9(uint256 amountMinimum,address recipient) payable",
  "function sweepToken(address token,uint256 amountMinimum,address recipient) payable",
  "function burn(uint256 tokenId) payable",
];
const npm = new ethers.Interface(NPM_ABI);
const erc20 = new ethers.Interface(["function approve(address spender, uint256 amount) returns (bool)"]);

/** The widest range the fee tier's tick spacing allows. */
export function fullRangeTicks(fee: number): { tickLower: number; tickUpper: number } {
  const spacing = TICK_SPACING[fee];
  if (!spacing) throw new Error(`Unsupported fee tier ${fee}`);
  return { tickLower: Math.ceil(MIN_TICK / spacing) * spacing, tickUpper: Math.floor(MAX_TICK / spacing) * spacing };
}

export interface LpSide {
  address: string; // ERC-20 address (WETH for native ETH)
  symbol: string;
  decimals: number;
  native: boolean; // paid in native ETH (wrapped by the position manager)
  amount: bigint; // desired, smallest unit
}

export interface PoolState {
  pool: string;
  sqrtPriceX96: bigint;
  tick: number;
}

export async function readPool(provider: ethers.Provider, tokenA: string, tokenB: string, fee: number): Promise<PoolState | null> {
  const factory = new ethers.Contract(V3_FACTORY_SEPOLIA, ["function getPool(address,address,uint24) view returns (address)"], provider);
  const pool: string = await factory.getPool(tokenA, tokenB, fee);
  if (pool === ethers.ZeroAddress) return null;
  const c = new ethers.Contract(pool, ["function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16,uint16,uint16,uint8,bool)"], provider);
  const s0 = await c.slot0();
  return { pool, sqrtPriceX96: BigInt(s0[0]), tick: Number(s0[1]) };
}

/** Sort the two sides the way the pool does (token0 has the lower address). */
export function orderSides(a: LpSide, b: LpSide): [LpSide, LpSide] {
  return a.address.toLowerCase() < b.address.toLowerCase() ? [a, b] : [b, a];
}

/** Human price of token1 in token0 units (e.g. USDC per WETH). */
export function poolPrice(sqrtPriceX96: bigint, t0: LpSide, t1: LpSide): number {
  const raw = (Number(sqrtPriceX96) / 2 ** 96) ** 2; // token1 raw per token0 raw
  return 1 / (raw * 10 ** (t0.decimals - t1.decimals));
}

export function resolveMaxLpDeviation(configured: unknown = process.env.LP_MAX_PRICE_DEVIATION): number {
  if (configured === "off") return Infinity; // testnet demos: pools are rarely near market
  const n = typeof configured === "string" ? Number(configured) : configured;
  return typeof n === "number" && n > 0 ? n : DEFAULT_LP_MAX_PRICE_DEVIATION;
}

/** Why the pool's price is unacceptable, or null. Unknown market prices skip the check. */
export function lpPriceProblem(sqrtPriceX96: bigint, t0: LpSide, t1: LpSide, maxDeviation = resolveMaxLpDeviation()): string | null {
  const m0 = getPriceUsd(t0.symbol);
  const m1 = getPriceUsd(t1.symbol);
  if (!(m0 > 0 && m1 > 0) || maxDeviation === Infinity) return null;
  const pool = poolPrice(sqrtPriceX96, t0, t1);
  const market = m1 / m0;
  const deviation = Math.max(pool / market, market / pool) - 1;
  if (deviation <= maxDeviation + 1e-9) return null;
  const fmt = (n: number) => n.toLocaleString("en-US", { maximumSignificantDigits: 5 });
  return `Not adding liquidity: the pool prices 1 ${t1.symbol} at ${fmt(pool)} ${t0.symbol}, but the market price is ${fmt(market)} ${t0.symbol}. ` +
    `Depositing at a price that far off would hand value to the first arbitrageur.`;
}

/**
 * What a full-range mint actually takes at the current price: liquidity is
 * limited by the scarcer side, the other side is deposited in proportion.
 * (Full range ≈ (0, ∞) price bounds, so L = min(a0·√P, a1/√P) in raw units.)
 */
export function expectedDeposit(sqrtPriceX96: bigint, amount0: bigint, amount1: bigint): { used0: bigint; used1: bigint } {
  const sqrtP = Number(sqrtPriceX96) / 2 ** 96;
  const L = Math.min(Number(amount0) * sqrtP, Number(amount1) / sqrtP);
  const clamp = (x: number, max: bigint) => {
    const v = BigInt(Math.floor(x));
    return v > max ? max : v < 0n ? 0n : v;
  };
  return { used0: clamp(L / sqrtP, amount0), used1: clamp(L * sqrtP, amount1) };
}

export interface MintPlan {
  token0: LpSide;
  token1: LpSide;
  fee: number;
  tickLower: number;
  tickUpper: number;
  used0: bigint;
  used1: bigint;
  amount0Min: bigint;
  amount1Min: bigint;
}

export function planMint(a: LpSide, b: LpSide, fee: number, sqrtPriceX96: bigint, slippage = LP_SLIPPAGE): MintPlan {
  const [token0, token1] = orderSides(a, b);
  const { tickLower, tickUpper } = fullRangeTicks(fee);
  const { used0, used1 } = expectedDeposit(sqrtPriceX96, token0.amount, token1.amount);
  const keep = BigInt(Math.round((1 - slippage) * 10_000));
  return { token0, token1, fee, tickLower, tickUpper, used0, used1, amount0Min: (used0 * keep) / 10_000n, amount1Min: (used1 * keep) / 10_000n };
}

/**
 * The Safe batch for a mint: exact-amount approvals of the ERC-20 sides to the
 * position manager, then the mint. A native-ETH side is sent as value and the
 * unused part refunded (multicall(mint, refundETH)).
 */
export function buildMintBatch(plan: MintPlan, recipient: string, deadline: number): Array<{ to: string; value: string; data: string }> {
  const batch: Array<{ to: string; value: string; data: string }> = [];
  for (const side of [plan.token0, plan.token1]) {
    if (!side.native && side.amount > 0n) {
      batch.push({ to: side.address, value: "0", data: erc20.encodeFunctionData("approve", [POSITION_MANAGER_SEPOLIA, side.amount]) });
    }
  }
  const mint = npm.encodeFunctionData("mint", [{
    token0: plan.token0.address, token1: plan.token1.address, fee: plan.fee,
    tickLower: plan.tickLower, tickUpper: plan.tickUpper,
    amount0Desired: plan.token0.amount, amount1Desired: plan.token1.amount,
    amount0Min: plan.amount0Min, amount1Min: plan.amount1Min,
    recipient, deadline,
  }]);
  const nativeSide = [plan.token0, plan.token1].find((s) => s.native);
  if (nativeSide) {
    const data = npm.encodeFunctionData("multicall", [[mint, npm.encodeFunctionData("refundETH")]]);
    batch.push({ to: POSITION_MANAGER_SEPOLIA, value: nativeSide.amount.toString(), data });
  } else {
    batch.push({ to: POSITION_MANAGER_SEPOLIA, value: "0", data: mint });
  }
  // The pool's ratio decides what's actually taken: reset the approvals so no
  // allowance is left behind for the unused part.
  for (const side of [plan.token0, plan.token1]) {
    if (!side.native && side.amount > 0n) {
      batch.push({ to: side.address, value: "0", data: erc20.encodeFunctionData("approve", [POSITION_MANAGER_SEPOLIA, 0n]) });
    }
  }
  return batch;
}

// ═══ Removing liquidity ═══
// Positions are read from the position manager (the Safe owns the NFTs). A
// removal withdraws a share of the liquidity and collects it together with the
// fees earned, in one multicall; WETH comes back as native ETH, the way the Safe
// holds it. Removing everything also burns the empty NFT. No price guard here:
// refusing would only trap funds in a mispriced pool — the minimum amounts
// still protect against price moves between preview and execution.

const MAX_UINT128 = (1n << 128n) - 1n;
const MAX_POSITIONS = 20;

export interface PositionToken {
  address: string;
  symbol: string;
  decimals: number;
}

export interface Position {
  tokenId: string;
  token0: PositionToken;
  token1: PositionToken;
  fee: number;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  fullRange: boolean;
  /** Current underlying amounts at the pool's price (smallest unit), fees excluded. */
  amount0: bigint;
  amount1: bigint;
  /** Fees already credited to the position (more accrue until collected). */
  owed0: bigint;
  owed1: bigint;
  sqrtPriceX96: bigint;
}

const sqrtAtTick = (tick: number) => Math.sqrt(1.0001 ** tick);

/** Token amounts (smallest unit) that `liquidity` represents between two ticks at the current price. */
export function amountsForLiquidity(sqrtPriceX96: bigint, tickLower: number, tickUpper: number, liquidity: bigint): { amount0: bigint; amount1: bigint } {
  const L = Number(liquidity);
  const sqrtP = Number(sqrtPriceX96) / 2 ** 96;
  const sqrtA = sqrtAtTick(tickLower);
  const sqrtB = sqrtAtTick(tickUpper);
  let a0 = 0;
  let a1 = 0;
  if (sqrtP <= sqrtA) a0 = (L * (sqrtB - sqrtA)) / (sqrtA * sqrtB);
  else if (sqrtP >= sqrtB) a1 = L * (sqrtB - sqrtA);
  else {
    a0 = (L * (sqrtB - sqrtP)) / (sqrtP * sqrtB);
    a1 = L * (sqrtP - sqrtA);
  }
  return { amount0: BigInt(Math.floor(a0)), amount1: BigInt(Math.floor(a1)) };
}

/**
 * The owner's open positions whose tokens are known (e.g. from the token registry).
 * Unknown-token and fully withdrawn (liquidity 0, nothing owed) positions are skipped.
 */
export async function readPositions(
  provider: ethers.Provider,
  owner: string,
  tokenInfo: (address: string) => PositionToken | null
): Promise<Position[]> {
  const pm = new ethers.Contract(POSITION_MANAGER_SEPOLIA, NPM_ABI, provider);
  const count = Math.min(Number(await pm.balanceOf(owner)), MAX_POSITIONS);
  const ids: bigint[] = await Promise.all(Array.from({ length: count }, (_, i) => pm.tokenOfOwnerByIndex(owner, i)));
  const pools = new Map<string, Promise<PoolState | null>>();
  const out: Position[] = [];
  for (const id of ids) {
    const p = await pm.positions(id);
    const token0 = tokenInfo(p.token0);
    const token1 = tokenInfo(p.token1);
    const liquidity = BigInt(p.liquidity);
    const owed0 = BigInt(p.tokensOwed0);
    const owed1 = BigInt(p.tokensOwed1);
    if (!token0 || !token1 || (liquidity === 0n && owed0 === 0n && owed1 === 0n)) continue;
    const fee = Number(p.fee);
    const key = `${p.token0}:${p.token1}:${fee}`;
    if (!pools.has(key)) pools.set(key, readPool(provider, p.token0, p.token1, fee));
    const pool = await pools.get(key)!;
    if (!pool) continue;
    const tickLower = Number(p.tickLower);
    const tickUpper = Number(p.tickUpper);
    const full = fullRangeTicks(fee);
    const { amount0, amount1 } = amountsForLiquidity(pool.sqrtPriceX96, tickLower, tickUpper, liquidity);
    out.push({
      tokenId: id.toString(), token0, token1, fee, tickLower, tickUpper, liquidity,
      fullRange: tickLower === full.tickLower && tickUpper === full.tickUpper,
      amount0, amount1, owed0, owed1, sqrtPriceX96: pool.sqrtPriceX96,
    });
  }
  return out;
}

export interface RemovePlan {
  tokenId: string;
  liquidity: bigint; // to remove
  amount0Min: bigint;
  amount1Min: bigint;
  expected0: bigint;
  expected1: bigint;
  burn: boolean;
}

/** Remove `percent` (1–100) of a position, with minimums `slippage` below the expected amounts. */
export function planRemove(position: Position, percent: number, slippage = LP_SLIPPAGE): RemovePlan {
  if (!(percent > 0 && percent <= 100)) throw new Error(`Invalid share ${percent}%`);
  const liquidity = percent === 100 ? position.liquidity : (position.liquidity * BigInt(Math.round(percent * 100))) / 10_000n;
  const { amount0, amount1 } = amountsForLiquidity(position.sqrtPriceX96, position.tickLower, position.tickUpper, liquidity);
  const keep = BigInt(Math.round((1 - slippage) * 10_000));
  return {
    tokenId: position.tokenId, liquidity,
    expected0: amount0, expected1: amount1,
    amount0Min: (amount0 * keep) / 10_000n, amount1Min: (amount1 * keep) / 10_000n,
    burn: percent === 100,
  };
}

/**
 * One multicall to the position manager: decreaseLiquidity → collect (withdrawn
 * tokens + all fees). With a WETH side the tokens are collected to the position
 * manager, WETH is unwrapped to ETH and the other token swept, all to `recipient`.
 */
export function buildRemoveBatch(position: Position, plan: RemovePlan, recipient: string, deadline: number, weth: string): Array<{ to: string; value: string; data: string }> {
  const calls: string[] = [];
  if (plan.liquidity > 0n) {
    calls.push(npm.encodeFunctionData("decreaseLiquidity", [{
      tokenId: plan.tokenId, liquidity: plan.liquidity,
      amount0Min: plan.amount0Min, amount1Min: plan.amount1Min, deadline,
    }]));
  }
  const wethSide = [position.token0, position.token1].find((t) => t.address.toLowerCase() === weth.toLowerCase());
  calls.push(npm.encodeFunctionData("collect", [{
    tokenId: plan.tokenId, recipient: wethSide ? ethers.ZeroAddress : recipient,
    amount0Max: MAX_UINT128, amount1Max: MAX_UINT128,
  }]));
  if (wethSide) {
    const other = wethSide === position.token0 ? position.token1 : position.token0;
    calls.push(npm.encodeFunctionData("unwrapWETH9", [0n, recipient]));
    calls.push(npm.encodeFunctionData("sweepToken", [other.address, 0n, recipient]));
  }
  if (plan.burn) calls.push(npm.encodeFunctionData("burn", [plan.tokenId]));
  return [{ to: POSITION_MANAGER_SEPOLIA, value: "0", data: npm.encodeFunctionData("multicall", [calls]) }];
}

/** The position's current owner (the Safe must still own it at execution). */
export async function positionOwner(provider: ethers.Provider, tokenId: string): Promise<string> {
  return new ethers.Contract(POSITION_MANAGER_SEPOLIA, NPM_ABI, provider).ownerOf(tokenId);
}
