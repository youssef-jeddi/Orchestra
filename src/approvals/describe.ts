// ─── Approvals — clear-text description for out-of-band channels ───
// Renders a pending approval for a second screen (Telegram), like a hardware
// wallet's clear signing: every line is decoded from the stored execution
// payload — the exact fields execute() consumes — never from the planner's
// summary. If the payload can't be decoded, the message says so loudly.

import { ethers } from "ethers";
import { TOKENS, type TokenDef } from "../intent/tokens";
import { formatTokenAmount, resolveMaxSwapShortfall } from "../policy";
import type { PendingApproval } from "./index";

const NATIVE_ETH = "0x0000000000000000000000000000000000000000";
const ERC20 = new ethers.Interface(["function transfer(address to, uint256 amount)"]);

const RULE_LABELS: Record<string, string> = {
  "daily-limit": "over your daily auto-approve limit",
  "daily-count-velocity": "too many transactions today",
  "unverified-token": "token not in your verified list",
  "unknown-recipient": "recipient you haven't approved before",
  "habit-anomaly": "unusually large for you",
  "unknown-intent": "unrecognized action",
};

/** Registry token for an address; `native` picks ETH over WETH for the zero/sentinel address. */
function tokenAt(address: string, native = false): TokenDef | null {
  if (native || address.toLowerCase() === NATIVE_ETH) return TOKENS.ETH;
  const a = address.toLowerCase();
  return Object.values(TOKENS).find((t) => !t.native && t.address.toLowerCase() === a) ?? null;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const short = (addr: string) => `${addr.slice(0, 6)}…${addr.slice(-4)}`;
const amount = (n: number, symbol: string) => `${formatTokenAmount(n, symbol)} ${symbol}`;

/** The decoded action lines, or null if the payload isn't something we recognise. */
function actionLines(a: PendingApproval): string[] | null {
  if (a.intentType === "send") {
    const tx = (a.execution as any)?.sendData?.unsignedTx;
    if (!tx || typeof tx.to !== "string") return null;
    const data = String(tx.data || "0x");
    if (data === "0x") {
      const eth = Number(ethers.formatEther(BigInt(tx.value || 0)));
      return [`<b>Send ${esc(amount(eth, "ETH"))}</b>`, `to <code>${esc(ethers.getAddress(tx.to))}</code>`];
    }
    const token = tokenAt(tx.to);
    let decoded: ethers.Result;
    try {
      decoded = ERC20.decodeFunctionData("transfer", data);
    } catch {
      return null;
    }
    if (!token || BigInt(tx.value || 0) !== 0n) return null;
    const n = Number(ethers.formatUnits(decoded[1], token.decimals));
    return [`<b>Send ${esc(amount(n, token.symbol))}</b>`, `to <code>${esc(ethers.getAddress(decoded[0]))}</code>`];
  }

  if (a.intentType === "swap") {
    const q = (a.execution as any)?.quoteData;
    if (!q || typeof q.tokenIn !== "string" || typeof q.tokenOut !== "string") return null;
    const tIn = tokenAt(q.tokenIn);
    const tOut = tokenAt(q.tokenOut);
    if (!tIn || !tOut) return null;
    const spend = Number(ethers.formatUnits(BigInt(q.amount || 0), tIn.decimals));
    const lines = [
      `<b>Swap ${esc(amount(spend, tIn.symbol))} → ${tOut.symbol}</b>`,
      `You spend exactly ${esc(amount(spend, tIn.symbol))}`,
    ];
    const pct = Math.round(resolveMaxSwapShortfall() * 100);
    if (typeof q.expectedOut === "number" && q.expectedOut > 0) {
      lines.push(`You receive ≈ ${esc(amount(q.expectedOut, tOut.symbol))} (refused if more than ${pct}% below market)`);
    } else {
      lines.push(`You receive ${tOut.symbol} at the live quote (refused if more than ${pct}% below market)`);
    }
    lines.push(`Output goes to your Safe`);
    return lines;
  }
  return null;
}

/** HTML message (Telegram parse_mode=HTML) describing what approving will execute. */
export function describeApproval(a: PendingApproval): string {
  const lines = actionLines(a);
  const why = a.triggered.map((t) => RULE_LABELS[t]).filter(Boolean);
  const expires = new Date(a.expiresAt).toISOString().slice(11, 16);

  return [
    "⚠️ <b>Orchestra: approval needed</b>",
    "",
    ...(lines ?? [
      "<b>⛔ I couldn't decode this transaction.</b>",
      "Don't approve it unless you know exactly what it is.",
    ]),
    `from your Safe <code>${esc(short(a.safeAddress))}</code> · Sepolia`,
    "",
    `<b>Why you're asked:</b> ${esc(why.length ? why.join(", ") : a.reason)}`,
    "",
    `<i>Expires ${expires} UTC · ref ${a.hash.slice(2, 10)}</i>`,
  ].join("\n");
}

/** One-line outcome that replaces the buttons once the approval is settled. */
export function describeOutcome(a: PendingApproval): string {
  if (a.status === "executed" && a.result) return `✅ <b>Approved and executed</b>\n<a href="${esc(a.result.explorerUrl)}">View on Etherscan</a>`;
  if (a.status === "failed") return `❌ <b>Approved, but execution failed</b>\n${esc(a.error || "unknown error")}`;
  if (a.status === "rejected") return "🚫 <b>Rejected.</b> Nothing was executed.";
  if (a.status === "expired") return "⌛ <b>Expired.</b> Nothing was executed.";
  return `⏳ ${a.status}…`;
}
