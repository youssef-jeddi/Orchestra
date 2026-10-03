// ─── Executor — intent adapters ───
// Each adapter turns a planned intent into the response the /intent endpoint
// returns (unsigned tx(s), quotes, balances). Adding a new capability — a new
// protocol (Aave, Lido) or action — becomes "write an adapter + register it",
// instead of editing the monolithic /intent handler.
//
// The interface is deliberately shaped to fit protocol integrations, not just
// native transfers: an adapter can fetch quotes, check approvals, and build one
// or more unsigned transactions. Server-side auto-execution goes through the
// optional `execute()` (swap and send), signed by the agent wallet as a Safe owner.

import { ethers } from "ethers";
import crypto from "crypto";
import { WETH_SEPOLIA, USDC_SEPOLIA } from "../integrations/uniswap/types";
import { checkApproval } from "../integrations/uniswap/api";
import { fetchQuoteWithRouting } from "../integrations/uniswap/routing";
import {
  readPool, orderSides, lpPriceProblem, planMint, buildMintBatch,
  readPositions, planRemove, buildRemoveBatch, positionOwner,
  type LpSide, type PoolState,
} from "../integrations/uniswap/liquidity";
import { tokenByAddress } from "../intent/tokens";
import { TOKEN_DECIMALS, toTokenWei, symbolFromAddress, estimateUsd, checkSwapQuote, formatTokenAmount, type QuoteCheck } from "../policy";

/** Uniswap's native-ETH sentinel. A WETH address would pull ERC-20 the Safe may not hold. */
const NATIVE_ETH = "0x0000000000000000000000000000000000000000";

function isNativeEth(symbol: string | undefined, address: string): boolean {
  return String(symbol || "").toUpperCase() === "ETH" || address.toLowerCase() === NATIVE_ETH;
}

/** Quote address: "ETH" is native (the router wraps it); "WETH" stays the WETH contract. */
function routingToken(address: string, symbol: string | undefined): string {
  return String(symbol || "").toUpperCase() === "ETH" ? NATIVE_ETH : address;
}

function decimalsFor(address: string): number {
  return TOKEN_DECIMALS[address.toLowerCase()] ?? 18;
}

function symbolFor(address: string): string {
  return isNativeEth(undefined, address) ? "ETH" : symbolFromAddress(address, "UNKNOWN");
}

interface QuoteLeg {
  tokenIn: string;
  symbolIn: string;
  /** Raw input amount (wei / smallest unit). */
  amountIn: string;
  tokenOut: string;
  symbolOut: string;
}

/**
 * Read a quote's output and check it against the reference prices. A quote
 * whose output can't be read can't be verified either, so it is refused.
 */
function assessQuote(quote: any, leg: QuoteLeg): { amountOut: number | null; check: QuoteCheck | null; refusal?: string } {
  const raw = quote?.output?.amount ?? quote?.orderInfo?.outputs?.[0]?.startAmount;
  if (raw == null || !/^\d+$/.test(String(raw))) {
    return { amountOut: null, check: null, refusal: "Not swapping: the Uniswap quote has no readable output amount, so its price can't be checked." };
  }
  const amountOut = Number(ethers.formatUnits(String(raw), decimalsFor(leg.tokenOut)));
  const amountIn = Number(ethers.formatUnits(leg.amountIn, decimalsFor(leg.tokenIn)));
  const check = checkSwapQuote({ symbolIn: leg.symbolIn, amountIn, symbolOut: leg.symbolOut, amountOut });
  return { amountOut, check, refusal: check && !check.ok ? check.reason : undefined };
}

/** "Swap 10 USDC for ~0.00398 ETH", with the USD value and any notable gap to market. */
function swapSummary(amountIn: string, symbolIn: string, amountOut: number, symbolOut: string, check: QuoteCheck | null): string {
  const usd = estimateUsd(symbolIn, Number(amountIn));
  let s = `Swap ${amountIn} ${symbolIn} for ~${formatTokenAmount(amountOut, symbolOut)} ${symbolOut}`;
  if (symbolIn !== "USDC" && usd > 0) s += ` (~$${usd.toFixed(2)})`;
  if (check && check.shortfall >= 0.01) s += `, ${(check.shortfall * 100).toFixed(1)}% below market`;
  return s;
}

