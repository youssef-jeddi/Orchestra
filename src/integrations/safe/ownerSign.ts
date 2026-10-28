// ─── Safe — a request past the on-chain cap, signed by the owner themselves ───
// The module refuses more than $1000 a day, but the user is the account's sole owner and may
// always sign a Safe transaction with their own wallet. When a request is over the ceiling, the
// exact Safe transaction is held here (server-side, bound to its EIP-712 hash); the wallet signs
// that hash, and the server relays it. The agent key is only the sender that pays gas — it never
// signs for the Safe, and the client never sends a transaction, only a signature over what we hold.
// Held in memory: a restart drops the offer, and the user simply asks again (nothing had moved).

import crypto from "crypto";
import { ethers } from "ethers";
import { UserFacingError } from "../../utils/userFacing";
import { makeSepoliaProvider, SEPOLIA_CHAIN_ID } from "../../utils/rpc";
import { safeGasLimit } from "./transaction";
import { safeCallFor, type SafeCall } from "./spendingModule";
import { recordActivity, spendActivity } from "../../policy/store";
import { safeErr } from "../../utils/redact";
import { faultOn } from "../../utils/faultInject";
import { assertGasBudget, noteRelayerGas } from "../../policy/gasStore";

export const OWNER_SIGN_TTL_MS = 10 * 60_000;

/** Safe's EIP-712 transaction type (the same for Safe 1.3.0 and 1.4.1). */
export const SAFE_TX_TYPES = {
  SafeTx: [
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "data", type: "bytes" },
    { name: "operation", type: "uint8" },
    { name: "safeTxGas", type: "uint256" },
    { name: "baseGas", type: "uint256" },
    { name: "gasPrice", type: "uint256" },
    { name: "gasToken", type: "address" },
    { name: "refundReceiver", type: "address" },
    { name: "nonce", type: "uint256" },
  ],
};

const EXEC_ABI = [
  "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool success)",
  "function nonce() view returns (uint256)",
];

export interface OwnerSignRecord {
  id: string;
  /** Lowercased wallet that owns the account (the only one who may sign and submit). */
  wallet: string;
  safeAddress: string;
  summary: string;
  domain: { chainId: number; verifyingContract: string };
  message: Record<string, string | number>;
  safeTxHash: string;
  /** What the owner is about to send, kept to record it in the activity list once it has gone through. */
  valueUsd: number;
  to?: string;
  token?: string;
  /** The amount and symbol the plan says it sends; the browser checks them against the decoded transaction (ORC-113). */
  amount?: string;
  symbol?: string;
  expiresAt: number;
  status: "pending" | "executing" | "executed" | "expired";
  /** Part of a sends-only plan signed one send at a time (ORC-21): its place in the plan. */
  series?: { index: number; total: number };
  /** The plan's sends still to sign after this one; the next is held only once this one has gone through. */
  rest?: OwnerSend[];
}

/** One send of a plan, waiting to be held for the owner to sign (a plain payment, never a bundle). */
export interface OwnerSend {
  summary: string;
  batch: Array<{ to: string; value: string; data: string }>;
  meta: { valueUsd?: number; to?: string; token?: string; amount?: string; symbol?: string };
}

const records = new Map<string, OwnerSignRecord>();

/** The EIP-712 hash of a Safe transaction on this account (what the owner's wallet signs). */
export function safeTxHashOf(domain: OwnerSignRecord["domain"], message: OwnerSignRecord["message"]): string {
  return ethers.TypedDataEncoder.hash(domain, SAFE_TX_TYPES, message);
}

/**
 * What the frontend gets: enough to ask the wallet for a signature, nothing it could swap. The
 * browser decodes `typedData` itself and refuses anything but a plain payment (ORC-113); `claim` is
 * what the plan says it sends, which the decoded transaction must match.
 */
export function ownerSignView(r: OwnerSignRecord) {
  const claim = { to: r.to, amount: r.amount, symbol: r.symbol };
  return {
    kind: "safe-owner" as const,
    id: r.id,
    summary: r.summary,
    safeTxHash: r.safeTxHash,
    expiresAt: r.expiresAt,
    typedData: { domain: r.domain, types: SAFE_TX_TYPES, primaryType: "SafeTx", message: r.message },
    ...(claim.to || claim.amount || claim.symbol ? { claim } : {}),
    ...(r.series ? { series: r.series } : {}),
  };
}

