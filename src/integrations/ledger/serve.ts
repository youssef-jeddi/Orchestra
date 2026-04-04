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

// ─── Deterministic intent parser ───
// Catches simple swap intents without needing LLM. Returns null if it can't parse.
const TOKEN_MAP: Record<string, { address: string; decimals: number; symbol: string }> = {
  eth:  { address: WETH_SEPOLIA, decimals: 18, symbol: "WETH" },
  weth: { address: WETH_SEPOLIA, decimals: 18, symbol: "WETH" },
  usdc: { address: USDC_SEPOLIA, decimals: 6, symbol: "USDC" },
};

function parseSwapIntent(message: string): {
  tokenIn: string; tokenOut: string; amount: string; amountWei: string;
  symbolIn: string; symbolOut: string; decimalsIn: number;
} | null {
  // Match patterns like: "swap 0.01 ETH to USDC", "swap 100 USDC for ETH"
  const match = message.match(
    /swap\s+([\d.]+)\s+(\w+)\s+(?:to|for|into|→)\s+(\w+)/i
  );
  if (!match) return null;

  const [, amountStr, fromSymbol, toSymbol] = match;
  const from = TOKEN_MAP[fromSymbol.toLowerCase()];
  const to = TOKEN_MAP[toSymbol.toLowerCase()];
  if (!from || !to) return null;

  const amountWei = ethers.parseUnits(amountStr, from.decimals).toString();

  return {
    tokenIn: from.address,
    tokenOut: to.address,
    amount: amountStr,
    amountWei,
    symbolIn: from.symbol,
    symbolOut: to.symbol,
    decimalsIn: from.decimals,
  };
}