export interface Balances {
  eth: number;
  weth: number;
  usdc: number;
  totalUsd: number;
}

export interface ExecutionContext {
  walletAddress?: string;
  safeAddress: string | null;
  balanceAddress: string | null;
  provider: ethers.Provider;
  params: Record<string, any>;
  planSummary: string;
  planSteps: any[];
  totalEstimatedValueUsd: number;
  balances: Balances | null;
}

/**
 * Intent-specific pieces merged into the common /intent response envelope.
 * `plan` / `assessment` override the defaults; `payload` carries extra fields
 * (balances, sendData, quoteData, …).
 */
export interface AdapterResult {
  plan?: { id: string; summary: string; steps: any[]; totalEstimatedValueUsd: number };
  assessment?: Record<string, unknown>;
  payload?: Record<string, unknown>;
  /** Set when the action must not go ahead (e.g. a mispriced quote). Nothing is signable. */
  refusal?: string;
}

/** Result of a successful server-side auto-execution. */
export interface ExecuteResult {
  txHash: string;
  explorerUrl: string;
  tradeId: string;
}

export interface IntentAdapter {
  kind: string;
  build(ctx: ExecutionContext): Promise<AdapterResult>;
  /**
   * Optional server-side auto-execution, invoked only when the policy verdict is
   * AUTO_EXECUTE and a Safe is available. Return null when execution isn't
   * possible (e.g. no quote) so the caller falls back to the manual flow.
   */
  execute?(ctx: ExecutionContext, built: AdapterResult): Promise<ExecuteResult | null>;
}

// ─── balance — instant on-chain read ───
const balanceAdapter: IntentAdapter = {
  kind: "balance",
  async build(ctx) {
    let balances = ctx.balances;
    if (!balances) {
      try {
        const ethBal = await ctx.provider.getBalance(ctx.balanceAddress!);
        const eth = Number(ethers.formatEther(ethBal));
        balances = { eth, weth: 0, usdc: 0, totalUsd: estimateUsd("ETH", eth) };
      } catch (err: any) {
        // RPC unavailable — degrade gracefully instead of a raw 500.
        console.warn(`[adapter:balance] balance read failed: ${err.message}`);
        return {
          plan: { id: crypto.randomUUID(), summary: "Couldn't read your balance — the RPC endpoint is unavailable.", steps: [], totalEstimatedValueUsd: 0 },
          assessment: { verdict: "INFO", riskScore: 0, reasons: ["Balance read failed"], requiresLedger: false, triggered: [], approvalMethod: "none" },
          payload: { balances: null },
        };
      }
    }
    return {
      plan: {
        id: crypto.randomUUID(),
        summary: `Portfolio: ${balances.eth.toFixed(4)} ETH, ${balances.weth.toFixed(4)} WETH, ${balances.usdc.toFixed(2)} USDC`,
        steps: [],
        totalEstimatedValueUsd: balances.totalUsd,
      },
      assessment: { verdict: "INFO", riskScore: 0, reasons: ["Read-only query"], requiresLedger: false, triggered: [], approvalMethod: "none" },
      payload: { balances },
    };
  },
};

// ─── send — build unsigned transfer tx ───
const sendAdapter: IntentAdapter = {
  kind: "send",
  async build(ctx) {
    const p = ctx.params;
    const symbol = p.symbol || "ETH";
    const amount = String(p.amount || "0");
    const to = p.to || "";
    const token = p.token || WETH_SEPOLIA;

    let unsignedTx: { to: string; data: string; value: string };
    if (symbol.toUpperCase() === "ETH") {
      unsignedTx = { to, data: "0x", value: ethers.parseEther(amount).toString() };
    } else {
      const decimals = TOKEN_DECIMALS[token.toLowerCase()] ?? 18;
      const amountWei = ethers.parseUnits(amount, decimals);
      const erc20Iface = new ethers.Interface(["function transfer(address to, uint256 amount)"]);
      unsignedTx = { to: token, data: erc20Iface.encodeFunctionData("transfer", [to, amountWei]), value: "0" };
    }

    console.log(`[adapter:send] ${amount} ${symbol} → ${to}`);
    return { payload: { sendData: { unsignedTx, token, symbol, amount, to } } };
  },

  async execute(ctx, built) {
    const sendData = (built.payload as any)?.sendData;
    if (!sendData?.unsignedTx || !ctx.safeAddress) return null;

    const agentKey = process.env.AGENT_PRIVATE_KEY;
    if (!agentKey) throw new Error("AGENT_PRIVATE_KEY not set");

    const { executeBatchViaSafe } = await import("../integrations/safe/transaction");
    const tx = sendData.unsignedTx;
    console.log(`[adapter:send] AUTO_EXECUTE via Safe ${ctx.safeAddress}`);
    const txHash = await executeBatchViaSafe(ctx.safeAddress, agentKey, [{ to: tx.to, value: tx.value || "0", data: tx.data || "0x" }], "150000");

    const tradeId = crypto.randomUUID();
    const { logTradeResult } = await import("./logResult");
    logTradeResult(tradeId, txHash, "success").catch(() => {});
    return { txHash, explorerUrl: `https://sepolia.etherscan.io/tx/${txHash}`, tradeId };
  },
};

