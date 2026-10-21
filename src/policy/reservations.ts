// ─── Policy — one automatic decision at a time per wallet (ORC-40 fix B) ───
// A spend is recorded only after its transaction went through, which takes seconds. Two requests
// arriving together used to both read the same "spent today" and both run on their own, together
// going over the daily limit. Now the verdict is taken one request at a time per wallet, from the
// latest recorded history plus every automatic spend still in progress (a reservation), and the
// reservation is held until the caller releases it (after the spend is recorded, or it failed).
// The lock covers only the decision, not the transaction, so a wallet's requests aren't queued
// behind each other's network calls. Single bridge process, like the activity cache (store.ts).

import type { ActivityRecord } from "./index";

const reserved = new Map<string, ActivityRecord[]>();
const locks = new Map<string, Promise<unknown>>();

export interface Reserved<D> {
  decision: D;
  /** Drop the reservation (idempotent). Call once the spend is recorded or didn't happen. */
  release: () => void;
}

/**
 * Decide with `decideFn(history)`, where history is `readHistory()` plus the wallet's spends still
 * in progress. An AUTO_EXECUTE verdict reserves `valueUsd` until `release()`. Without a wallet
 * nothing can run, so there is nothing to reserve. A `readHistory` that throws rejects: no verdict.
 */
export async function decideWithReservation<D extends { verdict: string }>(
  wallet: string | undefined,
  valueUsd: number,
  readHistory: () => Promise<ActivityRecord[] | undefined>,
  decideFn: (history: ActivityRecord[] | undefined) => D,
  now: () => number = Date.now,
): Promise<Reserved<D>> {
  if (!wallet) return { decision: decideFn(await readHistory()), release: () => {} };
  const key = wallet.toLowerCase();
  const run = (locks.get(key) ?? Promise.resolve()).catch(() => {}).then(async (): Promise<Reserved<D>> => {
    const history = await readHistory();
    const pending = reserved.get(key) ?? [];
    const decision = decideFn(pending.length ? [...(history ?? []), ...pending] : history);
    if (decision.verdict !== "AUTO_EXECUTE") return { decision, release: () => {} };
    const rec: ActivityRecord = { valueUsd, at: new Date(now()).toISOString(), source: "auto" };
    reserved.set(key, [...pending, rec]);
    let done = false;
    return {
      decision,
      release: () => {
        if (done) return;
        done = true;
        const left = (reserved.get(key) ?? []).filter((r) => r !== rec);
        if (left.length) reserved.set(key, left);
        else reserved.delete(key);
      },
    };
  });
  locks.set(key, run);
  run.finally(() => { if (locks.get(key) === run) locks.delete(key); }).catch(() => {});
  return run;
}

/** Spends in progress for a wallet (tests and logs). */
export function reservedFor(wallet: string): ActivityRecord[] {
  return [...(reserved.get(wallet.toLowerCase()) ?? [])];
}

/** Test hook. */
export function _resetReservations(): void {
  reserved.clear();
  locks.clear();
}