// ─── POST /intent ───
// Process a natural-language intent:
//   1. Try deterministic parser first (fast, reliable for simple swaps)
//   2. Fall back to AI agent pipeline (Planner → Gatekeeper) for complex intents
app.post("/intent", async (req, res) => {
  try {
    const { message, walletAddress } = req.body;

    if (!message) {
      res.status(400).json({ error: "message is required" });
      return;
    }

    console.log(`\n[intent] ═══════════════════════════════════════`);
    console.log(`[intent] "${message}"`);
    console.log(`[intent] wallet: ${walletAddress || "not provided"}`);

    // ── Step 0a: Fetch real on-chain balances ──
    if (walletAddress) {
      try {
        const ethBalance = await provider.getBalance(walletAddress);
        const ethFormatted = Number(ethers.formatEther(ethBalance));

        // ERC-20 balanceOf(address) for USDC and WETH on Sepolia
        const erc20Abi = ["function balanceOf(address) view returns (uint256)"];
        const usdcContract = new ethers.Contract(USDC_SEPOLIA, erc20Abi, provider);
        const wethContract = new ethers.Contract(WETH_SEPOLIA, erc20Abi, provider);

        const [usdcRaw, wethRaw] = await Promise.all([
          usdcContract.balanceOf(walletAddress).catch(() => 0n),
          wethContract.balanceOf(walletAddress).catch(() => 0n),
        ]);

        const usdcFormatted = Number(ethers.formatUnits(usdcRaw, 6));
        const wethFormatted = Number(ethers.formatEther(wethRaw));

        await write("portfolio:current", {
          eth: ethFormatted,
          weth: wethFormatted,
          usdc: usdcFormatted,
          updatedAt: new Date().toISOString(),
        });
        console.log(`[intent] Portfolio fetched: ${ethFormatted} ETH, ${wethFormatted} WETH, ${usdcFormatted} USDC`);
      } catch (err: any) {
        console.warn(`[intent] Failed to fetch on-chain balances: ${err.message}`);
      }
    }

    // ── Step 0b: Ensure user profile exists in storage ──
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

    // ── Step 1: Try deterministic parser ──
    const parsed = parseSwapIntent(message);

    let planSummary: string;
    let planSteps: any[];
    let totalEstimatedValueUsd: number;
    let plannerReasoning: string;
    let gatekeeperReasoning: string;
    let verdict: string;
    let riskScore: number;

    if (parsed) {
      console.log(`[intent] ✓ Deterministic parse succeeded`);
      console.log(`[intent]   ${parsed.amount} ${parsed.symbolIn} → ${parsed.symbolOut}`);
      console.log(`[intent]   tokenIn:  ${parsed.tokenIn}`);
      console.log(`[intent]   tokenOut: ${parsed.tokenOut}`);
      console.log(`[intent]   amountWei: ${parsed.amountWei}`);

      planSummary = `Swap ${parsed.amount} ${parsed.symbolIn} for ${parsed.symbolOut} on Uniswap`;
      planSteps = [{
        protocol: "uniswap",
        action: "swap",
        params: {
          tokenIn: parsed.tokenIn,
          tokenOut: parsed.tokenOut,
          amount: parsed.amount,
        },
        estimatedGasWei: "300000",
        order: 0,
      }];

      // Rough USD estimate (ETH ≈ $2000, USDC ≈ $1)
      const ethAmount = parsed.symbolIn === "WETH" ? Number(parsed.amount) : 0;
      totalEstimatedValueUsd = ethAmount > 0 ? ethAmount * 2000 : Number(parsed.amount);

      plannerReasoning = `Deterministic parser: swap ${parsed.amount} ${parsed.symbolIn} → ${parsed.symbolOut}`;
      gatekeeperReasoning = totalEstimatedValueUsd > 100
        ? `Value $${totalEstimatedValueUsd} exceeds auto-approve limit → NEEDS_APPROVAL`
        : `Value $${totalEstimatedValueUsd} within auto-approve limit, verified tokens → AUTO_EXECUTE`;
      verdict = totalEstimatedValueUsd > 100 ? "NEEDS_APPROVAL" : "AUTO_EXECUTE";
      riskScore = totalEstimatedValueUsd > 100 ? 70 : 10;
    } else {
      // ── Step 2: Fall back to AI agent pipeline ──
      console.log(`[intent] Deterministic parse failed, falling back to AI agents…`);

      await write("messages:latest", {
        message,
        walletAddress,
        timestamp: new Date().toISOString(),
      });

      console.log(`[intent] Running Planner…`);
      const plannerResult = await runPlanner(message);
      console.log(`[intent] Planner action: ${plannerResult.action}`);
      console.log(`[intent] Planner args: ${JSON.stringify(plannerResult.args)}`);
      console.log(`[intent] Planner reasoning: ${plannerResult.reasoning}`);

      const plans = (await readMany("plans")) as Record<string, unknown>[];
      const latestPlan = plans.sort((a, b) =>
        (b.createdAt as string).localeCompare(a.createdAt as string)
      )[0];

      if (!latestPlan) {
        console.log(`[intent] No plan written by Planner`);
        res.json({ status: "no_action", reasoning: plannerResult.reasoning });
        return;
      }

      console.log(`[intent] Plan written: ${JSON.stringify(latestPlan, null, 2)}`);

      console.log(`[intent] Running Gatekeeper…`);
      const gatekeeperResult = await runGatekeeper();
      console.log(`[intent] Gatekeeper action: ${gatekeeperResult.action}`);
      console.log(`[intent] Gatekeeper args: ${JSON.stringify(gatekeeperResult.args)}`);
      console.log(`[intent] Gatekeeper reasoning: ${gatekeeperResult.reasoning}`);

      const assessments = (await readMany("assessments")) as Record<string, unknown>[];
      const latestAssessment = assessments.sort((a, b) =>
        (b.assessedAt as string).localeCompare(a.assessedAt as string)
      )[0];

      console.log(`[intent] Assessment: ${JSON.stringify(latestAssessment, null, 2)}`);

      planSummary = latestPlan.summary as string;
      planSteps = (latestPlan.steps as any[]) || [];
      totalEstimatedValueUsd = (latestPlan.totalEstimatedValueUsd as number) || 0;
      plannerReasoning = plannerResult.reasoning;
      gatekeeperReasoning = gatekeeperResult.reasoning;
      verdict = (latestAssessment?.verdict as string) ?? "NEEDS_APPROVAL";
      riskScore = (latestAssessment?.riskScore as number) ?? 50;

      await write("messages:latest", { message: null, timestamp: null });
    }

    console.log(`[intent] ── Summary ──`);
    console.log(`[intent] Plan: ${planSummary}`);
    console.log(`[intent] Steps: ${planSteps.length}`);
    console.log(`[intent] Verdict: ${verdict} (risk: ${riskScore})`);

    // ── Step 3: Fetch real Uniswap quote ──
    let quoteData = null;
    const swapStep = planSteps.find((s: any) =>
      s.action === "swap" || s.protocol === "uniswap" || s.protocol === "Uniswap"
    );

    if (swapStep && walletAddress) {
      const params = swapStep.params || {};
      const tokenIn = params.tokenIn || params.from || (parsed?.tokenIn ?? WETH_SEPOLIA);
      const tokenOut = params.tokenOut || params.to || (parsed?.tokenOut ?? USDC_SEPOLIA);
      const rawAmount = params.amount || params.value || parsed?.amount || "0";

      // Convert to wei using correct decimals per token
      let amountWei: string;
      if (parsed) {
        amountWei = parsed.amountWei;
      } else if (!String(rawAmount).match(/^\d{10,}$/)) {
        amountWei = toTokenWei(String(rawAmount), tokenIn).toString();
      } else {
        amountWei = String(rawAmount);
      }

      console.log(`[intent] ── Quote Request ──`);
      console.log(`[intent]   tokenIn:   ${tokenIn}`);
      console.log(`[intent]   tokenOut:  ${tokenOut}`);
      console.log(`[intent]   amountWei: ${amountWei}`);
      console.log(`[intent]   swapper:   ${walletAddress}`);

      try {
        const approvalTx = await checkApproval({
          walletAddress,
          token: tokenIn,
          tokenOut: tokenOut,
          amount: amountWei,
        });
        console.log(`[intent]   approval needed: ${!!approvalTx}`);

        const quoteResult = await fetchQuoteWithRouting(
          { swapper: walletAddress, tokenIn, tokenOut, amount: amountWei },
          "autonomous"
        );

        console.log(`[intent] ── Quote Response ──`);
        console.log(`[intent]   routing:      ${quoteResult.routing}`);
        console.log(`[intent]   mevProtected: ${quoteResult.isMevProtected}`);
        console.log(`[intent]   permitData:   ${quoteResult.permitData ? "yes" : "no"}`);
        console.log(`[intent]   quote keys:   ${Object.keys(quoteResult.quote).join(", ")}`);

        quoteData = {
          tradeId: crypto.randomUUID(),
          quote: quoteResult.quote,
          permitData: quoteResult.permitData,
          routing: quoteResult.routing,
          isMevProtected: quoteResult.isMevProtected,
          isGasless: quoteResult.isGasless,
          riskLevel: "autonomous",
          approvalNeeded: !!approvalTx,
          approvalTx,
          tokenIn,
          tokenOut,
          amount: amountWei,
        };
      } catch (err: any) {
        console.error(`[intent] Quote error: ${err.message}`);
      }
    } else {
      console.log(`[intent] No swap step found or no wallet — skipping quote`);
      if (planSteps.length > 0) {
        console.log(`[intent] Steps: ${JSON.stringify(planSteps, null, 2)}`);
      }
    }

    console.log(`[intent] ═══════════════════════════════════════\n`);

    res.json({
      status: "ok",
      plan: {
        id: quoteData?.tradeId || crypto.randomUUID(),
        summary: planSummary,
        steps: planSteps,
        totalEstimatedValueUsd,
      },
      assessment: {
        verdict,
        riskScore,
        reasons: [gatekeeperReasoning],
        requiresLedger: verdict === "NEEDS_APPROVAL",
      },
      quoteData,
      agentReasoning: {
        planner: plannerReasoning,
        gatekeeper: gatekeeperReasoning,
      },
    });
  } catch (err: any) {
    console.error("[intent] Pipeline error:", err);
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