// ─── deposit — the user's wallet funds their Safe ───
// Built like a send to the Safe, but signed by the user's own wallet: there is
// deliberately no execute() — the agent can't move funds out of the user's wallet.
const depositAdapter: IntentAdapter = {
  kind: "deposit",
  async build(ctx) {
    if (!ctx.walletAddress) return { refusal: "Connect a wallet first so I can move funds from it into your Safe." };
    if (!ctx.safeAddress) return { refusal: "You don't have a Safe yet. Create one first (the \"Create Safe\" button), then fund it." };
    const built = await sendAdapter.build({ ...ctx, params: { ...ctx.params, to: ctx.safeAddress } });
    const sendData = (built.payload as any).sendData;
    return { payload: { depositData: { ...sendData, safeAddress: ctx.safeAddress } } };
  },
};

// ─── add_liquidity — full-range Uniswap v3 position, from the Safe ───
// Build reads the pool and refuses a mispriced one; execute re-reads it and
// re-checks at execution time (an approval can come minutes later), then runs
// approve → mint → approval reset through the Safe. The position NFT goes to the Safe.

function lpSide(address: string, symbol: string, amount: string | bigint): LpSide {
  const native = String(symbol).toUpperCase() === "ETH";
  const decimals = decimalsFor(address);
  return {
    address, symbol, decimals, native,
    amount: typeof amount === "bigint" ? amount : ethers.parseUnits(String(amount), decimals),
  };
}

