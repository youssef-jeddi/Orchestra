// ─── Approvals — clear-text description for out-of-band channels ───
// Renders a pending approval for a second screen (Telegram, the phone approval
// page), like a hardware wallet's clear signing: every line is decoded from the
// stored execution payload — the exact fields execute() consumes — never from
// the planner's summary. If the payload can't be decoded, it says so loudly.

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

/** One decoded fact about the action. `mono` values are addresses: show them in full, monospaced. */
export interface ReviewDetail {
  label: string;
  value: string;
  mono?: boolean;
}

/** Everything a second screen shows about an approval (plain text; the renderer escapes). */
export interface ApprovalReview {
  decoded: boolean;
  title: string;
  details: ReviewDetail[];
  why: string;
  safeAddress: string;
  network: string;
  expiresAt: string;
  ref: string;
  status: PendingApproval["status"];
}

/** Registry token for an address; the zero/sentinel address is native ETH. */
function tokenAt(address: string): TokenDef | null {
  if (address.toLowerCase() === NATIVE_ETH) return TOKENS.ETH;
  const a = address.toLowerCase();
  return Object.values(TOKENS).find((t) => !t.native && t.address.toLowerCase() === a) ?? null;
}

const amount = (n: number, symbol: string) => `${formatTokenAmount(n, symbol)} ${symbol}`;

/** Title + details decoded from the payload, or null if it isn't something we recognise. */
function decode(a: PendingApproval): { title: string; details: ReviewDetail[] } | null {
  if (a.intentType === "send") {
    const tx = (a.execution as any)?.sendData?.unsignedTx;
    if (!tx || typeof tx.to !== "string") return null;
    const data = String(tx.data || "0x");
    if (data === "0x") {
      const eth = Number(ethers.formatEther(BigInt(tx.value || 0)));
      return { title: `Send ${amount(eth, "ETH")}`, details: [{ label: "to", value: ethers.getAddress(tx.to), mono: true }] };
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
    return { title: `Send ${amount(n, token.symbol)}`, details: [{ label: "to", value: ethers.getAddress(decoded[0]), mono: true }] };
  }

  if (a.intentType === "swap") {
    const q = (a.execution as any)?.quoteData;
    if (!q || typeof q.tokenIn !== "string" || typeof q.tokenOut !== "string") return null;
    const tIn = tokenAt(q.tokenIn);
    const tOut = tokenAt(q.tokenOut);
    if (!tIn || !tOut) return null;
    const spend = Number(ethers.formatUnits(BigInt(q.amount || 0), tIn.decimals));
    const pct = Math.round(resolveMaxSwapShortfall() * 100);
    const receive = typeof q.expectedOut === "number" && q.expectedOut > 0
      ? `≈ ${amount(q.expectedOut, tOut.symbol)} (refused if more than ${pct}% below market)`
      : `${tOut.symbol} at the live quote (refused if more than ${pct}% below market)`;
    return {
      title: `Swap ${amount(spend, tIn.symbol)} → ${tOut.symbol}`,
      details: [
        { label: "You spend exactly", value: amount(spend, tIn.symbol) },
        { label: "You receive", value: receive },
        { label: "Output goes to", value: "your Safe" },
      ],
    };
  }
  return null;
}

export function reviewOf(a: PendingApproval): ApprovalReview {
  const decoded = decode(a);
  const why = a.triggered.map((t) => RULE_LABELS[t]).filter(Boolean);
  return {
    decoded: !!decoded,
    title: decoded?.title ?? "⛔ I couldn't decode this transaction",
    details: decoded?.details ?? [{ label: "Don't approve it", value: "unless you know exactly what it is." }],
    why: why.length ? why.join(", ") : a.reason,
    safeAddress: a.safeAddress,
    network: "Sepolia",
    expiresAt: new Date(a.expiresAt).toISOString(),
    ref: a.hash.slice(2, 10),
    status: a.status,
  };
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const short = (addr: string) => `${addr.slice(0, 6)}…${addr.slice(-4)}`;

/**
 * HTML message (Telegram parse_mode=HTML) describing what approving will execute.
 * `phonePasskey`: approval happens on the review page, confirmed with the phone's passkey.
 */
export function describeApproval(a: PendingApproval, opts: { phonePasskey?: boolean } = {}): string {
  const r = reviewOf(a);
  return [
    "⚠️ <b>Orchestra: approval needed</b>",
    "",
    `<b>${esc(r.title)}</b>`,
    ...r.details.map((d) => `${esc(d.label)} ${d.mono ? `<code>${esc(d.value)}</code>` : esc(d.value)}`),
    `from your Safe <code>${esc(short(r.safeAddress))}</code> · ${r.network}`,
    "",
    `<b>Why you're asked:</b> ${esc(r.why)}`,
    ...(opts.phonePasskey ? ["", "Open the review page and confirm with your phone's passkey."] : []),
    "",
    `<i>Expires ${r.expiresAt.slice(11, 16)} UTC · ref ${r.ref}</i>`,
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
