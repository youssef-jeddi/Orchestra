// ─── Bridge — whose address a signed-in user may ask about ───
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
