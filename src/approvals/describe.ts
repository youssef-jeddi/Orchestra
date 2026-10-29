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
  "daily-limit": "it's over your daily limit for automatic actions",
  "daily-count-velocity": "you've already done a lot today",
  "unverified-token": "it involves a token you haven't checked",
  "unknown-recipient": "it goes to someone you haven't sent to before",
  "habit-anomaly": "it's bigger than you usually move",
  "unknown-intent": "I don't recognise this kind of action",
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

/**
 * Who a stored send pays, decoded from the transaction that will run (a native transfer's `to`,
 * or the recipient inside an ERC-20 transfer) — not from any summary or label. Null if unreadable.
 */
export function sentRecipient(execution: Record<string, unknown> | undefined): string | null {
  const tx = (execution as any)?.sendData?.unsignedTx;
  if (!tx || typeof tx.to !== "string") return null;
  const data = String(tx.data || "0x");
  try {
    if (data === "0x") return ethers.getAddress(tx.to);
    return ethers.getAddress(ERC20.decodeFunctionData("transfer", data)[0]);
  } catch {
    return null;
  }
}

/** Title + details decoded from the payload, or null if it isn't something we recognise. */
function decode(a: PendingApproval): { title: string; details: ReviewDetail[] } | null {
  // A plan (ORC-21): every step decoded on its own from its stored payload; one step that can't be
  // decoded makes the whole plan "couldn't work out what this would do".
  if (a.intentType === "plan") {
    const steps = (a.execution as any)?.planData?.steps;
    if (!Array.isArray(steps) || steps.length < 2 || steps.length > 3) return null;
    const details: ReviewDetail[] = [];
    let dependent = false;
    for (const [i, step] of steps.entries()) {
      if (!step || step.intentType === "plan" || typeof step.execution !== "object") return null;
      const d = decode({ ...a, intentType: step.intentType, execution: step.execution });
      if (!d) return null;
      details.push({ label: `Step ${i + 1}:`, value: d.title }, ...d.details.map((x) => ({ ...x, label: `  ${x.label}` })));
      if (Array.isArray(step.amounts) && step.amounts.some((r: any) => r?.kind !== "fixed")) dependent = true;
    }
    details.push({ label: "How it runs", value: "one step after another; if one doesn't go through, I stop there" });
    if (dependent) details.push({ label: "Amounts", value: "the most each step uses; a step that uses what is left, or what an earlier step brought in, can only use less" });
    return { title: `${steps.length} steps, approved together`, details };
  }
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
      ? `≈ ${amount(q.expectedOut, tOut.symbol)} (I won't go ahead if that's more than ${pct}% below the market price)`
      : `${tOut.symbol} at today's price (I won't go ahead if that's more than ${pct}% below the market price)`;
    return {
      title: `Swap ${amount(spend, tIn.symbol)} → ${tOut.symbol}`,
      details: [
        { label: "You spend exactly", value: amount(spend, tIn.symbol) },
        { label: "You receive", value: receive },
        { label: "It goes to", value: "your account" },
      ],
    };
  }
  if (a.intentType === "add_liquidity") {
    const d = (a.execution as any)?.lpData;
    if (!d || typeof d.tokenA !== "string" || typeof d.tokenB !== "string") return null;
    // tokenAt maps the WETH address to WETH; the stored symbol says whether it's paid in native ETH.
    const side = (address: string, symbol: unknown) => (String(symbol).toUpperCase() === "ETH" ? TOKENS.ETH : tokenAt(address));
    const tA = side(d.tokenA, d.symbolA);
    const tB = side(d.tokenB, d.symbolB);
    const fee = Number(d.feeTier);
    if (!tA || !tB || !(fee > 0)) return null;
    const maxA = Number(ethers.formatUnits(BigInt(d.amountA || 0), tA.decimals));
    const maxB = Number(ethers.formatUnits(BigInt(d.amountB || 0), tB.decimals));
    const details: ReviewDetail[] = [
      { label: "What this is", value: "you lend these to a trading pool and earn a share of its fees" },
      { label: "You put in at most", value: `${amount(maxA, tA.symbol)} + ${amount(maxB, tB.symbol)}` },
    ];
    if (typeof d.usedA === "number" && typeof d.usedB === "number") {
      details.push({ label: "At today's price, about", value: `${amount(d.usedA, tA.symbol)} + ${amount(d.usedB, tB.symbol)} (the rest stays in your account)` });
    }
    details.push(
      { label: "Price range", value: "all prices (I won't go ahead if the pool's price is far from the market price)" },
      { label: "It goes to", value: "your account" },
    );
    return { title: `Add liquidity: ${tA.symbol}/${tB.symbol} (${fee / 10000}% pool)`, details };
  }

  if (a.intentType === "remove_liquidity") {
    const d = (a.execution as any)?.lpRemoveData;
    const t0 = d && typeof d.token0 === "string" ? tokenAt(d.token0) : null;
    const t1 = d && typeof d.token1 === "string" ? tokenAt(d.token1) : null;
    const percent = Number(d?.percent);
    if (!t0 || !t1 || !/^\d+$/.test(String(d.tokenId)) || !(percent > 0 && percent <= 100)) return null;
    const shown = (t: TokenDef) => (t.symbol === "WETH" ? "ETH" : t.symbol); // unwrapped on the way out
    return {
      title: `Take out liquidity: ${shown(t0)}/${shown(t1)} (${Number(d.fee) / 10000}% pool)`,
      details: [
        { label: "Position", value: `#${d.tokenId}` },
        { label: "Share taken out", value: percent === 100 ? "all of it (the empty position is closed)" : `${percent}%` },
        { label: "You get back", value: `${shown(t0)} and ${shown(t1)} at today's price, plus the fees earned` },
        { label: "It goes to", value: "your account" },
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
    title: decoded?.title ?? "⛔ I couldn't work out what this would do",
    details: decoded?.details ?? [{ label: "Don't approve it", value: "unless you know exactly what it is." }],
    why: why.length ? why.join(", ") : a.reason,
    safeAddress: a.safeAddress,
    network: "test network (Sepolia)",
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
    "⚠️ <b>Orchestra needs your OK</b>",
    "",
    `<b>${esc(r.title)}</b>`,
    ...r.details.map((d) => `${esc(d.label)} ${d.mono ? `<code>${esc(d.value)}</code>` : esc(d.value)}`),
    `from your account <code>${esc(short(r.safeAddress))}</code> · ${r.network}`,
    "",
    `<b>Why I'm asking:</b> ${esc(r.why)}`,
    ...(opts.phonePasskey ? ["", "Open the review page and confirm with your phone's passkey (fingerprint or face)."] : []),
    "",
    `<i>Expires ${r.expiresAt.slice(11, 16)} UTC · ref ${r.ref}</i>`,
  ].join("\n");
}

/** One-line outcome that replaces the buttons once the approval is settled. */
export function describeOutcome(a: PendingApproval): string {
  if (a.intentType === "plan" && a.steps && (a.status === "executed" || a.status === "failed")) {
    const lines = a.steps.map((st) => {
      const mark = st.status === "done" ? "✅" : st.status === "failed" ? "❌" : "–";
      const receipt = st.explorerUrl ? ` <a href="${esc(st.explorerUrl)}">receipt ↗</a>` : "";
      return `${mark} ${st.index + 1}. ${esc(st.summary)}${receipt}`;
    });
    const head = a.status === "executed" ? "✅ <b>Approved and done</b>" : `❌ <b>Approved, but not every step went through</b>`;
    return [head, ...lines].join("\n");
  }
  if (a.status === "executed" && a.result) return `✅ <b>Approved and done</b>\n<a href="${esc(a.result.explorerUrl)}">View receipt ↗</a>`;
  if (a.status === "failed") return `❌ <b>Approved, but it didn't go through</b>\n${esc(a.error || "something went wrong")}`;
  if (a.status === "rejected") return "🚫 <b>You said no.</b> Nothing was done.";
  if (a.status === "expired") return "⌛ <b>Expired.</b> Nothing was done.";
  return `⏳ ${a.status}…`;
}
