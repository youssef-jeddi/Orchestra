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
import { limitTxProblem } from "../safe/verifyLimitTx";
import { readPositions, type Position } from "../uniswap/liquidity";
import { tokenByAddress } from "../../intent/tokens";
import { executePlan } from "../../executor";
import {
  computeHabitProfile,
  refreshPrices,
  getPrices,
  type PolicyProfile,
  type ActivityRecord,
} from "../../policy";
import { getPolicyProfile, getRecentActivity, recordActivity, readUserProfile, writeUserProfile } from "../../policy/store";
import { loginRequest, login, requireSession, sessionWallet, AuthError } from "../../auth";
import { privyLogin } from "../../auth/privy";
import { getAdapter, type Balances } from "../../executor/adapters";
import { interpretIntent, assessAction } from "../../intent/pipeline";
import { sanitizeHistory } from "../../intent/planner";
import { fetchBalances, resolveEnsName } from "../../intent/context";
import { makeSepoliaProvider, withTimeout } from "../../utils/rpc";
import {
  createApproval,
  requirePending,
  challengeBytes,
  claim,
  settle,
  getApproval,
  approvalView,
  reject,
  issueReviewToken,
  approvalForReview,
  ApprovalError,
  type PendingApproval,
} from "../../approvals";
import { describeApproval, describeOutcome, reviewOf } from "../../approvals/describe";
import {
  telegramEnabled,
  getLink,
  linkRequest,
  confirmLink,
  sendApprovalMessage,
  settleApprovalMessage,
  sendLinkMessage,
  sendText,
  startTelegramBot,
  type DecisionHandler,
} from "../telegram";
import {
  registrationOptions,
  verifyRegistration,
  authenticationOptions,
  verifyAuthentication,
  hasPasskey,
  hasPhonePasskey,
  phoneRp,
  browserRp,
  rpForOrigin,
  type RelyingParty,
} from "../passkey";
import { createSetupToken, getSetup, consumeSetup } from "../passkey/phoneSetup";

const provider = makeSepoliaProvider();
const PORT = Number(process.env.PORT) || Number(process.env.LEDGER_BRIDGE_PORT) || 3001;

const app = express();
app.use(express.json());