/** Store the Safe transaction for `call` (a fresh nonce read) and return the offer to sign it. */
export function holdOwnerSign(input: { wallet: string; safeAddress: string; summary: string; call: SafeCall & { nonce: number }; valueUsd?: number; to?: string; token?: string; amount?: string; symbol?: string; series?: OwnerSignRecord["series"]; rest?: OwnerSend[] }, now = Date.now()): OwnerSignRecord {
  const { call } = input;
  const domain = { chainId: SEPOLIA_CHAIN_ID, verifyingContract: ethers.getAddress(input.safeAddress) };
  const message = {
    to: call.to, value: call.value, data: call.data, operation: call.operation,
    safeTxGas: "0", baseGas: "0", gasPrice: "0",
    gasToken: ethers.ZeroAddress, refundReceiver: ethers.ZeroAddress, nonce: call.nonce,
  };
  const record: OwnerSignRecord = {
    id: crypto.randomUUID(), wallet: input.wallet.toLowerCase(), safeAddress: domain.verifyingContract,
    summary: input.summary, domain, message, safeTxHash: safeTxHashOf(domain, message),
    valueUsd: input.valueUsd ?? 0, to: input.to, token: input.token, amount: input.amount, symbol: input.symbol,
    expiresAt: now + OWNER_SIGN_TTL_MS, status: "pending",
    ...(input.series ? { series: input.series } : {}),
    ...(input.rest?.length ? { rest: input.rest } : {}),
  };
  records.set(record.id, record);
  return record;
}

/**
 * Dev-only (`ORCHESTRA_FAULT_INJECT=owner-sign-tamper`): what a hacked bridge could hold instead of
 * the payment, an addOwnerWithThreshold on the account itself, under the same summary and claim.
 * Lets the browser check be seen refusing it; faultOn is always off in production.
 */
export function tamperedCall(safeAddress: string, call: SafeCall & { nonce: number }): SafeCall & { nonce: number } {
  const iface = new ethers.Interface(["function addOwnerWithThreshold(address owner, uint256 _threshold)"]);
  const data = iface.encodeFunctionData("addOwnerWithThreshold", ["0x000000000000000000000000000000000000dEaD", 1]);
  return { to: ethers.getAddress(safeAddress), value: "0", data, operation: 0, nonce: call.nonce };
}

/** Build and hold the offer for a batch the module refused. */
export async function offerOwnerSign(wallet: string, safeAddress: string, summary: string, batch: Array<{ to: string; value: string; data: string }>, meta: { valueUsd?: number; to?: string; token?: string; amount?: string; symbol?: string } = {}, chain: { series?: OwnerSignRecord["series"]; rest?: OwnerSend[] } = {}) {
  let call = await safeCallFor(safeAddress, batch);
  if (faultOn("owner-sign-tamper")) call = tamperedCall(safeAddress, call);
  return ownerSignView(holdOwnerSign({ wallet, safeAddress, summary, call, ...meta, ...chain }));
}

/**
 * A sends-only plan over the ceiling (ORC-21): the owner signs its sends one at a time, each a plain
 * payment the browser check (ORC-113) can decode, never one MultiSend (a DelegateCall, which that
 * check refuses). Only the first is held now; each next one is held with a fresh nonce once the one
 * before has gone through (see submitOwnerSignature), so they can only be signed and sent in order.
 */
export async function offerOwnerSignSeries(wallet: string, safeAddress: string, sends: OwnerSend[]) {
  if (!sends.length) throw new Error("nothing to sign");
  const [first, ...rest] = sends;
  return offerOwnerSign(wallet, safeAddress, first.summary, first.batch, first.meta, { series: { index: 0, total: sends.length }, rest });
}

/** Hold the send after `r` in its plan (the default for OwnerSignDeps.holdNext). */
async function holdNextSend(r: OwnerSignRecord): Promise<ReturnType<typeof ownerSignView>> {
  const [next, ...rest] = r.rest!;
  const index = (r.series?.index ?? 0) + 1;
  return offerOwnerSign(r.wallet, r.safeAddress, next.summary, next.batch, next.meta, { series: { index, total: r.series?.total ?? index + 1 + rest.length }, rest });
}

/** When the next send of a plan couldn't be prepared after one went through. */
export const NEXT_SEND_FAILED_TEXT =
  "That send went through, but I couldn't prepare the next one for you to sign. Ask me again for the sends that are left.";

/**
 * The pending offer `id` for `wallet`, to show again in the app (e.g. from a Telegram link).
 * Someone else's, missing, already used and expired requests all look the same: not found.
 */
export function getOwnerSign(wallet: string, id: unknown, now = Date.now()): OwnerSignRecord {
  const r = typeof id === "string" ? records.get(id) : undefined;
  if (!r || r.wallet !== wallet.toLowerCase() || r.status !== "pending") throw new UserFacingError("That request expired. Ask me again, or try again after the daily reset.", 404);
  if (now > r.expiresAt) {
    r.status = "expired";
    throw new UserFacingError("That request expired. Ask me again, or try again after the daily reset.", 404);
  }
  return r;
}

export interface OwnerSignDeps {
  /** Send the stored transaction with the owner's signature; returns the tx hash. */
  relay: (r: OwnerSignRecord, signature: string) => Promise<string>;
  /** Throws when the account's network fees for today are used up or can't be read (ORC-31); defaults to the real check. */
  gasBudget?: (safeAddress: string) => Promise<void>;
  now?: () => number;
  /** Hold the plan's next send once this one went through (defaults to a fresh offer from the chain). */
  holdNext?: (r: OwnerSignRecord) => Promise<Record<string, unknown>>;
}

