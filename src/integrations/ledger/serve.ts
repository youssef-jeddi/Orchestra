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
import { buildActionPlan } from "../../agents/planner/actions/writeActionPlan";
import { write, read, append } from "../zero-g/storage";
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
import {
  detectIntentType,
  resolveDailyLimit,
  computePlanValueUsd,
  decide,
  computeHabitProfile,
  refreshPrices,
  getPrices,
  type PolicyProfile,
  type ActivityRecord,
} from "../../policy";
import { getPolicyProfile, getRecentActivity, recordActivity, _resetPolicyStoreCache } from "../../policy/store";
import { getAdapter } from "../../executor/adapters";
import {
  registrationOptions,
  verifyRegistration,
  authenticationOptions,
  verifyAuthentication,
  hasPasskey,
} from "../passkey";

const SEPOLIA_RPC = process.env.SEPOLIA_RPC_URL || "https://eth-sepolia.g.alchemy.com/v2/demo";
const provider = new ethers.JsonRpcProvider(SEPOLIA_RPC);
const PORT = Number(process.env.PORT) || Number(process.env.LEDGER_BRIDGE_PORT) || 3001;

const app = express();
app.use(express.json());

// CORS — allow cross-origin requests from Vercel frontend
app.use((_req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (_req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
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
// Token metadata, USD estimation, intent classification and the deterministic
// safety net now live in the pure, tested policy module (src/policy).

// ─── POST /intent ───
// ALL intents go through AI pipeline: Planner → Gatekeeper → dispatch by intent type.
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

    // Keep the price cache warm (self-throttled; off the critical path).
    refreshPrices().catch(() => {});

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

        // Fire-and-forget — don't let 0G write failure block the intent pipeline
        write("portfolio:current", {
          eth: ethFormatted,
          weth: wethFormatted,
          usdc: usdcFormatted,
          totalUsd,
          source: safeAddress ? "safe" : "eoa",
          address: balanceAddress,
          updatedAt: new Date().toISOString(),
        }).catch((e: any) => console.warn(`[intent] Portfolio write failed (non-critical): ${e.message}`));
        console.log(`[intent] Portfolio (${safeAddress ? 'Safe' : 'EOA'}): ${ethFormatted} ETH, ${wethFormatted} WETH, ${usdcFormatted} USDC ($${totalUsd.toFixed(2)})`);
      } catch (err: any) {
        console.warn(`[intent] Failed to fetch on-chain balances: ${err.message}`);
      }
    }

    // ── Step 0c: Ensure user profile exists in storage ──
    try {
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
    } catch (profileErr: any) {
      console.warn(`[intent] User profile read/write failed (non-critical): ${profileErr.message}`);
    }

    // ═══════════════════════════════════════════
    // ── Step 1: Run AI Planner ──
    // ═══════════════════════════════════════════
    try { await write("messages:latest", { message, walletAddress, timestamp: new Date().toISOString() }); } catch {}

    console.log(`[intent] Running Planner…`);
    const plannerResult = await runPlanner(message);
    console.log(`[intent] Planner action: ${plannerResult.action}`);
    console.log(`[intent] Planner reasoning: ${plannerResult.reasoning}`);

    // Reconstruct the plan in-process from the Planner's return value — no 0G
    // read-back. This removes a network round-trip and a concurrency race where
    // parallel intents could read each other's most-recent plan.
    let latestPlan: Record<string, unknown> | undefined;
    if (plannerResult.action === "writeActionPlan") {
      latestPlan = buildActionPlan(plannerResult.args) as unknown as Record<string, unknown>;
    }

    if (!latestPlan) {
      try { await write("messages:latest", { message: null, timestamp: null }); } catch {}
      console.log(`[intent] No plan written by Planner`);
      res.json({ status: "no_action", intentType: "unknown", reasoning: plannerResult.reasoning });
      return;
    }

    console.log(`[intent] Plan: ${JSON.stringify(latestPlan, null, 2)}`);

    // ═══════════════════════════════════════════
    // ── Step 2: Deterministic Gatekeeper (no second LLM call) ──
    // ═══════════════════════════════════════════
    // The risk verdict is now computed by the pure `decide` policy engine — the
    // Planner LLM stays the single interpretation call, the verdict is code.
    // This removes ~1 full LLM round-trip and the associated 0G read/writes from
    // the hot path, and makes the verdict deterministic + explainable.

    // Clear the consumed user message (fire-and-forget — not on the critical path).
    write("messages:latest", { message: null, timestamp: null }).catch(() => {});

    const planSteps = (latestPlan.steps as any[]) || [];
    const intentType = detectIntentType(planSteps);
    const step0 = planSteps[0] || {};
    const params = step0.params || {};
    const planSummary = latestPlan.summary as string;

    // Recompute USD value server-side — never trust the AI's estimate.
    const totalEstimatedValueUsd = computePlanValueUsd(
      intentType,
      params,
      (latestPlan.totalEstimatedValueUsd as number) || 0
    );

    // Load the user's policy (cached) + recent activity. The single spending
    // control is the DAILY limit — resolved from the stored policy with a default.
    let profile: PolicyProfile | undefined;
    let history: ActivityRecord[] | undefined;
    try { profile = await getPolicyProfile(); } catch {}
    const dailyLimitUsd = resolveDailyLimit(profile?.dailyLimitUsd);

    if (walletAddress) {
      try { history = await getRecentActivity(walletAddress); } catch {}

      // Learn the habit baseline from activity when not explicitly configured.
      // Fail-closed: the anomaly rule only escalates, so a derived baseline is safe.
      if (profile && history && profile.typicalMaxUsd == null) {
        const habit = computeHabitProfile(history);
        if (habit.typicalMaxUsd != null) {
          profile = { ...profile, typicalMaxUsd: habit.typicalMaxUsd };
          console.log(`[intent] Habit baseline: typicalMaxUsd=$${habit.typicalMaxUsd} (n=${habit.sampleSize})`);
        }
      }
    }

    // Authoritative deterministic decision.
    const decision = decide({
      intentType,
      valueUsd: totalEstimatedValueUsd,
      dailyLimitUsd,
      hardwareThresholdUsd: profile?.hardwareThresholdUsd,
      plan: { summary: planSummary, steps: planSteps },
      profile,
      history,
    });
    const verdict = decision.verdict;
    const riskScore = decision.riskScore;
    const plannerReasoning = plannerResult.reasoning;
    const gatekeeperReasoning = decision.reason;

    // Record auto-approved value-bearing actions so velocity/habit rules can see
    // them (write-through cache + async 0G). Off the hot path.
    if (
      walletAddress &&
      verdict === "AUTO_EXECUTE" &&
      (intentType === "swap" || intentType === "send" || intentType === "add_liquidity")
    ) {
      recordActivity(walletAddress, {
        valueUsd: totalEstimatedValueUsd,
        at: new Date().toISOString(),
        to: params.to,
        token: params.tokenIn || params.token,
      }).catch(() => {});
    }

    // Persist the assessment to 0G for audit/history — off the hot path.
    append("assessments", {
      planId: (latestPlan.id as string) || null,
      verdict,
      riskScore,
      reasons: [gatekeeperReasoning],
      requiresLedger: decision.requiresLedger,
      assessedAt: new Date().toISOString(),
    }).catch(() => {});

    console.log(`[intent] Intent type: ${intentType}`);
    console.log(`[intent] USD value (server): $${totalEstimatedValueUsd}`);
    console.log(`[intent] Verdict: ${verdict} (deterministic, risk: ${riskScore}) — ${gatekeeperReasoning}`);

    const baseAssessment = {
      verdict,
      riskScore,
      reasons: [gatekeeperReasoning],
      requiresLedger: decision.approvalMethod === "ledger",
      triggered: decision.triggered,
      approvalMethod: decision.approvalMethod,
    };
    const agentReasoning = { planner: plannerReasoning, gatekeeper: gatekeeperReasoning };

    // ═══════════════════════════════════════════
    // ── Adapter dispatch (balance / send / add_liquidity / swap) ──
    // ═══════════════════════════════════════════
    // Every value-bearing intent is a self-contained IntentAdapter. An adapter
    // that supports server-side auto-execution exposes `execute()`, which runs
    // only when the deterministic verdict is AUTO_EXECUTE and a Safe exists.
    const adapter = getAdapter(intentType);
    if (adapter) {
      if (intentType === "balance" && !walletAddress) {
        res.status(400).json({ error: "Connect wallet first" });
        return;
      }
      const ctx = {
        walletAddress, safeAddress, balanceAddress, provider,
        params, planSummary, planSteps, totalEstimatedValueUsd, balances,
      };
      const result = await adapter.build(ctx);

      // Auto-execute when policy allows and the adapter supports it.
      if (adapter.execute && verdict === "AUTO_EXECUTE" && safeAddress) {
        try {
          const exec = await adapter.execute(ctx, result);
          if (exec) {
            console.log(`[intent] ✓ ${intentType} auto-executed: ${exec.txHash}`);
            res.json({
              status: "ok",
              intentType,
              autoExecuted: true,
              txHash: exec.txHash,
              explorerUrl: exec.explorerUrl,
              plan: { id: exec.tradeId, summary: planSummary, steps: planSteps, totalEstimatedValueUsd },
              assessment: { verdict, riskScore, reasons: [gatekeeperReasoning], requiresLedger: false, triggered: decision.triggered },
              agentReasoning,
            });
            return;
          }
        } catch (err: any) {
          console.error(`[intent] ${intentType} auto-execute failed: ${err.message}`);
          console.error(err.stack);
          // Fall through to the manual flow below.
        }
      }

      console.log(`[intent] ✓ ${intentType} via adapter`);
      res.json({
        status: "ok",
        intentType,
        autoExecuted: false,
        safeAddress,
        plan: result.plan ?? { id: crypto.randomUUID(), summary: planSummary, steps: planSteps, totalEstimatedValueUsd },
        assessment: result.assessment ?? baseAssessment,
        ...(result.payload || {}),
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

// ─── Passkey (WebAuthn) — medium-tier approval ───
app.get("/passkey/status", async (req, res) => {
  try {
    const wallet = String(req.query.wallet || "");
    if (!wallet) { res.status(400).json({ error: "wallet query param required" }); return; }
    res.json({ registered: await hasPasskey(wallet) });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

app.post("/passkey/register-options", async (req, res) => {
  try {
    const { walletAddress } = req.body;
    if (!walletAddress) { res.status(400).json({ error: "walletAddress required" }); return; }
    res.json(await registrationOptions(walletAddress));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

app.post("/passkey/register", async (req, res) => {
  try {
    const { walletAddress, response } = req.body;
    if (!walletAddress || !response) { res.status(400).json({ error: "walletAddress and response required" }); return; }
    await verifyRegistration(walletAddress, response);
    console.log(`[passkey] registered for ${walletAddress}`);
    res.json({ status: "ok", registered: true });
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

app.post("/passkey/auth-options", async (req, res) => {
  try {
    const { walletAddress } = req.body;
    if (!walletAddress) { res.status(400).json({ error: "walletAddress required" }); return; }
    res.json(await authenticationOptions(walletAddress));
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

// Verify the passkey assertion, then execute the approved action via the Safe.
app.post("/passkey/approve", async (req, res) => {
  try {
    const { walletAddress, response, quoteData, sendData } = req.body;
    if (!walletAddress || !response) { res.status(400).json({ error: "walletAddress and response required" }); return; }

    const ok = await verifyAuthentication(walletAddress, response);
    if (!ok) { res.status(401).json({ error: "Passkey verification failed" }); return; }
    console.log(`[passkey] verified for ${walletAddress} — executing via Safe`);

    const safeData = (await read(`safe:${walletAddress.toLowerCase()}`)) as any;
    const safeAddress = safeData?.safeAddress;
    if (!safeAddress) { res.status(400).json({ error: "No Safe deployed — passkey execution requires a Safe" }); return; }

    if (quoteData) {
      const swap = getAdapter("swap");
      if (!swap?.execute) throw new Error("swap adapter unavailable");
      const ctx = {
        walletAddress, safeAddress, balanceAddress: safeAddress, provider,
        params: {}, planSummary: "", planSteps: [], totalEstimatedValueUsd: 0, balances: null,
      };
      const exec = await swap.execute(ctx, { payload: { quoteData } });
      if (!exec) throw new Error("execution produced no result");
      res.json({ status: "ok", ...exec });
      return;
    }

    if (sendData) {
      const agentKey = process.env.AGENT_PRIVATE_KEY;
      if (!agentKey) throw new Error("AGENT_PRIVATE_KEY not set");
      const { executeBatchViaSafe } = await import("../safe/transaction");
      const tx = sendData.unsignedTx;
      const value = typeof tx.value === "string" && tx.value.startsWith("0x") ? BigInt(tx.value).toString() : (tx.value || "0");
      const txHash = await executeBatchViaSafe(safeAddress, agentKey, [{ to: tx.to, value, data: tx.data || "0x" }], "150000");
      res.json({ status: "ok", txHash, explorerUrl: `https://sepolia.etherscan.io/tx/${txHash}` });
      return;
    }

    res.status(400).json({ error: "Nothing to execute — provide quoteData or sendData" });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── Live prices (cached) ───
app.get("/prices", async (_req, res) => {
  await refreshPrices().catch(() => {});
  res.json({ prices: getPrices() });
});

// ─── Policy config ───
// Read/merge the user's deterministic policy (user:profile.policy in 0G).
// Fields: verifiedTokens, knownAddresses, dailyLimitUsd, maxAutoTxPerDay, typicalMaxUsd.
app.get("/policy", async (_req, res) => {
  try {
    const p = (await read("user:profile")) as any;
    res.json({ policy: (p && p.policy) || {} });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// The habit profile the engine has learned from recorded activity.
app.get("/habit", async (req, res) => {
  try {
    const wallet = String(req.query.wallet || "");
    if (!wallet) {
      res.status(400).json({ error: "wallet query param required" });
      return;
    }
    const history = await getRecentActivity(wallet);
    res.json({ wallet, ...computeHabitProfile(history) });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/policy", async (req, res) => {
  try {
    const patch = req.body?.policy;
    if (!patch || typeof patch !== "object") {
      res.status(400).json({ error: "body must be { policy: { ... } }" });
      return;
    }
    const existing = ((await read("user:profile")) as any) || {};
    // Merge; a null value clears that field (lets you disable a rule).
    const mergedPolicy: Record<string, unknown> = { ...(existing.policy || {}) };
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) delete mergedPolicy[k];
      else mergedPolicy[k] = v;
    }
    const updated = {
      ...existing,
      policy: mergedPolicy,
      updatedAt: new Date().toISOString(),
    };
    await write("user:profile", updated);
    _resetPolicyStoreCache(); // pick up the new policy immediately
    console.log(`[policy] Updated: ${JSON.stringify(updated.policy)}`);
    res.json({ status: "ok", policy: updated.policy });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
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
server.listen(PORT, "0.0.0.0", () => {
  const addr = server.address();
  console.log(`\n  ⚡ SafeSwarm Ledger Bridge`);
  console.log(`  ─────────────────────────`);
  console.log(`  Bound:  ${JSON.stringify(addr)}`);
  console.log(`  HTTP:  http://0.0.0.0:${PORT}`);
  console.log(`  WS:    ws://0.0.0.0:${PORT}/ws`);
  console.log(`  Mock:  curl -X POST http://localhost:${PORT}/mock-trade -H "Content-Type: application/json" -d '{"summary":"Swap 1 ETH → USDC"}'`);
  console.log();
  // Warm the price cache at startup.
  refreshPrices().catch(() => {});
});

server.on("error", (err) => {
  console.error("Server error:", err);
});