// CORS — allow cross-origin requests from Vercel frontend
app.use((_req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
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
    // The wallet comes from the session, never the body: anything that reads or
    // moves a wallet's funds needs proof of ownership. Without a session the
    // request is anonymous (prices, help, questions) and nothing can execute.
    const session = sessionWallet(req);
    if (walletAddress != null && walletAddress !== "") {
      if (!session) { res.status(401).json({ error: "Sign in with your wallet first.", code: "session_required" }); return; }
      if (String(walletAddress).toLowerCase() !== session) {
        res.status(401).json({ error: "Your session is for another wallet. Sign in again.", code: "session_required" });
        return;
      }
    }
    const wallet = session ? ethers.getAddress(session) : undefined;

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
    const profileP = withTimeout(getPolicyProfile(wallet), 2_000, {} as PolicyProfile);
    const activityP: Promise<ActivityRecord[] | undefined> = wallet
      ? withTimeout(getRecentActivity(wallet), 2_000, [] as ActivityRecord[])
      : Promise.resolve(undefined);

    // The wallet's own balance only matters for deposits into the Safe — fetch it on demand.
    let walletBalancesP: Promise<Balances | null> | null = null;
    let positionsP: Promise<Position[] | null> | null = null;
    const { outcome, planner } = await interpretIntent(message.trim(), sanitizeHistory(history), {
      connected: !!wallet,
      getBalances: () => balancesP,
      getWalletBalances: () => (walletBalancesP ??= wallet ? fetchBalances(provider, wallet) : Promise.resolve(null)),
      // The Safe's liquidity positions, only read when a message asks about them.
      getPositions: () => (positionsP ??= safeP.then((safe) => safe
        ? withTimeout(readPositions(provider, safe, tokenByAddress).catch(() => null), 10_000, null)
        : ([] as Position[]))),
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

    // ── Read-only: balance / price / positions / address ──
    if (outcome.kind === "read") {
      const wantsBalance = outcome.steps.some((s) => s.action === "balance");
      const balances = wantsBalance ? await balancesP : null;
      const prices = outcome.steps.filter((s) => s.action === "price").map((s) => s.price!);
      const summary = outcome.steps
        .map((s) => (s.action === "balance" ? describeBalances(balances, s.token)
          : s.action === "address" ? describeAddresses(wallet!, safeAddress)
          : s.summary))
        .join(" · ");
      const has = (action: string) => outcome.steps.some((s) => s.action === action);
      res.json({
        status: "ok",
        intentType: wantsBalance ? "balance" : has("positions") ? "positions" : has("address") ? "address" : "price",
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

    // The adapter can refine the summary (e.g. the quoted swap output) — show that.
    if (result.plan?.summary && result.plan.summary !== plan.summary) {
      plan.summary = result.plan.summary;
      agentReasoning.planner = `Understood: ${result.plan.summary}`;
    }

    // The adapter refused (e.g. the quote is far below market): nothing to sign or execute.
    if (result.refusal) {
      console.log(`[intent] ${intentType} refused by adapter: ${result.refusal}`);
      res.json({
        status: "unsupported", intentType, reason: result.refusal, reasoning: result.refusal,
        plan, assessment: { ...assessment, verdict: "BLOCKED", requiresLedger: false, approvalMethod: "none" },
        timing: timing(),
      });
      return;
    }

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

    // An agent-executed action awaiting approval: hold its exact payload server-side.
    // Approvals (passkey, …) then execute that record, never a client-sent payload.
    let approval: PendingApproval | null = null;
    const execution = approvalExecution(intentType, result.payload);
    if (verdict === "NEEDS_APPROVAL" && adapter.execute && safeAddress && wallet && execution) {
      approval = createApproval({
        wallet, safeAddress, intentType: intentType as PendingApproval["intentType"],
        summary: plan.summary, valueUsd: action.valueUsd,
        reason: decision.reason, triggered: decision.triggered, execution,
      });
      console.log(`[approval] ${approval.id} pending — ${plan.summary} (hash ${approval.hash.slice(0, 18)}…)`);

      // A linked Telegram chat becomes the only way to approve it: the phone shows
      // what will actually execute, decoded from the stored payload.
      const link = telegramEnabled() ? await getLink(wallet) : null;
      if (link) {
        try {
          // With a phone passkey the chat only carries the review link: approving
          // takes the review page + the phone's passkey, bound to the payload hash.
          const rp = phoneRp();
          const phonePasskey = !!rp && (await hasPhonePasskey(wallet));
          let reviewUrl: string | undefined;
          if (phonePasskey) {
            const t = issueReviewToken(approval);
            reviewUrl = `${rp!.origin}/phone/approve/${approval.id}?t=${encodeURIComponent(t)}`;
          }
          const messageId = await sendApprovalMessage(link.chatId, approval.id, describeApproval(approval, { phonePasskey }), reviewUrl);
          approval.channel = "telegram";
          approval.factor = phonePasskey ? "phone-passkey" : "telegram-button";
          approval.telegram = { chatId: link.chatId, messageId };
          console.log(`[approval] ${approval.id} sent to Telegram chat ${link.chatId} (${approval.factor})`);
        } catch (err: any) {
          // Fail closed: never fall back to a weaker factor because the phone was unreachable.
          settle(approval, { error: `Telegram delivery failed: ${err.message}` });
          const reason = "I couldn't deliver the approval to your Telegram, so nothing will execute. Try again in a moment.";
          res.json({ status: "unsupported", intentType, reason, reasoning: reason, plan, timing: timing() });
          return;
        }
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
      ...(approval ? { approval: approvalView(approval) } : {}),
      agentReasoning,
      timing: timing(),
    });
  } catch (err: any) {
    console.error("[intent] Pipeline error:", err);
    res.status(500).json({ error: err.message });
  }
});

/** The payload an approval stores for an agent-executed intent, or null if there's nothing to execute. */
function approvalExecution(intentType: string, payload: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (intentType === "swap" && payload?.quoteData) return { quoteData: payload.quoteData };
  if (intentType === "send" && payload?.sendData) return { sendData: payload.sendData };
  if (intentType === "add_liquidity" && payload?.lpData) return { lpData: payload.lpData };
  if (intentType === "remove_liquidity" && payload?.lpRemoveData) return { lpRemoveData: payload.lpRemoveData };
  return null;
}

/** Execute a claimed approval's stored payload through the Safe and record the outcome. */
async function executeApproval(a: PendingApproval): Promise<{ txHash: string; explorerUrl: string }> {
  try {
    const adapter = getAdapter(a.intentType);
    if (!adapter?.execute) throw new Error(`${a.intentType} can't be executed through the Safe`);
    const ctx = {
      walletAddress: a.wallet, safeAddress: a.safeAddress, balanceAddress: a.safeAddress, provider,
      params: {}, planSummary: a.summary, planSteps: [], totalEstimatedValueUsd: a.valueUsd, balances: null,
    };
    const exec = await adapter.execute(ctx, { payload: a.execution });
    if (!exec) throw new Error("execution produced no result");
    const result = { txHash: exec.txHash, explorerUrl: exec.explorerUrl };
    settle(a, { result });
    console.log(`[approval] ${a.id} executed: ${exec.txHash}`);
    return result;
  } catch (err: any) {
    settle(a, { error: err.message });
    console.error(`[approval] ${a.id} failed: ${err.message}`);
    throw err;
  }
}

/** Passkeys can't approve what was sent to the phone — otherwise the phone check could be skipped. */
function requirePasskeyChannel(a: PendingApproval): void {
  if (a.channel === "telegram") throw new ApprovalError(409, "This approval was sent to your Telegram. Approve it there.");
}

async function refreshTelegramMessage(a: PendingApproval): Promise<void> {
  if (a.telegram) await settleApprovalMessage(a.telegram.chatId, a.telegram.messageId, describeApproval(a), describeOutcome(a));
}

// Approve / Reject pressed in Telegram. Answers fast; execution runs in the
// background and the message is edited with the outcome.
const onTelegramDecision: DecisionHandler = async ({ wallet, approvalId, approve }) => {
  const a = getApproval(approvalId);
  if (!a || a.channel !== "telegram") return "Unknown approval.";
  if (a.wallet !== wallet) return "This approval belongs to another wallet.";
  if (a.status !== "pending") {
    await refreshTelegramMessage(a);
    return `Already ${a.status}.`;
  }
  if (!approve) {
    reject(a.id, wallet);
    console.log(`[telegram] ${a.id} rejected`);
    await refreshTelegramMessage(a);
    return "Rejected. Nothing was executed.";
  }
  // Phone-passkey approvals can't be approved with a chat button (there is none,
  // but a crafted callback must not skip the passkey either).
  if (a.factor === "phone-passkey") return "Open “Review & approve” and confirm with your phone's passkey.";
  claim(a.id, wallet);
  console.log(`[telegram] ${a.id} approved — executing via Safe`);
  await refreshTelegramMessage(a); // "⏳ executing…"
  executeApproval(a).catch(() => {}).finally(() => refreshTelegramMessage(a));
  return "Approved. Executing…";
};

/** A wallet in the body must match the session (catches a stale session after switching accounts). */
function sameWalletOrAbsent(bodyWallet: unknown, res: express.Response): boolean {
  if (bodyWallet == null || bodyWallet === "") return true;
  if (String(bodyWallet).toLowerCase() === res.locals.wallet) return true;
  res.status(401).json({ error: "Your session is for another wallet. Sign in again.", code: "session_required" });
  return false;
}

/** The passkey domain for a desktop request: localhost or PUBLIC_APP_URL, whichever the page is on. */
function desktopRp(req: express.Request): RelyingParty {
  const rp = rpForOrigin(req.headers.origin);
  if (rp) return rp;
  const phone = phoneRp();
  throw new ApprovalError(400, `Passkeys only work on ${browserRp().origin}${phone ? ` or ${phone.origin}` : ""}. Open Orchestra there.`);
}

function sendError(res: express.Response, err: any, fallbackStatus = 500): void {
  res.status(err instanceof ApprovalError ? err.status : fallbackStatus).json({ error: err.message });
}

// Addresses come from the session and the Safe lookup, never from the model.
function describeAddresses(wallet: string, safe: string | null): string {
  const lines = [`Your wallet: ${wallet}`];
  lines.push(safe
    ? `Your Safe (the account Orchestra trades from): ${safe}\nTo add funds to your account, send them to the Safe address.`
    : "You don't have a Safe yet. Create one to start trading.");
  return lines.join("\n");
}

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
    res.json({ registered: await hasPasskey(wallet, rpForOrigin(req.headers.origin) ?? browserRp()) });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Registering a passkey for a wallet requires a session for that wallet;
// otherwise anyone could register one for a wallet that has none.
app.post("/passkey/register-options", requireSession, async (req, res) => {
  try {
    const walletAddress = res.locals.wallet as string;
    res.json(await registrationOptions(walletAddress, desktopRp(req)));
  } catch (e: any) { sendError(res, e); }
});

app.post("/passkey/register", requireSession, async (req, res) => {
  try {
    const walletAddress = res.locals.wallet as string;
    const { response } = req.body;
    if (!response) { res.status(400).json({ error: "response required" }); return; }
    await verifyRegistration(walletAddress, response, { rp: desktopRp(req) });
    console.log(`[passkey] registered for ${walletAddress}`);
    res.json({ status: "ok", registered: true });
  } catch (e: any) { sendError(res, e, 400); }
});

// Passkey options for one pending approval. The challenge is derived from the
// approval's payload hash, so the assertion commits to that exact payload.
app.post("/passkey/auth-options", requireSession, async (req, res) => {
  try {
    const walletAddress = res.locals.wallet as string;
    const { approvalId } = req.body;
    const a = requirePending(approvalId, walletAddress);
    requirePasskeyChannel(a);
    const opts = await authenticationOptions(walletAddress, challengeBytes(a), desktopRp(req));
    a.challenge = opts.challenge;
    res.json(opts);
  } catch (e: any) { sendError(res, e, 400); }
});

// Verify the passkey assertion for an approval, then execute the payload the
// server stored for it. Any payload in the request body is ignored.
app.post("/passkey/approve", requireSession, async (req, res) => {
  try {
    const walletAddress = res.locals.wallet as string;
    const { approvalId, response } = req.body;
    if (!response) { res.status(400).json({ error: "response required" }); return; }
    const a = requirePending(approvalId, walletAddress);
    requirePasskeyChannel(a);
    const challenge = a.challenge;
    a.challenge = undefined; // single-use, pass or fail
    if (!challenge) { res.status(400).json({ error: "Request passkey options for this approval first." }); return; }

    const ok = await verifyAuthentication(walletAddress, response, challenge, desktopRp(req));
    if (!ok) { res.status(401).json({ error: "Passkey verification failed" }); return; }

    claim(a.id, walletAddress);
    console.log(`[passkey] ${a.id} approved by ${walletAddress} — executing via Safe`);
    const result = await executeApproval(a);
    res.json({ status: "ok", approvalId: a.id, ...result });
  } catch (e: any) { sendError(res, e); }
});

// ─── Approval status (the frontend polls this while an approval is out on another channel) ───
app.get("/approvals/:id", (req, res) => {
  const a = getApproval(req.params.id);
  if (!a) { res.status(404).json({ error: "Unknown approval" }); return; }
  res.json(approvalView(a));
});

// ─── Telegram linking ───
// 1. link-request → EIP-712 typed data with a one-time code  2. the wallet signs it
// 3. link → signature verified, t.me deep link returned  4. /start <code> in Telegram binds the chat.
app.get("/telegram/status", async (req, res) => {
  const wallet = String(req.query.wallet || "");
  if (!telegramEnabled()) { res.json({ enabled: false, linked: false }); return; }
  if (!ethers.isAddress(wallet)) { res.status(400).json({ error: "wallet query param required" }); return; }
  const link = await getLink(wallet);
  res.json({
    enabled: true, linked: !!link, username: link?.username,
    phoneAvailable: !!phoneRp(), phonePasskey: await hasPhonePasskey(wallet),
  });
});

// ─── Phone passkey ───
// Setup: the signed-in desktop asks → a one-time link goes to the linked Telegram
// → the phone opens it and creates a passkey for PUBLIC_APP_URL's domain.
// Approvals: the Telegram message links to /phone/approve/<id>?t=<secret>; the page
// shows the decoded payload and approving takes that passkey, bound to the payload hash.

function requirePhoneRp() {
  const rp = phoneRp();
  if (!rp) throw new ApprovalError(400, "Phone approvals need PUBLIC_APP_URL set to the app's public https address.");
  return rp;
}

app.post("/passkey/phone-setup", requireSession, async (_req, res) => {
  try {
    const wallet = res.locals.wallet as string;
    const rp = requirePhoneRp();
    const link = telegramEnabled() ? await getLink(wallet) : null;
    if (!link) { res.status(400).json({ error: "Link Telegram first: the setup link is sent there." }); return; }
    const token = createSetupToken(wallet);
    await sendLinkMessage(
      link.chatId,
      "Set up a passkey on this phone for Orchestra. Once it's set up, risky transactions are confirmed here with it. Open the link on this phone (valid 10 minutes, one use).",
      "📱 Set up phone passkey",
      `${rp.origin}/phone/setup?token=${encodeURIComponent(token)}`,
    );
    console.log(`[passkey] phone setup link sent to ${wallet}'s Telegram`);
    res.json({ sent: true });
  } catch (e: any) { sendError(res, e); }
});

app.post("/phone/setup/options", async (req, res) => {
  try {
    const rp = requirePhoneRp();
    const entry = getSetup(req.body?.token);
    if (!entry) { res.status(404).json({ error: "This setup link is invalid, used or expired. Ask for a new one in Orchestra." }); return; }
    // Repeatable: the link is single-use, so one challenge per link is enough and a
    // second fetch must not replace the one the phone may be signing.
    entry.options ??= await registrationOptions(entry.wallet, rp, true);
    entry.challenge = entry.options.challenge;
    res.json({ wallet: entry.wallet, options: entry.options });
  } catch (e: any) { sendError(res, e); }
});

app.post("/phone/setup/verify", async (req, res) => {
  try {
    const rp = requirePhoneRp();
    const { token, response } = req.body || {};
    const entry = getSetup(token);
    if (!entry || !entry.challenge) { res.status(404).json({ error: "This setup link is invalid, used or expired. Ask for a new one in Orchestra." }); return; }
    consumeSetup(token); // single-use, pass or fail
    await verifyRegistration(entry.wallet, response, { rp, challenge: entry.challenge, label: "phone" });
    console.log(`[passkey] phone passkey registered for ${entry.wallet}`);
    const link = await getLink(entry.wallet);
    if (link) sendText(link.chatId, "✅ Phone passkey set up. From now on, risky transactions are confirmed on this phone with it.").catch(() => {});
    res.json({ status: "ok" });
  } catch (e: any) { sendError(res, e, 400); }
});

app.post("/phone/approvals/:id/review", (req, res) => {
  try {
    const a = approvalForReview(req.params.id, req.body?.t);
    res.json({ review: reviewOf(a), ...approvalView(a) });
  } catch (e: any) { sendError(res, e); }
});

app.post("/phone/approvals/:id/options", async (req, res) => {
  try {
    const rp = requirePhoneRp();
    const a = approvalForReview(req.params.id, req.body?.t);
    requirePending(a.id, a.wallet);
    // Repeatable while the challenge is unused: a second fetch (page reload, React
    // dev double effects) must not replace the challenge the phone may be signing.
    if (a.challenge && a.passkeyOptions?.challenge === a.challenge) { res.json(a.passkeyOptions); return; }
    const opts = await authenticationOptions(a.wallet, challengeBytes(a), rp);
    a.challenge = opts.challenge;
    a.passkeyOptions = opts as unknown as PendingApproval["passkeyOptions"];
    res.json(opts);
  } catch (e: any) { sendError(res, e, 400); }
});

app.post("/phone/approvals/:id/approve", async (req, res) => {
  try {
    const rp = requirePhoneRp();
    const a = approvalForReview(req.params.id, req.body?.t);
    requirePending(a.id, a.wallet);
    const challenge = a.challenge;
    a.challenge = undefined; // single-use, pass or fail
    if (!challenge) { res.status(400).json({ error: "Start the passkey check for this approval first." }); return; }
    const ok = await verifyAuthentication(a.wallet, req.body?.response, challenge, rp);
    if (!ok) { res.status(401).json({ error: "Passkey verification failed" }); return; }

    claim(a.id, a.wallet);
    console.log(`[passkey] ${a.id} approved with the phone passkey — executing via Safe`);
    await refreshTelegramMessage(a); // "⏳ executing…"
    try {
      const result = await executeApproval(a);
      res.json({ status: "ok", ...result });
    } finally {
      refreshTelegramMessage(a).catch(() => {});
    }
  } catch (e: any) { sendError(res, e); }
});

app.post("/phone/approvals/:id/reject", async (req, res) => {
  try {
    const a = approvalForReview(req.params.id, req.body?.t);
    reject(a.id, a.wallet);
    console.log(`[passkey] ${a.id} rejected on the phone`);
    await refreshTelegramMessage(a);
    res.json({ status: "rejected" });
  } catch (e: any) { sendError(res, e); }
});

app.post("/telegram/link-request", (req, res) => {
  try {
    if (!telegramEnabled()) { res.status(400).json({ error: "Telegram approvals aren't configured on this server." }); return; }
    res.json(linkRequest(String(req.body?.walletAddress || "")));
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

app.post("/telegram/link", async (req, res) => {
  try {
    const { walletAddress, code, signature } = req.body || {};
    if (!walletAddress || !code || !signature) { res.status(400).json({ error: "walletAddress, code and signature required" }); return; }
    res.json(await confirmLink(walletAddress, code, signature));
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

// ─── Live prices (cached) ───
app.get("/prices", async (_req, res) => {
  await refreshPrices().catch(() => {});
  res.json({ prices: getPrices() });
});

// ─── Wallet sessions ───
// 1. login-request → EIP-712 typed data with a one-time nonce  2. the wallet signs it
// 3. login → signature verified, session token issued (send as Authorization: Bearer).
app.post("/auth/login-request", (req, res) => {
  try {
    res.json(loginRequest(req.body?.walletAddress));
  } catch (e: any) { res.status(e instanceof AuthError ? e.status : 400).json({ error: e.message }); }
});

app.post("/auth/login", (req, res) => {
  try {
    const { walletAddress, nonce, signature } = req.body || {};
    const session = login(walletAddress, nonce, signature);
    console.log(`[auth] session issued for ${session.wallet}`);
    res.json(session);
  } catch (e: any) { res.status(e instanceof AuthError ? e.status : 400).json({ error: e.message }); }
});

// Privy sign-in (passkey/email with an embedded wallet, or an external wallet):
// the identity token proves the user owns the wallet, so no second signature.
app.post("/auth/privy", async (req, res) => {
  try {
    const { walletAddress, identityToken } = req.body || {};
    const session = await privyLogin(identityToken, walletAddress);
    console.log(`[auth] session issued for ${session.wallet} (Privy)`);
    res.json(session);
  } catch (e: any) { res.status(e instanceof AuthError ? e.status : 400).json({ error: e.message }); }
});

app.get("/auth/session", requireSession, (_req, res) => {
  res.json({ wallet: res.locals.wallet });
});

// ─── Policy config ───
// Read/merge the signed-in wallet's deterministic policy (user:profile:<wallet>.policy).
// Fields: verifiedTokens, knownAddresses, dailyLimitUsd, maxAutoTxPerDay, typicalMaxUsd.
app.get("/policy", requireSession, async (_req, res) => {
  try {
    const p = await readUserProfile(res.locals.wallet);
    res.json({ policy: p.policy || {} });
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

app.post("/policy", requireSession, async (req, res) => {
  try {
    const wallet = res.locals.wallet as string;
    const patch = req.body?.policy;
    if (!patch || typeof patch !== "object") {
      res.status(400).json({ error: "body must be { policy: { ... } }" });
      return;
    }
    const existing = await readUserProfile(wallet);
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
    await writeUserProfile(wallet, updated); // also drops the cached policy
    console.log(`[policy] Updated for ${wallet}: ${JSON.stringify(updated.policy)}`);
    res.json({ status: "ok", policy: updated.policy });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Safe onboarding ───
app.post("/onboard", requireSession, async (req, res) => {
  try {
    const ledgerAddress = ethers.getAddress(res.locals.wallet);
    if (!sameWalletOrAbsent(req.body?.ledgerAddress, res)) return;
    const { spendingLimitUSD = 100 } = req.body;

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

    // Merge: keep any existing guardrail policy instead of wiping it.
    const existingProfile = await readUserProfile(ledgerAddress);
    await writeUserProfile(ledgerAddress, {
      ...existingProfile,
      address: ledgerAddress,
      safeAddress,
      riskTolerance: existingProfile.riskTolerance || "moderate",
      autoApproveLimit: spendingLimitUSD,
      preferredTokens: existingProfile.preferredTokens || ["USDC", "WETH", "ETH"],
      createdAt: existingProfile.createdAt || new Date().toISOString(),
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
app.post("/prepare-limit-update", requireSession, async (req, res) => {
  try {
    const ledgerAddress = ethers.getAddress(res.locals.wallet);
    if (!sameWalletOrAbsent(req.body?.ledgerAddress, res)) return;
    const { newLimitUSD } = req.body;
    if (!newLimitUSD) {
      res.status(400).json({ error: "newLimitUSD required" });
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

// Step 2: After Ledger signs and tx is broadcast, update storage + OrchestraPolicy.
// Only once the chain shows that exact limit-update tx succeeded, sent by this
// wallet to its Safe — a session alone can't raise the limit.
app.post("/finalize-limit-update", requireSession, async (req, res) => {
  try {
    const ledgerAddress = ethers.getAddress(res.locals.wallet);
    if (!sameWalletOrAbsent(req.body?.ledgerAddress, res)) return;
    const { newLimitUSD, txHash } = req.body;
    if (!newLimitUSD || typeof txHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
      res.status(400).json({ error: "newLimitUSD and txHash required" });
      return;
    }

    const stored = await read(`safe:${ledgerAddress.toLowerCase()}`);
    if (!stored) {
      res.status(400).json({ error: "No Safe found." });
      return;
    }

    const safeAddress = (stored as any).safeAddress as string;
    const expected = buildLimitUpdateTx(safeAddress, ledgerAddress, getAgentAddress(), newLimitUSD);
    const [tx, receipt] = await Promise.all([
      withTimeout(provider.getTransaction(txHash), 10_000, null),
      withTimeout(provider.getTransactionReceipt(txHash), 10_000, null),
    ]);
    const problem = limitTxProblem({ tx, receipt, wallet: ledgerAddress, safeAddress, expectedData: expected.data });
    if (problem) {
      res.status(400).json({ error: `Limit not updated: ${problem}` });
      return;
    }

    // Update 0G Storage
    await write(`safe:${ledgerAddress.toLowerCase()}`, {
      ...(stored as any),
      spendingLimitUSD: newLimitUSD,
    });
    const profile = await readUserProfile(ledgerAddress);
    await writeUserProfile(ledgerAddress, {
      ...profile,
      autoApproveLimit: newLimitUSD,
      updatedAt: new Date().toISOString(),
    });

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
  startTelegramBot(onTelegramDecision);
});

server.on("error", (err) => {
  console.error("Server error:", err);
});