/**
 * Submit the owner's signature for a held transaction. Only the wallet it was held for may submit;
 * the signature must be that wallet's over the stored hash; it runs at most once.
 */
export async function submitOwnerSignature(wallet: string, id: unknown, signature: unknown, deps: OwnerSignDeps): Promise<{ txHash: string; explorerUrl: string; next?: Record<string, unknown>; nextError?: string }> {
  const r = typeof id === "string" ? records.get(id) : undefined;
  if (!r || r.wallet !== wallet.toLowerCase()) throw new UserFacingError("I couldn't find that request. Ask me again.", 404);
  if (r.status !== "pending") throw new UserFacingError(r.status === "expired" ? "That request expired. Ask me again." : "That request was already sent.", 409);
  if ((deps.now?.() ?? Date.now()) > r.expiresAt) {
    r.status = "expired";
    throw new UserFacingError("That request expired. Ask me again.", 410);
  }
  if (typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature)) throw new UserFacingError("That signature isn't valid. Please try signing again.", 400);
  let signer: string;
  try {
    signer = ethers.verifyTypedData(r.domain, SAFE_TX_TYPES, r.message, signature);
  } catch {
    throw new UserFacingError("That signature isn't valid. Please try signing again.", 400);
  }
  if (signer.toLowerCase() !== r.wallet) throw new UserFacingError("That signature isn't from your wallet. Sign with the wallet you signed in with.", 401);

  // The relayer pays this one's gas too (ORC-31): over today's allowance, it isn't sent and stays pending.
  await (deps.gasBudget ?? assertGasBudget)(r.safeAddress);
  // Re-checked after that wait: a second submit that arrived meanwhile mustn't send it again.
  if (r.status !== "pending") throw new UserFacingError("That request was already sent.", 409);
  r.status = "executing"; // claimed before anything is sent: a double submit can't send twice
  try {
    const txHash = await deps.relay(r, signature);
    r.status = "executed";
    const explorerUrl = `https://sepolia.etherscan.io/tx/${txHash}`;
    // Only after the relay returned a hash we got ourselves (never one the client reports).
    try {
      await recordActivity(r.wallet, spendActivity({ valueUsd: r.valueUsd, to: r.to, token: r.token, txHash, explorerUrl, source: "owner" }));
    } catch (e) {
      console.warn(`[owner-sign] sent, but couldn't record activity: ${safeErr(e)}`);
    }
    // A plan's next send is held only now, so its nonce is the one after this send's.
    if (r.rest?.length) {
      try {
        return { txHash, explorerUrl, next: await (deps.holdNext ?? holdNextSend)(r) };
      } catch (e) {
        console.warn(`[owner-sign] sent, but couldn't hold the next send: ${safeErr(e)}`);
        return { txHash, explorerUrl, nextError: NEXT_SEND_FAILED_TEXT };
      }
    }
    return { txHash, explorerUrl };
  } catch (err) {
    r.status = "pending"; // a repeat after a failure can't double-send: the Safe's nonce moves once, so a second run reverts
    throw err;
  }
}

/** Relay a held transaction with the owner's signature; the agent key only pays gas. */
export async function relayWithAgent(r: OwnerSignRecord, signature: string): Promise<string> {
  const agentKey = process.env.AGENT_PRIVATE_KEY;
  if (!agentKey) throw new Error("AGENT_PRIVATE_KEY not set");
  const wallet = new ethers.Wallet(agentKey, makeSepoliaProvider());
  const safe = new ethers.Contract(r.safeAddress, EXEC_ABI, wallet);
  const m = r.message;
  const args = [m.to, m.value, m.data, m.operation, m.safeTxGas, m.baseGas, m.gasPrice, m.gasToken, m.refundReceiver, signature] as const;
  const nonce = BigInt(await safe.nonce());
  if (nonce !== BigInt(m.nonce)) throw new UserFacingError("Your account has made another transaction since, so this one is out of date. Ask me again.", 409);
  const gasLimit = await safeGasLimit(() => safe.execTransaction.estimateGas(...args));
  const tx = await safe.execTransaction(...args, gasLimit ? { gasLimit } : {});
  const receipt = await tx.wait();
  await noteRelayerGas({ account: r.safeAddress, kind: "owner-sign", txHash: tx.hash, receipt, wallet: r.wallet }); // ORC-31
  if (receipt && Number(receipt.status) === 0) {
    throw new UserFacingError(`This didn't go through, so your funds were not moved. You can see what happened here: https://sepolia.etherscan.io/tx/${tx.hash}`);
  }
  return tx.hash;
}

/** Test hook: forget every held request. */
export function clearOwnerSignRecords(): void {
  records.clear();
}
