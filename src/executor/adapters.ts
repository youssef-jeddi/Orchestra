// ─── Executor — intent adapters ───
// Each adapter turns a planned intent into the response the /intent endpoint
// returns (unsigned tx(s), quotes, balances). Adding a new capability — a new
// protocol (Aave, Lido) or action — becomes "write an adapter + register it",
// instead of editing the monolithic /intent handler.
//
// The interface is deliberately shaped to fit protocol integrations, not just
// native transfers: an adapter can fetch quotes, check approvals, and build one
// or more unsigned transactions. Server-side auto-execution (the swap path) will
// move behind an optional `execute()` on this interface in a follow-up.

import { ethers } from "ethers";
import crypto from "crypto";
import { WETH_SEPOLIA, USDC_SEPOLIA } from "../integrations/uniswap/types";
import { checkApproval } from "../integrations/uniswap/api";
import { fetchQuoteWithRouting } from "../integrations/uniswap/routing";
import { TOKEN_DECIMALS, toTokenWei, symbolFromAddress } from "../policy";

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
      const ethBal = await ctx.provider.getBalance(ctx.balanceAddress!);
      const eth = Number(ethers.formatEther(ethBal));
      balances = { eth, weth: 0, usdc: 0, totalUsd: eth * 2500 };
    }
    return {
      plan: {
        id: crypto.randomUUID(),
        summary: `Portfolio: ${balances.eth.toFixed(4)} ETH, ${balances.weth.toFixed(4)} WETH, ${balances.usdc.toFixed(2)} USDC`,
        steps: [],
        totalEstimatedValueUsd: balances.totalUsd,
      },
      assessment: { verdict: "INFO", riskScore: 0, reasons: ["Read-only query"], requiresLedger: false, triggered: [] },
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
};

// ─── add_liquidity — check approvals, build quote data ───
const addLiquidityAdapter: IntentAdapter = {
  kind: "add_liquidity",
  async build(ctx) {
    const p = ctx.params;
    const tokenA = p.tokenA || WETH_SEPOLIA;
    const tokenB = p.tokenB || USDC_SEPOLIA;
    const amountA = String(p.amountA || "0");
    const amountB = String(p.amountB || "0");
    const symbolA = p.symbolA || symbolFromAddress(tokenA, "WETH");
    const symbolB = p.symbolB || symbolFromAddress(tokenB, "USDC");
    const feeTier = p.feeTier || 3000;

    console.log(`[adapter:add_liquidity] ${amountA} ${symbolA} + ${amountB} ${symbolB} (fee: ${feeTier / 10000}%)`);

    let quoteData: Record<string, unknown> | null = null;
    const swapper = ctx.safeAddress || ctx.walletAddress;
    if (swapper) {
      try {
        const amountAWei = toTokenWei(amountA, tokenA).toString();
        const amountBWei = toTokenWei(amountB, tokenB).toString();
        const [approvalA, approvalB] = await Promise.all([
          checkApproval({ walletAddress: swapper, token: tokenA, tokenOut: tokenB, amount: amountAWei }),
          checkApproval({ walletAddress: swapper, token: tokenB, tokenOut: tokenA, amount: amountBWei }),
        ]);
        quoteData = {
          tradeId: crypto.randomUUID(), routing: "CLASSIC", riskLevel: "autonomous",
          approvalNeeded: !!(approvalA || approvalB),
          approvalTxA: approvalA, approvalTxB: approvalB,
          tokenA, tokenB, amountA: amountAWei, amountB: amountBWei, feeTier,
        };
      } catch (err: any) {
        console.error(`[adapter:add_liquidity] approval check error: ${err.message}`);
      }
    }

    return { payload: { quoteData } };
  },
};

// ─── swap — fetch Uniswap quote, optionally auto-execute via Safe ───
const swapAdapter: IntentAdapter = {
  kind: "swap",

  async build(ctx) {
    const p = ctx.params;
    const tokenIn = p.tokenIn || WETH_SEPOLIA;
    const tokenOut = p.tokenOut || USDC_SEPOLIA;
    const rawAmount = String(p.amount || "0");
    const symbolIn = p.symbolIn || symbolFromAddress(tokenIn, "ETH");
    const symbolOut = p.symbolOut || symbolFromAddress(tokenOut, "USDC");

    // Already-wei amounts (10+ digits) pass through; otherwise convert by decimals.
    const amountWei = /^\d{10,}$/.test(String(rawAmount))
      ? rawAmount
      : toTokenWei(rawAmount, tokenIn).toString();

    console.log(`[adapter:swap] ${rawAmount} ${symbolIn} → ${symbolOut} (${amountWei} wei)`);

    let quoteData: Record<string, any> | null = null;
    const swapper = ctx.safeAddress || ctx.walletAddress;
    if (swapper) {
      try {
        const approvalTx = await checkApproval({ walletAddress: swapper, token: tokenIn, tokenOut, amount: amountWei });
        const quoteResult = await fetchQuoteWithRouting({ swapper, tokenIn, tokenOut, amount: amountWei }, "autonomous");
        console.log(`[adapter:swap]   routing: ${quoteResult.routing}, permit: ${quoteResult.permitData ? "yes" : "no"}`);
        quoteData = {
          tradeId: crypto.randomUUID(),
          quote: quoteResult.quote, permitData: quoteResult.permitData,
          routing: quoteResult.routing, isMevProtected: quoteResult.isMevProtected,
          isGasless: quoteResult.isGasless, riskLevel: "autonomous",
          approvalNeeded: !!approvalTx, approvalTx,
          tokenIn, tokenOut, amount: amountWei,
        };
      } catch (err: any) {
        console.error(`[adapter:swap] quote error: ${err.message}`);
      }
    }

    return {
      plan: {
        id: quoteData?.tradeId || crypto.randomUUID(),
        summary: ctx.planSummary, steps: ctx.planSteps, totalEstimatedValueUsd: ctx.totalEstimatedValueUsd,
      },
      payload: { quoteData },
    };
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

    const swapValue = swapTx.value?.startsWith("0x") ? BigInt(swapTx.value).toString() : (swapTx.value || "0");
    batch.push({ to: swapTx.to, value: swapValue, data: swapTx.data });

    const uniswapGas = parseInt(freshQuote.quote?.gasUseEstimate || "300000", 10);
    const safeGasLimit = String(uniswapGas + 150000);
    console.log(`[adapter:swap] AUTO_EXECUTE — executing ${batch.length} op(s) via Safe, gasLimit=${safeGasLimit}…`);
    const txHash = await executeBatchViaSafe(ctx.safeAddress, agentKey, batch, safeGasLimit);

    const { logTradeResult } = await import("./logResult");
    const tradeId = quoteData.tradeId || crypto.randomUUID();
    await logTradeResult(tradeId, txHash, "success");

    console.log(`[adapter:swap] AUTO_EXECUTE success: ${txHash}`);
    return { txHash, explorerUrl: `https://sepolia.etherscan.io/tx/${txHash}`, tradeId };
  },
};

// ─── Registry ───
const REGISTRY: Record<string, IntentAdapter> = {
  [balanceAdapter.kind]: balanceAdapter,
  [sendAdapter.kind]: sendAdapter,
  [addLiquidityAdapter.kind]: addLiquidityAdapter,
  [swapAdapter.kind]: swapAdapter,
};

/** Look up the adapter for an intent kind, or undefined if none is registered. */
export function getAdapter(kind: string): IntentAdapter | undefined {
  return REGISTRY[kind];
}