const addLiquidityAdapter: IntentAdapter = {
  kind: "add_liquidity",
  async build(ctx) {
    const p = ctx.params;
    if (!ctx.safeAddress) {
      return { refusal: "Adding liquidity runs from your Safe. Create one first (the \"Create Safe\" button), then fund it." };
    }
    const a = lpSide(p.tokenA || WETH_SEPOLIA, p.symbolA || symbolFromAddress(p.tokenA || WETH_SEPOLIA, "WETH"), p.amountA || "0");
    const b = lpSide(p.tokenB || USDC_SEPOLIA, p.symbolB || symbolFromAddress(p.tokenB || USDC_SEPOLIA, "USDC"), p.amountB || "0");
    const fee = Number(p.feeTier) || 3000;
    const pair = `${a.symbol}/${b.symbol} ${fee / 10000}%`;

    let state: PoolState | null;
    try {
      state = await readPool(ctx.provider, a.address, b.address, fee);
    } catch (err: any) {
      return { refusal: `I couldn't read the Uniswap pool right now (${err.message}). Nothing was built.` };
    }
    if (!state) return { refusal: `There's no ${pair} Uniswap v3 pool on Sepolia.` };

    const [t0, t1] = orderSides(a, b);
    const problem = lpPriceProblem(state.sqrtPriceX96, t0, t1);
    if (problem) {
      console.warn(`[adapter:add_liquidity] refused: ${problem}`);
      return { refusal: problem };
    }

    const plan = planMint(a, b, fee, state.sqrtPriceX96);
    const usedOf = (side: LpSide) => (side === plan.token0 ? plan.used0 : plan.used1);
    const human = (side: LpSide, v: bigint) => Number(ethers.formatUnits(v, side.decimals));
    const usedA = human(a, usedOf(a));
    const usedB = human(b, usedOf(b));
    const leftover = usedOf(a) < a.amount || usedOf(b) < b.amount;
    const summary = `Add liquidity to ${pair} (full range): ≈${formatTokenAmount(usedA, a.symbol)} ${a.symbol} + ≈${formatTokenAmount(usedB, b.symbol)} ${b.symbol}` +
      (leftover ? " at the pool's ratio; the rest stays in your Safe" : "");
    console.log(`[adapter:add_liquidity] ${summary} (pool ${state.pool})`);

    const lpData = {
      tokenA: a.address, symbolA: a.symbol, amountA: a.amount.toString(),
      tokenB: b.address, symbolB: b.symbol, amountB: b.amount.toString(),
      feeTier: fee, pool: state.pool, usedA, usedB,
    };
    return {
      plan: { id: crypto.randomUUID(), summary, steps: ctx.planSteps, totalEstimatedValueUsd: ctx.totalEstimatedValueUsd },
      payload: { lpData },
    };
  },

  async execute(ctx, built) {
    const d = (built.payload as any)?.lpData;
    if (!d || !ctx.safeAddress) return null;
    const agentKey = process.env.AGENT_PRIVATE_KEY;
    if (!agentKey) throw new Error("AGENT_PRIVATE_KEY not set");

    const a = lpSide(d.tokenA, d.symbolA, BigInt(d.amountA));
    const b = lpSide(d.tokenB, d.symbolB, BigInt(d.amountB));
    const fee = Number(d.feeTier) || 3000;
    const state = await readPool(ctx.provider, a.address, b.address, fee);
    if (!state) throw new Error("The Uniswap pool no longer exists.");
    const [t0, t1] = orderSides(a, b);
    const problem = lpPriceProblem(state.sqrtPriceX96, t0, t1);
    if (problem) throw new Error(problem);

    const plan = planMint(a, b, fee, state.sqrtPriceX96);
    const batch = buildMintBatch(plan, ctx.safeAddress, Math.floor(Date.now() / 1000) + 20 * 60);
    console.log(`[adapter:add_liquidity] EXECUTE via Safe ${ctx.safeAddress}: ${batch.length} op(s)`);
    const { executeBatchViaSafe } = await import("../integrations/safe/transaction");
    const txHash = await executeBatchViaSafe(ctx.safeAddress, agentKey, batch, "900000");

    const tradeId = crypto.randomUUID();
    const { logTradeResult } = await import("./logResult");
    logTradeResult(tradeId, txHash, "success").catch(() => {});
    return { txHash, explorerUrl: `https://sepolia.etherscan.io/tx/${txHash}`, tradeId };
  },
};

// ─── remove_liquidity — withdraw a share of a position, from the Safe ───
// The resolver picked the position and previewed the amounts. Execution re-reads
// it (it may have changed since), checks the Safe still owns it, and runs
// decreaseLiquidity → collect (with fees) → unwrap WETH / sweep → burn if emptied.
const removeLiquidityAdapter: IntentAdapter = {
  kind: "remove_liquidity",
  async build(ctx) {
    if (!ctx.safeAddress) return { refusal: "Liquidity positions live in your Safe, and you don't have one yet." };
    const p = ctx.params;
    const lpRemoveData = {
      tokenId: String(p.tokenId), percent: Number(p.percent),
      token0: p.token0, token1: p.token1, symbol0: p.symbol0, symbol1: p.symbol1, fee: Number(p.fee),
    };
    return {
      plan: { id: crypto.randomUUID(), summary: ctx.planSummary, steps: ctx.planSteps, totalEstimatedValueUsd: ctx.totalEstimatedValueUsd },
      payload: { lpRemoveData },
    };
  },

  async execute(ctx, built) {
    const d = (built.payload as any)?.lpRemoveData;
    if (!d || !ctx.safeAddress) return null;
    const agentKey = process.env.AGENT_PRIVATE_KEY;
    if (!agentKey) throw new Error("AGENT_PRIVATE_KEY not set");

    const owner = await positionOwner(ctx.provider, d.tokenId).catch(() => null);
    if (!owner || owner.toLowerCase() !== ctx.safeAddress.toLowerCase()) {
      throw new Error(`Position #${d.tokenId} is no longer held by your Safe.`);
    }
    const position = (await readPositions(ctx.provider, ctx.safeAddress, tokenByAddress)).find((x) => x.tokenId === d.tokenId);
    if (!position || position.liquidity === 0n) throw new Error(`Position #${d.tokenId} has no liquidity left to remove.`);
    if (position.token0.address.toLowerCase() !== String(d.token0).toLowerCase() || position.token1.address.toLowerCase() !== String(d.token1).toLowerCase()) {
      throw new Error(`Position #${d.tokenId} doesn't hold the approved tokens.`);
    }

    const plan = planRemove(position, d.percent);
    const batch = buildRemoveBatch(position, plan, ctx.safeAddress, Math.floor(Date.now() / 1000) + 20 * 60, WETH_SEPOLIA);
    console.log(`[adapter:remove_liquidity] EXECUTE via Safe ${ctx.safeAddress}: ${d.percent}% of #${d.tokenId}${plan.burn ? " (+ burn)" : ""}`);
    const { executeBatchViaSafe } = await import("../integrations/safe/transaction");
    const txHash = await executeBatchViaSafe(ctx.safeAddress, agentKey, batch, "600000");

    const tradeId = crypto.randomUUID();
    const { logTradeResult } = await import("./logResult");
    logTradeResult(tradeId, txHash, "success").catch(() => {});
    return { txHash, explorerUrl: `https://sepolia.etherscan.io/tx/${txHash}`, tradeId };
  },
};

