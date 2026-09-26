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
import { write, read, append } from "../zero-g/storage";
import { setComputeProvider, getComputeProvider } from "../zero-g/compute";
import { deploySafe } from "../safe/deploy";
import { detectExistingSafe } from "../safe/detect";
import { setInitialSpendingLimits, updateSpendingLimit, buildLimitUpdateTx } from "../safe/spendingLimit";
import { getAgentAddress } from "../safe/agentWallet";
import { executePlan } from "../../executor";
import {
  computeHabitProfile,
  refreshPrices,
  getPrices,
  type PolicyProfile,
  type ActivityRecord,
} from "../../policy";
import { getPolicyProfile, getRecentActivity, recordActivity, _resetPolicyStoreCache } from "../../policy/store";
import { getAdapter, type Balances } from "../../executor/adapters";
import { interpretIntent, assessAction } from "../../intent/pipeline";
import { sanitizeHistory } from "../../intent/planner";
import { fetchBalances, resolveEnsName } from "../../intent/context";
import { makeSepoliaProvider, withTimeout } from "../../utils/rpc";
import {
  registrationOptions,
  verifyRegistration,
  authenticationOptions,
  verifyAuthentication,
  hasPasskey,
} from "../passkey";

const provider = makeSepoliaProvider();
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
// message (+ recent conversation) → one planner LLM call → server-side
// resolution → deterministic policy verdict → adapter. Storage and chain
// lookups start in parallel with the LLM call and are time-boxed, so light
// questions (price, help, clarifications) never wait on the network.
app.post("/intent", async (req, res) => {
  const started = Date.now();
  try {
    const { message, walletAddress, history } = req.body || {};
    if (typeof message !== "string" || !message.trim()) {
      res.status(400).json({ error: "message is required" });
      return;
    }
    if (message.length > 1000) {
      res.status(400).json({ error: "message is too long (max 1000 characters)" });
      return;
    }
    const wallet = typeof walletAddress === "string" && ethers.isAddress(walletAddress) ? walletAddress : undefined;

    console.log(`\n[intent] "${message}" (wallet: ${wallet || "none"})`);
    refreshPrices().catch(() => {});

    // Storage first, then the deterministic on-chain address (survives restarts
    // when storage is in-memory, and re-syncs storage when found).
    const safeP: Promise<string | null> = wallet
      ? withTimeout(detectExistingSafe(wallet), 5_000, null)
      : Promise.resolve(null);
    const balancesP: Promise<Balances | null> = wallet
      ? safeP.then((safe) => fetchBalances(provider, safe || wallet))
      : Promise.resolve(null);
    const profileP = withTimeout(getPolicyProfile(), 2_000, {} as PolicyProfile);
    const activityP: Promise<ActivityRecord[] | undefined> = wallet
      ? withTimeout(getRecentActivity(wallet), 2_000, [] as ActivityRecord[])
      : Promise.resolve(undefined);

    const { outcome, planner } = await interpretIntent(message.trim(), sanitizeHistory(history), {
      connected: !!wallet,
      getBalances: () => balancesP,
      resolveEns: resolveEnsName,
    });
    const timing = () => ({ totalMs: Date.now() - started, plannerMs: planner.latencyMs, model: planner.model });
    console.log(`[intent] planner ${planner.latencyMs}ms (${planner.model}, ${planner.attempts} call(s)) → ${outcome.kind}`);

    // ── Conversational outcomes: answered straight from the planner ──
    if (outcome.kind === "reply") {
      res.json({ status: "reply", intentType: "chat", reply: outcome.text, reasoning: outcome.text, timing: timing() });
      return;
    }
    if (outcome.kind === "clarify") {
      res.json({ status: "needs_clarification", intentType: "clarify", question: outcome.question, reasoning: outcome.question, timing: timing() });
      return;
    }
    if (outcome.kind === "unsupported") {
      res.json({ status: "unsupported", intentType: "unsupported", reason: outcome.reason, reasoning: outcome.reason, timing: timing() });
      return;
    }

    const safeAddress = await safeP;
    const balanceAddress = safeAddress || wallet || null;
    const infoAssessment = { verdict: "INFO", riskScore: 0, reasons: ["Read-only query — no funds move."], requiresLedger: false, triggered: [], approvalMethod: "none" };

    // ── Read-only: balance / price ──
    if (outcome.kind === "read") {
      const wantsBalance = outcome.steps.some((s) => s.action === "balance");
      const balances = wantsBalance ? await balancesP : null;
      const prices = outcome.steps.filter((s) => s.action === "price").map((s) => s.price!);
      const summary = outcome.steps
        .map((s) => (s.action === "balance" ? describeBalances(balances, s.token) : s.summary))
        .join(" · ");
      res.json({
        status: "ok",
        intentType: wantsBalance ? "balance" : "price",
        autoExecuted: false,
        safeAddress,
        plan: { id: crypto.randomUUID(), summary, steps: [], totalEstimatedValueUsd: 0 },
        assessment: infoAssessment,
        ...(wantsBalance ? { balances } : {}),
        ...(prices.length ? { prices } : {}),
        agentReasoning: { planner: summary, gatekeeper: infoAssessment.reasons[0] },
        timing: timing(),
      });
      return;
    }

    // ── Value-bearing action: deterministic verdict ──
    const action = outcome.action;
    const intentType = action.intentType;
    const [profile, activity] = await Promise.all([profileP, activityP]);
    const decision = assessAction(action, { profile, history: activity });
    const { verdict, riskScore } = decision;
    if (decision.typicalMaxUsd != null) console.log(`[intent] Habit baseline: typicalMaxUsd=$${decision.typicalMaxUsd}`);
    console.log(`[intent] ${action.summary} → ${verdict} (risk ${riskScore}) — ${decision.reason}`);

    append("plans", { ...action, flagId: "user-message", createdAt: new Date().toISOString() }).catch(() => {});
    append("assessments", {
      planId: action.id, verdict, riskScore, reasons: [decision.reason],
      requiresLedger: decision.requiresLedger, assessedAt: new Date().toISOString(),
    }).catch(() => {});

    const assessment = {
      verdict,
      riskScore,
      reasons: [decision.reason],
      requiresLedger: decision.approvalMethod === "ledger",
      triggered: decision.triggered,
      approvalMethod: decision.approvalMethod,
    };
    const agentReasoning = { planner: `Understood: ${action.summary}`, gatekeeper: decision.reason };
    const plan = { id: action.id, summary: action.summary, steps: action.steps, totalEstimatedValueUsd: action.valueUsd };

    const adapter = getAdapter(intentType);
    // A blocked plan must not come back with a signable transaction.
    if (verdict === "BLOCKED" || !adapter) {
      res.json({ status: "ok", intentType, autoExecuted: false, safeAddress, plan, assessment, agentReasoning, timing: timing() });
      return;
    }

    const ctx = {
      walletAddress: wallet, safeAddress, balanceAddress, provider,
      params: action.params, planSummary: action.summary, planSteps: action.steps,
      totalEstimatedValueUsd: action.valueUsd, balances: null,
    };
    const result = await adapter.build(ctx);

    // Auto-execute when policy allows and the adapter supports it.
    if (adapter.execute && verdict === "AUTO_EXECUTE" && safeAddress) {
      try {
        const exec = await adapter.execute(ctx, result);
        if (exec) {
          console.log(`[intent] ✓ ${intentType} auto-executed: ${exec.txHash}`);
          // Only value that actually moved counts toward the daily limit / velocity / habit rules.
          if (wallet) {
            recordActivity(wallet, {
              valueUsd: action.valueUsd,
              at: new Date().toISOString(),
              to: action.params.to,
              token: action.params.tokenIn || action.params.token,
            }).catch(() => {});
          }
          res.json({
            status: "ok", intentType, autoExecuted: true,
            txHash: exec.txHash, explorerUrl: exec.explorerUrl,
            plan: { ...plan, id: exec.tradeId },
            assessment: { ...assessment, requiresLedger: false },
            agentReasoning, timing: timing(),
          });
          return;
        }
      } catch (err: any) {
        console.error(`[intent] ${intentType} auto-execute failed: ${err.message}`);
        res.status(502).json({
          error: err.message,
          intentType,
          autoExecuted: false,
          plan,
          assessment,
        });
        return;
      }
    }

    res.json({
      status: "ok",
      intentType,
      autoExecuted: false,
      safeAddress,
      plan: { ...plan, ...(result.plan ? { id: result.plan.id } : {}) },
      assessment,
      ...(result.payload || {}),
      agentReasoning,
      timing: timing(),
    });
  } catch (err: any) {
    console.error("[intent] Pipeline error:", err);
    res.status(500).json({ error: err.message });
  }
});

function describeBalances(b: Balances | null, token?: string): string {
  if (!b) return "I couldn't read your balance right now (the RPC endpoint didn't answer).";
  if (token === "ETH") return `You have ${b.eth.toFixed(4)} ETH`;
  if (token === "WETH") return `You have ${b.weth.toFixed(4)} WETH`;
  if (token === "USDC") return `You have ${b.usdc.toFixed(2)} USDC`;
  return `Portfolio: ${b.eth.toFixed(4)} ETH, ${b.weth.toFixed(4)} WETH, ${b.usdc.toFixed(2)} USDC (~$${b.totalUsd.toFixed(2)})`;
}

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

    // Merge: keep any existing guardrail policy (user:profile.policy) instead of wiping it.
    const existingProfile = ((await read("user:profile").catch(() => null)) as any) || {};
    await write("user:profile", {
      ...existingProfile,
      address: ledgerAddress,
      safeAddress,
      riskTolerance: existingProfile.riskTolerance || "moderate",
      autoApproveLimit: spendingLimitUSD,
      preferredTokens: existingProfile.preferredTokens || ["USDC", "WETH", "ETH"],
      createdAt: existingProfile.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    _resetPolicyStoreCache();

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
