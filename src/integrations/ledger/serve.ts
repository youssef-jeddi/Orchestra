// ─── SafeSwarm × Ledger — Dev Server ───
// Express + WS bridge. Serves the test UI and exposes POST /mock-trade.

import "dotenv/config";

import express from "express";
import http from "http";
import crypto from "crypto";
import { ethers } from "ethers";
import { BridgeServer } from "./bridge";
import type { ApprovalRequest, ProposedTrade } from "./types";
import { assessRisk } from "./riskEngine";
import { checkApproval, getQuote } from "../uniswap/api";
import { fetchQuoteWithRouting } from "../uniswap/routing";
import { executeSwap } from "../uniswap/execution";
import { WETH_SEPOLIA, USDC_SEPOLIA, CHAIN_ID } from "../uniswap/types";
import { runPlanner } from "../../agents/planner/index";
import { runGatekeeper } from "../../agents/gatekeeper/index";
import { write, read, readMany } from "../zero-g/storage";
import { setComputeProvider, getComputeProvider } from "../zero-g/compute";
import { deploySafe } from "../safe/deploy";
import { detectExistingSafe } from "../safe/detect";
import { setInitialSpendingLimits, updateSpendingLimit, buildLimitUpdateTx } from "../safe/spendingLimit";
import { getAgentAddress } from "../safe/agentWallet";
import { executePlan } from "../../executor";
import { getSpendingLimit, getAllowanceTokens, updateSpendingLimit } from "../safe/spendingLimit";
import { initSafe } from "../safe/transaction";
import { ALLOWANCE_MODULE_ADDRESS } from "../../types/safe";
import { getTokens } from "../uniswap/types";

const SEPOLIA_RPC = process.env.SEPOLIA_RPC_URL || "https://eth-sepolia.g.alchemy.com/v2/demo";
const provider = new ethers.JsonRpcProvider(SEPOLIA_RPC);
const PORT = Number(process.env.LEDGER_BRIDGE_PORT) || 3001;

const app = express();
app.use(express.json());

// CORS — allow Vite dev server (port 3000) to call us
app.use((_req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  next();
});

const server = http.createServer(app);
const bridge = new BridgeServer(server);

// ─── POST /mock-trade ───
// Inject a test approval request (from curl, Postman, or the UI button)
app.post("/mock-trade", async (req, res) => {
  // Build a realistic unsigned transaction to the Uniswap Universal Router
  const tx = ethers.Transaction.from({
    to: "0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD",
    value: ethers.parseEther(req.body.ethAmount || "0.5"),
    data: "0x3593564c", // execute() selector stub
    chainId: 1,
    gasLimit: 300_000n,
    maxFeePerGas: ethers.parseUnits("10", "gwei"),
    maxPriorityFeePerGas: ethers.parseUnits("2", "gwei"),
    nonce: 0,
    type: 2,
  });

  const request: ApprovalRequest = {
    tradeId: crypto.randomUUID(),
    unsignedTxHex: tx.unsignedSerialized,
    summary:
      req.body.summary || "Swap 0.5 ETH → ~1,247 USDC via Uniswap V3",
    riskLevel: req.body.riskLevel || "requires_approval",
    timestamp: Date.now(),
  };

  console.log(`[serve] mock trade created: ${request.tradeId}`);

  // Fire-and-forget the approval (the result comes back via WS)
  bridge
    .requestApproval(request)
    .then((result) => {
      console.log(
        `[serve] trade ${result.tradeId}: ${result.approved ? "✓ approved" : "✗ rejected"}`
      );
    })
    .catch((err) => {
      console.error(`[serve] trade error: ${err.message}`);
    });

  res.json({ ok: true, tradeId: request.tradeId });
});

