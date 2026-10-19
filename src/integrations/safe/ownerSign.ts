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
  expiresAt: number;
  status: "pending" | "executing" | "executed" | "expired";
}

const records = new Map<string, OwnerSignRecord>();

/** The EIP-712 hash of a Safe transaction on this account (what the owner's wallet signs). */
export function safeTxHashOf(domain: OwnerSignRecord["domain"], message: OwnerSignRecord["message"]): string {
  return ethers.TypedDataEncoder.hash(domain, SAFE_TX_TYPES, message);
}

/** What the frontend gets: enough to ask the wallet for a signature, nothing it could swap. */
export function ownerSignView(r: OwnerSignRecord) {
  return {
    kind: "safe-owner" as const,
    id: r.id,
    summary: r.summary,
    safeTxHash: r.safeTxHash,
    expiresAt: r.expiresAt,
    typedData: { domain: r.domain, types: SAFE_TX_TYPES, primaryType: "SafeTx", message: r.message },
  };
}

/** Store the Safe transaction for `call` (a fresh nonce read) and return the offer to sign it. */
export function holdOwnerSign(input: { wallet: string; safeAddress: string; summary: string; call: SafeCall & { nonce: number } }, now = Date.now()): OwnerSignRecord {
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
    expiresAt: now + OWNER_SIGN_TTL_MS, status: "pending",
  };
  records.set(record.id, record);
  return record;
}

/** Build and hold the offer for a batch the module refused. */
export async function offerOwnerSign(wallet: string, safeAddress: string, summary: string, batch: Array<{ to: string; value: string; data: string }>) {
  const call = await safeCallFor(safeAddress, batch);
  return ownerSignView(holdOwnerSign({ wallet, safeAddress, summary, call }));
}

export interface OwnerSignDeps {
  /** Send the stored transaction with the owner's signature; returns the tx hash. */
  relay: (r: OwnerSignRecord, signature: string) => Promise<string>;
  now?: () => number;
}

/**
 * Submit the owner's signature for a held transaction. Only the wallet it was held for may submit;
 * the signature must be that wallet's over the stored hash; it runs at most once.
 */
export async function submitOwnerSignature(wallet: string, id: unknown, signature: unknown, deps: OwnerSignDeps): Promise<{ txHash: string; explorerUrl: string }> {
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

  r.status = "executing"; // claimed before anything is sent: a double submit can't send twice
  try {
    const txHash = await deps.relay(r, signature);
    r.status = "executed";
    return { txHash, explorerUrl: `https://sepolia.etherscan.io/tx/${txHash}` };
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
  if (receipt && Number(receipt.status) === 0) {
    throw new UserFacingError(`This didn't go through, so your funds were not moved. You can see what happened here: https://sepolia.etherscan.io/tx/${tx.hash}`);
  }
  return tx.hash;
}

/** Test hook: forget every held request. */
export function clearOwnerSignRecords(): void {
  records.clear();
}