// ─── swap — fetch Uniswap quote, optionally auto-execute via Safe ───
const swapAdapter: IntentAdapter = {
  kind: "swap",

  async build(ctx) {
    const p = ctx.params;
    const symbolIn = p.symbolIn || symbolFromAddress(p.tokenIn || "", "ETH");
    const symbolOut = p.symbolOut || symbolFromAddress(p.tokenOut || "", "USDC");
    const tokenIn = routingToken(p.tokenIn || WETH_SEPOLIA, symbolIn);
    const tokenOut = routingToken(p.tokenOut || USDC_SEPOLIA, symbolOut);
    const rawAmount = String(p.amount || "0");

    // Already-wei amounts (10+ digits) pass through; otherwise convert by decimals.
    const amountWei = /^\d{10,}$/.test(String(rawAmount))
      ? rawAmount
      : toTokenWei(rawAmount, tokenIn).toString();

    console.log(`[adapter:swap] ${rawAmount} ${symbolIn} → ${symbolOut} (${amountWei} wei)`);

    let quoteData: Record<string, any> | null = null;
    let summary = ctx.planSummary;
    let refusal: string | undefined;
    const swapper = ctx.safeAddress || ctx.walletAddress;
    if (swapper) {
      try {
        const approvalTx = isNativeEth(symbolIn, tokenIn)
          ? null
          : await checkApproval({ walletAddress: swapper, token: tokenIn, tokenOut, amount: amountWei });
        const quoteResult = await fetchQuoteWithRouting({ swapper, tokenIn, tokenOut, amount: amountWei }, "autonomous");
        console.log(`[adapter:swap]   routing: ${quoteResult.routing}, permit: ${quoteResult.permitData ? "yes" : "no"}`);

        const assessed = assessQuote(quoteResult.quote, { tokenIn, symbolIn, amountIn: amountWei, tokenOut, symbolOut });
        refusal = assessed.refusal;
        if (assessed.amountOut != null) summary = swapSummary(rawAmount, symbolIn, assessed.amountOut, symbolOut, assessed.check);
        if (refusal) console.warn(`[adapter:swap] quote refused: ${refusal}`);

        quoteData = {
          tradeId: crypto.randomUUID(),
          quote: quoteResult.quote, permitData: quoteResult.permitData,
          routing: quoteResult.routing, isMevProtected: quoteResult.isMevProtected,
          isGasless: quoteResult.isGasless, riskLevel: "autonomous",
          approvalNeeded: !!approvalTx, approvalTx,
          tokenIn, tokenOut, amount: amountWei, symbolIn, symbolOut,
          expectedOut: assessed.amountOut,
        };
      } catch (err: any) {
        console.error(`[adapter:swap] quote error: ${err.message}`);
      }
    }

    const plan = {
      id: quoteData?.tradeId || crypto.randomUUID(),
      summary, steps: ctx.planSteps, totalEstimatedValueUsd: ctx.totalEstimatedValueUsd,
    };
    if (refusal) return { plan, refusal };
    return { plan, payload: { quoteData } };
  },

  async execute(ctx, built) {
    const quoteData = (built.payload as any)?.quoteData as Record<string, any> | null;
    if (!quoteData || !ctx.safeAddress) return null;

    const agentKey = process.env.AGENT_PRIVATE_KEY;
    if (!agentKey) throw new Error("AGENT_PRIVATE_KEY not set");

    const { getApprovalTxsForSwap, executeBatchViaSafe } = await import("../integrations/safe/transaction");
    const { submitSwap } = await import("../integrations/uniswap/api");

    console.log(`[adapter:swap] AUTO_EXECUTE — fetching fresh quote…`);
    const freshQuote = await fetchQuoteWithRouting(
      { swapper: ctx.safeAddress, tokenIn: quoteData.tokenIn, tokenOut: quoteData.tokenOut, amount: quoteData.amount },
      "autonomous"
    );
    // Re-check the quote that will actually execute: the price can move between
    // the preview and here (a passkey approval can come minutes later).
    const { refusal } = assessQuote(freshQuote.quote, {
      tokenIn: quoteData.tokenIn, symbolIn: quoteData.symbolIn || symbolFor(quoteData.tokenIn),
      amountIn: String(quoteData.amount), tokenOut: quoteData.tokenOut,
      symbolOut: quoteData.symbolOut || symbolFor(quoteData.tokenOut),
    });
    if (refusal) throw new Error(refusal);
    const swapTx = await submitSwap(freshQuote.quote, null, undefined);
    console.log(`[adapter:swap] AUTO_EXECUTE swap tx: to=${swapTx.to}, value=${swapTx.value}`);

    const batch: Array<{ to: string; value: string; data: string }> = [];
    const ETH_ADDRESS = "0x0000000000000000000000000000000000000000";
    if (quoteData.tokenIn.toLowerCase() !== ETH_ADDRESS.toLowerCase()) {
      const approvalTxs = await getApprovalTxsForSwap(
        ctx.safeAddress, quoteData.tokenIn, BigInt(quoteData.amount || "0"), swapTx.to
      );
      batch.push(...approvalTxs);
    }

    let swapValue = swapTx.value?.startsWith("0x") ? BigInt(swapTx.value).toString() : (swapTx.value || "0");
    // Native ETH in: the Safe must forward the amount. A 0-value call tries to pull WETH and reverts GS013.
    if (isNativeEth(undefined, quoteData.tokenIn) && BigInt(swapValue || "0") === 0n) {
      swapValue = String(quoteData.amount || "0");
    }
    batch.push({ to: swapTx.to, value: swapValue, data: swapTx.data });

    const uniswapGas = parseInt(freshQuote.quote?.gasUseEstimate || "300000", 10);
    const safeGasLimit = String(uniswapGas + 150000);
    console.log(`[adapter:swap] AUTO_EXECUTE — executing ${batch.length} op(s) via Safe, gasLimit=${safeGasLimit}…`);
    const txHash = await executeBatchViaSafe(ctx.safeAddress, agentKey, batch, safeGasLimit);

    const { logTradeResult } = await import("./logResult");
    const tradeId = quoteData.tradeId || crypto.randomUUID();
    logTradeResult(tradeId, txHash, "success").catch(() => {});

    console.log(`[adapter:swap] AUTO_EXECUTE success: ${txHash}`);
    return { txHash, explorerUrl: `https://sepolia.etherscan.io/tx/${txHash}`, tradeId };
  },
};

// ─── Registry ───
const REGISTRY: Record<string, IntentAdapter> = {
  [balanceAdapter.kind]: balanceAdapter,
  [sendAdapter.kind]: sendAdapter,
  [depositAdapter.kind]: depositAdapter,
  [addLiquidityAdapter.kind]: addLiquidityAdapter,
  [removeLiquidityAdapter.kind]: removeLiquidityAdapter,
  [swapAdapter.kind]: swapAdapter,
};

/** Look up the adapter for an intent kind, or undefined if none is registered. */
export function getAdapter(kind: string): IntentAdapter | undefined {
  return REGISTRY[kind];
}