// ─── POST /quote ───
// Get a real Uniswap quote, run risk assessment, return everything the UI needs.
app.post("/quote", async (req, res) => {
  try {
    const { tokenIn, tokenOut, amount, walletAddress } = req.body;

    if (!walletAddress || !amount) {
      res.status(400).json({ error: "walletAddress and amount are required" });
      return;
    }

    const tokenInAddr = tokenIn || WETH_SEPOLIA;
    const tokenOutAddr = tokenOut || USDC_SEPOLIA;

    console.log(`[serve] /quote request:`, { walletAddress, tokenIn: tokenInAddr, tokenOut: tokenOutAddr, amount });

    // Check if Permit2 approval is needed
    const approvalTx = await checkApproval({
      walletAddress,
      token: tokenInAddr,
      tokenOut: tokenOutAddr,
      amount,
    });

    // Preliminary risk assessment to determine routing
    const trade: ProposedTrade = {
      tradeId: crypto.randomUUID(),
      fromToken: tokenInAddr,
      toToken: tokenOutAddr,
      amountIn: amount,
      valueUSD: 0, // will be refined after quote
      tokenVerified: true, // assume verified for WETH/USDC
      liquidityUSD: 1_000_000, // placeholder until quote returns
      routerAddress: "0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD",
      calldataHex: "",
      summary: "",
    };

    const riskLevel = assessRisk(trade);

    // Fetch quote with risk-adapted routing
    const quoteResult = await fetchQuoteWithRouting(
      {
        swapper: walletAddress,
        tokenIn: tokenInAddr,
        tokenOut: tokenOutAddr,
        amount,
      },
      riskLevel
    );

    console.log(`[serve] quote fetched — routing: ${quoteResult.routing}, MEV protected: ${quoteResult.isMevProtected}`);

    res.json({
      tradeId: trade.tradeId,
      quote: quoteResult.quote,
      permitData: quoteResult.permitData,
      routing: quoteResult.routing,
      isMevProtected: quoteResult.isMevProtected,
      isGasless: quoteResult.isGasless,
      riskLevel,
      approvalNeeded: !!approvalTx,
      approvalTx,
    });
  } catch (err: any) {
    console.error("[serve] /quote error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /swap ───
// Send permit2 signature to Uniswap /swap API → returns unsigned tx to sign on Ledger.
app.post("/swap", async (req, res) => {
  try {
    const { quote, permitData, signature, routing } = req.body;

    if (!quote || !routing) {
      res.status(400).json({ error: "quote and routing are required" });
      return;
    }

    // UniswapX: submit the gasless order directly (no on-chain tx needed)
    if (routing === "DUTCH_V2" || routing === "DUTCH_V3") {
      const { submitOrder } = await import("../uniswap/api");
      const order = await submitOrder(quote, signature);
      console.log(`[serve] UniswapX order submitted: ${order.orderId}`);
      res.json({ type: "uniswapx", orderId: order.orderId });
      return;
    }

    // Classic: call Uniswap /swap to get the unsigned tx
    console.log(`[serve] /swap request — routing: ${routing}, hasPermitData: ${!!permitData}, hasSignature: ${!!signature}`);
    const { submitSwap } = await import("../uniswap/api");
    const swapTx = await submitSwap(quote, permitData, signature);

    console.log(`[serve] ── Unsigned Swap Tx from Uniswap API ──`);
    console.log(`[serve]   to:       ${swapTx.to}`);
    console.log(`[serve]   value:    ${swapTx.value}`);
    console.log(`[serve]   gasLimit: ${swapTx.gasLimit}`);
    console.log(`[serve]   data:     ${(swapTx.data || "").slice(0, 40)}…(${(swapTx.data || "").length} chars)`);

    // Return the unsigned tx fields — the UI will sign this on Ledger
    res.json({
      type: "classic",
      unsignedTx: swapTx, // { to, data, value, gasLimit, ... }
    });
  } catch (err: any) {
    console.error("[serve] /swap error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /broadcast ───
// Broadcast a fully signed raw transaction to Sepolia.
app.post("/broadcast", async (req, res) => {
  try {
    const { signedTx } = req.body;

    if (!signedTx) {
      res.status(400).json({ error: "signedTx (hex) is required" });
      return;
    }

    console.log(`[serve] broadcasting tx (${signedTx.length} chars)…`);

    const txResponse = await provider.broadcastTransaction(signedTx);

    console.log(`[serve] ✓ tx broadcast — hash: ${txResponse.hash}`);
    console.log(`[serve]   explorer: https://sepolia.etherscan.io/tx/${txResponse.hash}`);

    res.json({
      txHash: txResponse.hash,
      explorerUrl: `https://sepolia.etherscan.io/tx/${txResponse.hash}`,
    });
  } catch (err: any) {
    console.error("[serve] /broadcast error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /nonce ───
// Get the current nonce for a wallet address (needed for tx signing).
app.get("/nonce/:address", async (req, res) => {
  try {
    const nonce = await provider.getTransactionCount(req.params.address, "pending");
    const feeData = await provider.getFeeData();

    // Fallback to 20 gwei / 2 gwei if the RPC doesn't return EIP-1559 fields
    const maxFee = feeData.maxFeePerGas ?? ethers.parseUnits("20", "gwei");
    const maxPriority = feeData.maxPriorityFeePerGas ?? ethers.parseUnits("2", "gwei");

    console.log(`[serve] nonce for ${req.params.address}: ${nonce}, maxFee: ${maxFee}, maxPriority: ${maxPriority}`);
    res.json({
      nonce,
      maxFeePerGas: maxFee.toString(),
      maxPriorityFeePerGas: maxPriority.toString(),
    });
  } catch (err: any) {
    console.error("[serve] /nonce error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Token decimal map (case-insensitive lookup) ───
const TOKEN_DECIMALS: Record<string, number> = {
  [USDC_SEPOLIA.toLowerCase()]: 6,                                        // USDC Sepolia
  ['0xaA8E23Fb1079EA71e0a56F48a2aA51851D8433D0'.toLowerCase()]: 6,        // USDT Sepolia
  [WETH_SEPOLIA.toLowerCase()]: 18,                                       // WETH Sepolia
  ['0xC558DBdd856501FCd9aaF1E62eae57A9F0629a3c'.toLowerCase()]: 18,       // WETH alt Sepolia
};

function toTokenWei(amount: string, tokenAddress: string): bigint {
  const decimals = TOKEN_DECIMALS[tokenAddress.toLowerCase()] ?? 18;
  return ethers.parseUnits(amount, decimals);
}

// ─── Address → symbol lookup ───
const TOKEN_SYMBOLS: Record<string, string> = {
  [WETH_SEPOLIA.toLowerCase()]: "ETH",
  ['0xC558DBdd856501FCd9aaF1E62eae57A9F0629a3c'.toLowerCase()]: "ETH",
  [USDC_SEPOLIA.toLowerCase()]: "USDC",
  ['0xaA8E23Fb1079EA71e0a56F48a2aA51851D8433D0'.toLowerCase()]: "USDT",
  // Mainnet
  ['0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'.toLowerCase()]: "ETH",
  ['0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'.toLowerCase()]: "USDC",
};

function symbolFromAddress(address: string, fallback: string = "UNKNOWN"): string {
  return TOKEN_SYMBOLS[address.toLowerCase()] || fallback;
}

// ─── Intent type detection (from AI plan steps) ───
function detectIntentType(steps: any[]): "swap" | "send" | "add_liquidity" | "balance" | "unknown" {
  if (!steps || steps.length === 0) return "unknown";
  const action = steps[0]?.action;
  if (action === "swap") return "swap";
  if (action === "send") return "send";
  if (action === "add_liquidity") return "add_liquidity";
  if (action === "balance") return "balance";
  return "unknown";
}

// ─── Helper: estimate USD value for risk assessment ───
function estimateUsd(symbol: string, amount: number): number {
  const s = symbol.toUpperCase();
  if (s === "USDC" || s === "USDT") return amount;
  if (s === "ETH" || s === "WETH") return amount * 2500;
  return amount;
}

// ─── POST /intent ───
// ALL intents go through AI pipeline: Planner → Gatekeeper → dispatch by intent type.
app.post("/intent", async (req, res) => {
  try {
    const { message, walletAddress, autoApproveLimit: clientLimit } = req.body;

    if (!message) {
      res.status(400).json({ error: "message is required" });
      return;
    }

    console.log(`\n[intent] ═══════════════════════════════════════`);
    console.log(`[intent] "${message}"`);
    console.log(`[intent] wallet: ${walletAddress || "not provided"}`);

    // ── Step 0a: Check Safe deployment ──
    let safeAddress: string | null = null;
    if (walletAddress) {
      try {
        const safeData = await read(`safe:${walletAddress.toLowerCase()}`);
        if (safeData) {
          safeAddress = (safeData as any).safeAddress;
          console.log(`[intent] Safe detected: ${safeAddress}`);
        } else {
          console.log(`[intent] No Safe found — user needs onboarding`);
        }
      } catch (safeReadErr: any) {
        console.warn(`[intent] Safe read from 0G failed (non-critical): ${safeReadErr.message}`);
      }
    }

    // ── Step 0b: Fetch on-chain balances (from Safe if available) ──
    const balanceAddress = safeAddress || walletAddress;
    let balances: { eth: number; weth: number; usdc: number; totalUsd: number } | null = null;
    if (balanceAddress) {
      try {
        const ethBalance = await provider.getBalance(balanceAddress);
        const ethFormatted = Number(ethers.formatEther(ethBalance));

        const erc20Abi = ["function balanceOf(address) view returns (uint256)"];
        const usdcContract = new ethers.Contract(USDC_SEPOLIA, erc20Abi, provider);
        const wethContract = new ethers.Contract(WETH_SEPOLIA, erc20Abi, provider);

        const [usdcRaw, wethRaw] = await Promise.all([
          usdcContract.balanceOf(balanceAddress).catch(() => 0n),
          wethContract.balanceOf(balanceAddress).catch(() => 0n),
        ]);

        const usdcFormatted = Number(ethers.formatUnits(usdcRaw, 6));
        const wethFormatted = Number(ethers.formatEther(wethRaw));
        const totalUsd = (ethFormatted + wethFormatted) * 2500 + usdcFormatted;

        balances = { eth: ethFormatted, weth: wethFormatted, usdc: usdcFormatted, totalUsd };

        await write("portfolio:current", {
          eth: ethFormatted,
          weth: wethFormatted,
          usdc: usdcFormatted,
          totalUsd,
          source: safeAddress ? "safe" : "eoa",
          address: balanceAddress,
          updatedAt: new Date().toISOString(),
        });
        console.log(`[intent] Portfolio (${safeAddress ? 'Safe' : 'EOA'}): ${ethFormatted} ETH, ${wethFormatted} WETH, ${usdcFormatted} USDC ($${totalUsd.toFixed(2)})`);
      } catch (err: any) {
        console.warn(`[intent] Failed to fetch on-chain balances: ${err.message}`);
      }
    }

    // ── Step 0c: Ensure user profile exists in storage ──
    const existingProfile = await read("user:profile");
    if (!existingProfile) {
      await write("user:profile", {
        address: walletAddress || "",
        autoApproveLimit: 100,
        currency: "USD",
        knownAddresses: walletAddress ? [walletAddress] : [],
        createdAt: new Date().toISOString(),
      });
      console.log(`[intent] Seeded default user profile`);
    }

    // ═══════════════════════════════════════════
    // ── Step 1: Run AI Planner ──
    // ═══════════════════════════════════════════
    await write("messages:latest", { message, walletAddress, timestamp: new Date().toISOString() });

    console.log(`[intent] Running Planner…`);
    const plannerResult = await runPlanner(message);
    console.log(`[intent] Planner action: ${plannerResult.action}`);
    console.log(`[intent] Planner reasoning: ${plannerResult.reasoning}`);

    const plans = (await readMany("plans")) as Record<string, unknown>[];
    const latestPlan = plans.sort((a, b) =>
      (b.createdAt as string).localeCompare(a.createdAt as string)
    )[0];

    if (!latestPlan) {
      await write("messages:latest", { message: null, timestamp: null });
      console.log(`[intent] No plan written by Planner`);
      res.json({ status: "no_action", intentType: "unknown", reasoning: plannerResult.reasoning });
      return;
    }

    console.log(`[intent] Plan: ${JSON.stringify(latestPlan, null, 2)}`);

    // ═══════════════════════════════════════════
    // ── Step 2: Run Gatekeeper ──
    // ═══════════════════════════════════════════
    console.log(`[intent] Running Gatekeeper…`);
    let gatekeeperResult: { reasoning: string };
    try {
      gatekeeperResult = await runGatekeeper();
    } catch (gkErr: any) {
      console.warn(`[intent] Gatekeeper run failed (non-critical): ${gkErr.message}`);
      gatekeeperResult = { reasoning: "Gatekeeper encountered an error — falling back to server-side assessment." };
    }
    console.log(`[intent] Gatekeeper reasoning: ${gatekeeperResult.reasoning}`);

    let latestAssessment: Record<string, unknown> | undefined;
    try {
      const assessments = (await readMany("assessments")) as Record<string, unknown>[];
      latestAssessment = assessments.sort((a, b) =>
        (b.assessedAt as string).localeCompare(a.assessedAt as string)
      )[0];
    } catch (readErr: any) {
      console.warn(`[intent] Failed to read assessments from 0G (non-critical): ${readErr.message}`);
    }

    try { await write("messages:latest", { message: null, timestamp: null }); } catch {};

    // ═══════════════════════════════════════════
    // ── Step 3: Detect intent type from AI plan steps ──
    // ═══════════════════════════════════════════
    const planSteps = (latestPlan.steps as any[]) || [];
    const intentType = detectIntentType(planSteps);
    const step0 = planSteps[0] || {};
    const params = step0.params || {};
    const planSummary = latestPlan.summary as string;

    // Recompute USD value server-side — don't trust the AI's estimate
    let totalEstimatedValueUsd = (latestPlan.totalEstimatedValueUsd as number) || 0;
    if (intentType === "swap") {
      const sym = params.symbolIn || symbolFromAddress(params.tokenIn || "", "ETH");
      totalEstimatedValueUsd = estimateUsd(sym, Number(params.amount || 0));
    } else if (intentType === "send") {
      totalEstimatedValueUsd = estimateUsd(params.symbol || "ETH", Number(params.amount || 0));
    }

    const aiVerdict = (latestAssessment?.verdict as string) ?? "NEEDS_APPROVAL";
    const aiRiskScore = (latestAssessment?.riskScore as number) ?? 50;
    const plannerReasoning = plannerResult.reasoning;
    const gatekeeperReasoning = gatekeeperResult.reasoning;

    // Server-side verdict override — use our recomputed USD value, not the AI's
    const autoApproveLimit = typeof clientLimit === 'number' && clientLimit > 0 ? clientLimit : 100;
    let verdict = aiVerdict;
    let riskScore = aiRiskScore;
    if (intentType === "balance") {
      verdict = "INFO";
      riskScore = 0;
    } else if (intentType === "swap" || intentType === "send") {
      if (totalEstimatedValueUsd <= autoApproveLimit) {
        verdict = "AUTO_EXECUTE";
        riskScore = Math.min(riskScore, 15);
      } else {
        // Over the limit — always require Ledger approval regardless of AI verdict
        verdict = "NEEDS_APPROVAL";
        riskScore = Math.max(riskScore, 70);
      }
    }

    console.log(`[intent] Intent type: ${intentType}`);
    console.log(`[intent] USD value (server): $${totalEstimatedValueUsd}`);
    console.log(`[intent] Verdict: ${verdict} (AI said: ${aiVerdict}, risk: ${riskScore})`);

    const baseAssessment = {
      verdict,
      riskScore,
      reasons: [gatekeeperReasoning],
      requiresLedger: verdict === "NEEDS_APPROVAL",
    };
    const agentReasoning = { planner: plannerReasoning, gatekeeper: gatekeeperReasoning };

    // ═══════════════════════════════════════════
    // ── BALANCE — instant on-chain read ──
    // ═══════════════════════════════════════════
    if (intentType === "balance") {
      if (!walletAddress) {
        res.status(400).json({ error: "Connect wallet first" });
        return;
      }
      if (!balances) {
        const ethBal = await provider.getBalance(balanceAddress!);
        balances = { eth: Number(ethers.formatEther(ethBal)), weth: 0, usdc: 0, totalUsd: Number(ethers.formatEther(ethBal)) * 2500 };
      }

      console.log(`[intent] ✓ Balance query answered`);
      res.json({
        status: "ok",
        intentType: "balance",
        autoExecuted: false,
        safeAddress,
        plan: {
          id: crypto.randomUUID(),
          summary: `Portfolio: ${balances.eth.toFixed(4)} ETH, ${balances.weth.toFixed(4)} WETH, ${balances.usdc.toFixed(2)} USDC`,
          steps: [],
          totalEstimatedValueUsd: balances.totalUsd,
        },
        assessment: { verdict: "INFO", riskScore: 0, reasons: ["Read-only query"], requiresLedger: false },
        balances,
        agentReasoning,
      });
      return;
    }

    // ═══════════════════════════════════════════
    // ── SEND — build unsigned transfer tx ──
    // ═══════════════════════════════════════════
    if (intentType === "send") {
      const symbol = params.symbol || "ETH";
      const amount = String(params.amount || "0");
      const to = params.to || "";
      const token = params.token || WETH_SEPOLIA;

      console.log(`[intent] ✓ Send: ${amount} ${symbol} → ${to}`);

      let unsignedTx: { to: string; data: string; value: string };
      if (symbol.toUpperCase() === "ETH") {
        unsignedTx = { to, data: "0x", value: ethers.parseEther(amount).toString() };
      } else {
        const tokenAddr = token;
        const decimals = TOKEN_DECIMALS[tokenAddr.toLowerCase()] ?? 18;
        const amountWei = ethers.parseUnits(amount, decimals);
        const erc20Iface = new ethers.Interface(["function transfer(address to, uint256 amount)"]);
        unsignedTx = { to: tokenAddr, data: erc20Iface.encodeFunctionData("transfer", [to, amountWei]), value: "0" };
      }

      res.json({
        status: "ok",
        intentType: "send",
        autoExecuted: false,
        safeAddress,
        plan: { id: crypto.randomUUID(), summary: planSummary, steps: planSteps, totalEstimatedValueUsd },
        assessment: baseAssessment,
        sendData: { unsignedTx, token, symbol, amount, to },
        agentReasoning,
      });
      return;
    }

    // ═══════════════════════════════════════════
    // ── ADD LIQUIDITY — check approvals ──
    // ═══════════════════════════════════════════
    if (intentType === "add_liquidity") {
      const tokenA = params.tokenA || WETH_SEPOLIA;
      const tokenB = params.tokenB || USDC_SEPOLIA;
      const amountA = String(params.amountA || "0");
      const amountB = String(params.amountB || "0");
      const symbolA = params.symbolA || symbolFromAddress(tokenA, "WETH");
      const symbolB = params.symbolB || symbolFromAddress(tokenB, "USDC");
      const feeTier = params.feeTier || 3000;

      console.log(`[intent] ✓ Add liquidity: ${amountA} ${symbolA} + ${amountB} ${symbolB} (fee: ${feeTier / 10000}%)`);

      let quoteData = null;
      const swapper = safeAddress || walletAddress;
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
          console.error(`[intent] Liquidity approval check error: ${err.message}`);
        }
      }

      res.json({
        status: "ok",
        intentType: "add_liquidity",
        autoExecuted: false,
        safeAddress,
        plan: { id: crypto.randomUUID(), summary: planSummary, steps: planSteps, totalEstimatedValueUsd },
        assessment: baseAssessment,
        quoteData,
        agentReasoning,
      });
      return;
    }

    // ═══════════════════════════════════════════
    // ── SWAP — fetch Uniswap quote ──
    // ═══════════════════════════════════════════
    if (intentType === "swap") {
      const tokenIn = params.tokenIn || WETH_SEPOLIA;
      const tokenOut = params.tokenOut || USDC_SEPOLIA;
      const rawAmount = String(params.amount || "0");
      const symbolIn = params.symbolIn || symbolFromAddress(tokenIn, "ETH");
      const symbolOut = params.symbolOut || symbolFromAddress(tokenOut, "USDC");

      // Convert to wei using correct decimals
      const amountWei = String(rawAmount).match(/^\d{10,}$/)
        ? rawAmount
        : toTokenWei(rawAmount, tokenIn).toString();

      console.log(`[intent] ✓ Swap: ${rawAmount} ${symbolIn} → ${symbolOut} (${amountWei} wei)`);

      let quoteData = null;
      const swapper = safeAddress || walletAddress;
      if (swapper) {
        try {
          const approvalTx = await checkApproval({ walletAddress: swapper, token: tokenIn, tokenOut, amount: amountWei });
          console.log(`[intent]   approval needed: ${!!approvalTx}`);

          const quoteResult = await fetchQuoteWithRouting(
            { swapper, tokenIn, tokenOut, amount: amountWei }, "autonomous"
          );

          console.log(`[intent]   routing: ${quoteResult.routing}, permit: ${quoteResult.permitData ? "yes" : "no"}`);

          quoteData = {
            tradeId: crypto.randomUUID(),
            quote: quoteResult.quote, permitData: quoteResult.permitData,
            routing: quoteResult.routing, isMevProtected: quoteResult.isMevProtected,
            isGasless: quoteResult.isGasless, riskLevel: "autonomous",
            approvalNeeded: !!approvalTx, approvalTx,
            tokenIn, tokenOut, amount: amountWei,
          };
        } catch (err: any) {
          console.error(`[intent] Quote error: ${err.message}`);
        }
      }

      // ── Auto-execute via Safe if verdict allows ──
      if (verdict === "AUTO_EXECUTE" && safeAddress && quoteData) {
        try {
          console.log(`[intent] AUTO_EXECUTE — executing via Safe...`);

          const agentKey = process.env.AGENT_PRIVATE_KEY;
          if (!agentKey) throw new Error("AGENT_PRIVATE_KEY not set");

          const { getApprovalTxsForSwap, executeBatchViaSafe } = await import("../safe/transaction");
          const { submitSwap } = await import("../uniswap/api");

          console.log(`[intent] AUTO_EXECUTE — fetching fresh quote...`);
          const freshQuote = await fetchQuoteWithRouting(
            { swapper: safeAddress, tokenIn: quoteData.tokenIn, tokenOut: quoteData.tokenOut, amount: quoteData.amount },
            "autonomous"
          );
          const swapTx = await submitSwap(freshQuote.quote, null, undefined);
          console.log(`[intent] AUTO_EXECUTE swap tx: to=${swapTx.to}, value=${swapTx.value}`);

          const batch: Array<{ to: string; value: string; data: string }> = [];
          const ETH_ADDRESS = "0x0000000000000000000000000000000000000000";
          if (quoteData.tokenIn.toLowerCase() !== ETH_ADDRESS.toLowerCase()) {
            const approvalTxs = await getApprovalTxsForSwap(
              safeAddress, quoteData.tokenIn, BigInt(quoteData.amount || "0"), swapTx.to
            );
            batch.push(...approvalTxs);
          }

          const swapValue = swapTx.value?.startsWith('0x')
            ? BigInt(swapTx.value).toString()
            : (swapTx.value || '0');
          batch.push({ to: swapTx.to, value: swapValue, data: swapTx.data });

          const uniswapGas = parseInt(freshQuote.quote?.gasUseEstimate || '300000', 10);
          const safeGasLimit = String(uniswapGas + 150000);
          console.log(`[intent] AUTO_EXECUTE — executing ${batch.length} op(s) via Safe, gasLimit=${safeGasLimit}...`);
          const txHash = await executeBatchViaSafe(safeAddress, agentKey, batch, safeGasLimit);

          const { logTradeResult } = await import("../../executor/logResult");
          const tradeId = quoteData.tradeId || crypto.randomUUID();
          await logTradeResult(tradeId, txHash, "success");

          console.log(`[intent] AUTO_EXECUTE success: ${txHash}`);
          res.json({
            status: "ok",
            intentType: "swap",
            autoExecuted: true,
            txHash,
            explorerUrl: `https://sepolia.etherscan.io/tx/${txHash}`,
            plan: { id: tradeId, summary: planSummary, steps: planSteps, totalEstimatedValueUsd },
            assessment: { verdict, riskScore, reasons: [gatekeeperReasoning], requiresLedger: false },
            agentReasoning,
          });
          return;
        } catch (err: any) {
          console.error(`[intent] AUTO_EXECUTE failed: ${err.message}`);
          console.error(err.stack);
          // Fall through to manual flow
        }
      }

      res.json({
        status: "ok",
        intentType: "swap",
        autoExecuted: false,
        safeAddress,
        plan: { id: quoteData?.tradeId || crypto.randomUUID(), summary: planSummary, steps: planSteps, totalEstimatedValueUsd },
        assessment: baseAssessment,
        quoteData,
        agentReasoning,
      });
      return;
    }

    // ═══════════════════════════════════════════
    // ── UNKNOWN — return AI plan as-is ──
    // ═══════════════════════════════════════════
    console.log(`[intent] Unknown intent type, returning raw AI plan`);
    console.log(`[intent] ═══════════════════════════════════════\n`);

    res.json({
      status: "ok",
      intentType: "unknown",
      autoExecuted: false,
      safeAddress,
      plan: { id: crypto.randomUUID(), summary: planSummary, steps: planSteps, totalEstimatedValueUsd },
      assessment: baseAssessment,
      agentReasoning,
    });
  } catch (err: any) {
    console.error("[intent] Pipeline error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Compute provider toggle ───
app.post("/set-compute-provider", (req, res) => {
  const { provider } = req.body;
  if (provider !== "groq" && provider !== "0g") {
    res.status(400).json({ error: "provider must be 'groq' or '0g'" });
    return;
  }
  setComputeProvider(provider);
  console.log(`[serve] Compute provider set to: ${provider}`);
  res.json({ success: true, provider });
});

app.get("/compute-provider", (_req, res) => {
  res.json({ provider: getComputeProvider() });
});

// ─── Safe onboarding ───
app.post("/onboard", async (req, res) => {
  try {
    const { ledgerAddress, spendingLimitUSD = 100 } = req.body;
    if (!ledgerAddress) {
      res.status(400).json({ error: "ledgerAddress is required" });
      return;
    }

    console.log(`[onboard] Checking Safe for ${ledgerAddress}...`);

    // Check for existing Safe
    const existing = await detectExistingSafe(ledgerAddress);
    if (existing) {
      const stored = await read(`safe:${ledgerAddress.toLowerCase()}`);
      console.log(`[onboard] Returning user — Safe: ${existing}`);
      res.json({
        isNewUser: false,
        safeAddress: existing,
        spendingLimitUSD: (stored as any)?.spendingLimitUSD || 100,
      });
      return;
    }

    // New user — deploy Safe
    console.log(`[onboard] New user — deploying Safe...`);
    let agentWalletAddress: string;
    try {
      agentWalletAddress = getAgentAddress();
    } catch {
      res.status(500).json({ error: "Agent wallet not configured (AGENT_PRIVATE_KEY)" });
      return;
    }

    const safeAddress = await deploySafe(ledgerAddress, agentWalletAddress, provider);

    // Set spending limits (non-blocking — may fail on some Safe SDK versions)
    const agentKey = process.env.AGENT_PRIVATE_KEY!;
    try {
      await setInitialSpendingLimits(safeAddress, agentWalletAddress, spendingLimitUSD, agentKey);
    } catch (limitErr: any) {
      console.warn(`[onboard] Spending limits setup deferred: ${limitErr.message}`);
    }

    // Register on OrchestraPolicy
    let policyTxHash: string | undefined;
    const policyAddress = process.env.ORCHESTRA_POLICY_ADDRESS;
    if (policyAddress) {
      const policyAbi = ['function registerSafe(address safeAddress, address agentWallet, uint256 spendingLimitUSD) external'];
      const agentWallet = new ethers.Wallet(agentKey, provider);
      const policy = new ethers.Contract(policyAddress, policyAbi, agentWallet);
      const tx = await policy.registerSafe(safeAddress, agentWalletAddress, spendingLimitUSD * 100);
      await tx.wait();
      policyTxHash = tx.hash;
      console.log(`[onboard] Policy registered: ${policyTxHash}`);
    }

    // Write to 0G Storage
    await write(`safe:${ledgerAddress.toLowerCase()}`, {
      safeAddress,
      agentWallet: agentWalletAddress,
      spendingLimitUSD,
      deployedAt: new Date().toISOString(),
    });

    await write("user:profile", {
      address: ledgerAddress,
      safeAddress,
      riskTolerance: "moderate",
      autoApproveLimit: spendingLimitUSD,
      preferredTokens: ["USDC", "WETH", "ETH"],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    console.log(`[onboard] New user onboarded — Safe: ${safeAddress}`);
    res.json({
      isNewUser: true,
      safeAddress,
      spendingLimitUSD,
      policyTxHash,
    });
  } catch (err: any) {
    console.error("[onboard] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/check-safe", async (req, res) => {
  const address = req.query.address as string;
  if (!address) {
    res.status(400).json({ error: "address query param required" });
    return;
  }
  const existing = await detectExistingSafe(address);
  if (existing) {
    const stored = await read(`safe:${address.toLowerCase()}`);
    res.json({ hasSafe: true, safeAddress: existing, spendingLimitUSD: (stored as any)?.spendingLimitUSD || 100 });
  } else {
    res.json({ hasSafe: false });
  }
});

app.get("/safe-balances", async (req, res) => {
  const address = req.query.address as string;
  if (!address) {
    res.status(400).json({ error: "address query param required" });
    return;
  }
  try {
    const ethBalance = await provider.getBalance(address);
    const erc20Abi = ["function balanceOf(address) view returns (uint256)"];
    const usdcContract = new ethers.Contract(USDC_SEPOLIA, erc20Abi, provider);
    const wethContract = new ethers.Contract(WETH_SEPOLIA, erc20Abi, provider);
    const [usdcRaw, wethRaw] = await Promise.all([
      usdcContract.balanceOf(address).catch(() => 0n),
      wethContract.balanceOf(address).catch(() => 0n),
    ]);
    res.json({
      eth: ethers.formatEther(ethBalance),
      usdc: ethers.formatUnits(usdcRaw, 6),
      weth: ethers.formatEther(wethRaw),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Step 1: Build unsigned tx for Ledger to sign (MultiSend of 3 setAllowance calls through Safe)
app.post("/prepare-limit-update", async (req, res) => {
  try {
    const { newLimitUSD, ledgerAddress } = req.body;
    if (!newLimitUSD || !ledgerAddress) {
      res.status(400).json({ error: "newLimitUSD and ledgerAddress required" });
      return;
    }

    const stored = await read(`safe:${ledgerAddress.toLowerCase()}`);
    if (!stored) {
      res.status(400).json({ error: "No Safe found. Complete onboarding first." });
      return;
    }
    const safeAddress = (stored as any).safeAddress;
    const agentAddr = getAgentAddress();

    const unsignedTx = buildLimitUpdateTx(safeAddress, ledgerAddress, agentAddr, newLimitUSD);

    console.log(`[prepare-limit-update] Built tx for $${newLimitUSD} limit (Safe: ${safeAddress})`);
    res.json({ unsignedTx });
  } catch (err: any) {
    console.error("[prepare-limit-update] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Step 2: After Ledger signs and tx is broadcast, update storage + OrchestraPolicy
app.post("/finalize-limit-update", async (req, res) => {
  try {
    const { newLimitUSD, ledgerAddress, txHash } = req.body;
    if (!newLimitUSD || !ledgerAddress) {
      res.status(400).json({ error: "newLimitUSD and ledgerAddress required" });
      return;
    }

    const stored = await read(`safe:${ledgerAddress.toLowerCase()}`);
    if (!stored) {
      res.status(400).json({ error: "No Safe found." });
      return;
    }

    // Update 0G Storage
    await write(`safe:${ledgerAddress.toLowerCase()}`, {
      ...(stored as any),
      spendingLimitUSD: newLimitUSD,
    });
    const profile = await read("user:profile");
    if (profile) {
      await write("user:profile", {
        ...(profile as any),
        autoApproveLimit: newLimitUSD,
        updatedAt: new Date().toISOString(),
      });
    }

    // Update OrchestraPolicy on-chain (agent wallet signs — it's just a registry write)
    const policyAddress = process.env.ORCHESTRA_POLICY_ADDRESS;
    if (policyAddress) {
      try {
        const agentKey = process.env.AGENT_PRIVATE_KEY!;
        const wallet = new ethers.Wallet(agentKey, provider);
        const policy = new ethers.Contract(policyAddress, [
          'function updateSpendingLimit(uint256 newLimitUSD) external',
        ], wallet);
        const policyTx = await policy.updateSpendingLimit(newLimitUSD * 100);
        await policyTx.wait();
        console.log(`[finalize-limit-update] OrchestraPolicy updated: ${policyTx.hash}`);
      } catch (policyErr: any) {
        console.warn(`[finalize-limit-update] OrchestraPolicy update failed (non-critical): ${policyErr.message}`);
      }
    }

    console.log(`[finalize-limit-update] Limit updated to $${newLimitUSD}, on-chain tx: ${txHash}`);
    res.json({ success: true });
  } catch (err: any) {
    console.error("[finalize-limit-update] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Health check ───
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    clients: bridge.clientCount,
    uptime: process.uptime(),
  });
});

// ─── Start ───
server.listen(PORT, () => {
  console.log(`\n  ⚡ SafeSwarm Ledger Bridge`);
  console.log(`  ─────────────────────────`);
  console.log(`  HTTP:  http://localhost:${PORT}`);
  console.log(`  WS:    ws://localhost:${PORT}/ws`);
  console.log(`  Mock:  curl -X POST http://localhost:${PORT}/mock-trade -H "Content-Type: application/json" -d '{"summary":"Swap 1 ETH → USDC"}'`);
  console.log();
});
