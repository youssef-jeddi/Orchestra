// ─── Bridge — whose address, approval and signed transaction a signed-in user may use ───
// A session proves one wallet. Routes that take an address (balances, nonce, quote) must not let
// that session read or act for anyone else: the address has to be the session's wallet or the
// account (Safe) that wallet owns. Pure and injectable (the Safe lookup) so it is tested without network.

import { ethers } from "ethers";
import type { Response } from "express";

/** Does `address` belong to `wallet`: the wallet itself, or the Safe recorded for it? */
export async function isOwnAddress(
  wallet: string,
  address: unknown,
  safeOf: (wallet: string) => Promise<string | null>,
): Promise<boolean> {
  if (typeof address !== "string" || !ethers.isAddress(address)) return false;
  const a = address.toLowerCase();
  if (a === wallet.toLowerCase()) return true;
  const safe = await safeOf(wallet);
  return !!safe && safe.toLowerCase() === a;
}

/** Sends the 400/403 and returns false unless `address` is a valid address that belongs to the session's wallet. */
export async function requireOwnAddress(
  res: Response,
  address: unknown,
  safeOf: (wallet: string) => Promise<string | null>,
): Promise<boolean> {
  if (typeof address !== "string" || !ethers.isAddress(address)) {
    res.status(400).json({ error: "That isn't a valid address." });
    return false;
  }
  if (await isOwnAddress(res.locals.wallet, address, safeOf)) return true;
  res.status(403).json({ error: "That address isn't yours. You can only use your own account.", code: "not_your_address" });
  return false;
}

/** For routes that read one wallet's data: no `wallet` asked for means the session's; asking for another's is a 403. */
export function requireOwnWallet(res: Response, asked: unknown): boolean {
  if (asked === undefined || asked === "") return true;
  if (typeof asked === "string" && asked.toLowerCase() === String(res.locals.wallet).toLowerCase()) return true;
  res.status(403).json({ error: "That address isn't yours. You can only use your own account.", code: "not_your_address" });
  return false;
}

/** An approval is only visible to the wallet it was made for (callers answer 404, as for an unknown id). */
export function approvalBelongsTo(approval: { wallet: string }, wallet: string): boolean {
  return approval.wallet.toLowerCase() === wallet.toLowerCase();
}

/**
 * Why a raw transaction can't be broadcast for `wallet`, or null if it can: it must be a signed
 * transaction whose sender is that wallet. Without this any signed-in user could relay anyone's
 * signed transaction through our RPC. Every transaction sent here is signed by the user's own
 * wallet (Ledger); Safe actions go out from that wallet and the agent never uses this route.
 */
export function broadcastSenderProblem(signedTx: unknown, wallet: string): { status: 400 | 403; error: string; code?: string } | null {
  let from: string | null = null;
  try {
    if (typeof signedTx === "string") {
      const tx = ethers.Transaction.from(signedTx); // recovers the sender from the signature
      from = tx.signature ? tx.from : null;
    }
  } catch { /* not a transaction */ }
  if (!from) return { status: 400, error: "That isn't a signed transaction." };
  if (from.toLowerCase() !== wallet.toLowerCase()) {
    return { status: 403, error: "That transaction wasn't signed by your wallet.", code: "not_your_address" };
  }
  return null;
}
