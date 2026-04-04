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

const SEPOLIA_RPC = process.env.SEPOLIA_RPC_URL || "https://rpc.sepolia.org";
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
    const { submitSwap } = await import("../uniswap/api");
    const swapTx = await submitSwap(quote, permitData, signature);

    console.log(`[serve] swap tx from Uniswap:`, JSON.stringify(swapTx).slice(0, 200));

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
