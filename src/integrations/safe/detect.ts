// ─── Safe — find the account a wallet owns, without writing anything ───
// /intent needs the account address even when storage was lost (in-memory storage after a restart).
// The address is deterministic, so it is predicted and checked for code. Read-only on purpose:
// an account that is deployed but not finished (module, allowances, registration still to do) is
// found here too, and must not be recorded as the user's own. `safe:<wallet>` is written only by
// the last setup step (accountRecord.ts), and no limit is read from anywhere: another account's
// registry entry can't leak into this one.

import Safe from '@safe-global/protocol-kit';
import { read } from '../zero-g/storage';
import { getAgentAddress } from './agentWallet';
import { predictedSafeConfig } from './deploy';
import { makeSepoliaProvider, sepoliaRpcUrl } from '../../utils/rpc';
import { shortAddr, safeErr } from "../../utils/redact";

/** Everything detection reads; injected so the rules are tested without network. */
export interface DetectReads {
  /** The account recorded for the wallet (`safe:<wallet>`), if any. */
  storedAccount(wallet: string): Promise<string | null>;
  /** The wallet's deterministic account address. */
  predict(wallet: string): Promise<string>;
  hasCode(address: string): Promise<boolean>;
}

const CACHE_TTL_MS = 60_000;
const found = new Map<string, { address: string; expires: number }>();

/**
 * The wallet's account address if it exists: the stored one, else the predicted one when it has
 * code. Only a positive answer is remembered (briefly, so a chat doesn't redo the chain reads on
 * every message); "not found" is asked again so a deployment is noticed at once.
 */
export async function detectWith(reads: DetectReads, wallet: string, now = Date.now()): Promise<string | null> {
  const key = wallet.toLowerCase();
  const stored = await reads.storedAccount(key);
  if (stored) return stored;
  const hit = found.get(key);
  if (hit && hit.expires > now) return hit.address;
  const predicted = await reads.predict(wallet);
  if (!(await reads.hasCode(predicted))) return null;
  found.set(key, { address: predicted, expires: now + CACHE_TTL_MS });
  return predicted;
}

/** Test hook — forget remembered detections. */
export function _resetDetectCache(): void {
  found.clear();
}

const realReads: DetectReads = {
  storedAccount: async (wallet) => ((await read(`safe:${wallet}`)) as { safeAddress?: string } | null)?.safeAddress ?? null,
  predict: async (wallet) => (await Safe.init({
    provider: sepoliaRpcUrl(),
    predictedSafe: predictedSafeConfig(wallet, getAgentAddress()),
  })).getAddress(),
  hasCode: async (address) => (await makeSepoliaProvider().getCode(address)) !== '0x',
};

export async function detectExistingSafe(ledgerAddress: string): Promise<string | null> {
  try {
    const address = await detectWith(realReads, ledgerAddress);
    if (address) console.log(`[Safe] Found account for ${shortAddr(ledgerAddress)}: ${shortAddr(address)}`);
    return address;
  } catch (err: any) {
    console.warn(`[Safe] Account detection failed: ${safeErr(err)}`);
    return null;
  }
}
