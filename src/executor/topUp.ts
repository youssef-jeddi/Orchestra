// ─── Executor — top-ups: the one thing a passkey-gated Privy wallet may sign itself ───
// A user who signed in with email or a social account may fund their own account from their
// built-in wallet once they hold a passkey; everything that leaves their control needs the
// passkey. A top-up is exactly: ETH sent to the user's own account, or a plain transfer of a
// supported token to it. The account address is the server's (from the session), never from the
// request, and any other shape (approve, transferFrom, a transfer to someone else, extra data)
// is refused, so a "top-up" can't be used to move money out.

import { ethers } from "ethers";
import { WETH_SEPOLIA, USDC_SEPOLIA } from "../integrations/uniswap/types";

export const TOP_UP_TOKENS = [WETH_SEPOLIA, USDC_SEPOLIA].map((a) => a.toLowerCase());
const transferIface = new ethers.Interface(["function transfer(address to, uint256 amount)"]);

export interface TopUpTx { to: string; data?: string; value?: string | number | bigint }

/** True only for a deposit into `safeAddress` itself: ETH, or `transfer(safeAddress, n)` on a supported token. */
export function isTopUpToOwnAccount(tx: TopUpTx, safeAddress: string): boolean {
  if (!ethers.isAddress(safeAddress) || typeof tx?.to !== "string" || !ethers.isAddress(tx.to)) return false;
  const safe = safeAddress.toLowerCase();
  const data = (tx.data ?? "0x").toLowerCase();
  let value: bigint;
  try { value = BigInt(tx.value ?? 0); } catch { return false; }
  if (tx.to.toLowerCase() === safe) return data === "0x"; // ETH to the account (no call data)
  if (!TOP_UP_TOKENS.includes(tx.to.toLowerCase()) || value !== 0n) return false;
  try {
    const parsed = transferIface.parseTransaction({ data });
    if (parsed?.name !== "transfer" || data.length !== 2 + 8 + 64 * 2) return false; // exactly transfer(to, amount)
    return String(parsed.args[0]).toLowerCase() === safe;
  } catch {
    return false;
  }
}
