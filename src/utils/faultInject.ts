// ─── Utils — dev-only fault injection ───
// Lets a developer make the limit reads fail or hang to see how the app behaves when storage is
// down (ORCHESTRA_FAULT_INJECT=profile-read,activity-read,profile-timeout,activity-timeout).
// `execute` makes an account action fail with a raw, internal-looking error right before it runs
// (nothing executes), to check the user only ever sees a plain sentence.
// `price-read` makes the price refresh fail; `price-stale` makes the cached prices count as too old
// (checked by pricesUsable), to see that spends are refused when no fresh price exists.
// `remaining-zero` makes the on-chain daily ceiling read as $0 left today, so a small send hits the
// over-cap / owner-sign path without needing ~$1000 of Sepolia ETH (see remainingToday).
// `killswitch-read` makes the global kill-switch flag unreadable (the bridge then starts paused);
// `activity-write` makes saving a spend record fail (that wallet's automatic actions then pause).
// `owner-sign-tamper` makes an over-cap offer hold an addOwnerWithThreshold on the account instead
// of the payment (what a hacked bridge could do), to see /simple refuse to sign it (ORC-113).
// `gas-over-budget` makes every account's network fee allowance read as used up for today, so the
// refusal can be seen without spending gas; `gas-read` makes that allowance unreadable (ORC-31).
// Never usable in production: ignored unless NODE_ENV isn't "production" and the storage is local
// or in memory, and the bridge refuses to start with it set in production (faultInjectProblem).

export type Fault = "profile-read" | "activity-read" | "profile-timeout" | "activity-timeout" | "execute" | "price-read" | "price-stale" | "remaining-zero" | "killswitch-read" | "activity-write" | "owner-sign-tamper" | "gas-over-budget" | "gas-read";

const FAULTS: readonly string[] = ["profile-read", "activity-read", "profile-timeout", "activity-timeout", "execute", "price-read", "price-stale", "remaining-zero", "killswitch-read", "activity-write", "owner-sign-tamper", "gas-over-budget", "gas-read"];

function requested(env: NodeJS.ProcessEnv): string[] {
  return (env.ORCHESTRA_FAULT_INJECT ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

/** Why the bridge must not start, or null. Setting it in production is a mistake worth stopping for. */
export function faultInjectProblem(env: NodeJS.ProcessEnv = process.env): string | null {
  if (requested(env).length === 0) return null;
  if (env.NODE_ENV === "production") return "ORCHESTRA_FAULT_INJECT is set while NODE_ENV=production. It is for local testing only: unset it.";
  const unknown = requested(env).filter((f) => !FAULTS.includes(f));
  return unknown.length ? `ORCHESTRA_FAULT_INJECT has unknown value(s): ${unknown.join(", ")}. Use ${FAULTS.join(", ")}.` : null;
}

/** Is this fault switched on? Always false in production or on 0G storage, whatever the variable says. */
export function faultOn(fault: Fault, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NODE_ENV === "production") return false;
  if ((env.STORAGE_BACKEND || "file").trim().toLowerCase() === "0g") return false;
  return requested(env).includes(fault);
}

/** Throws or hangs where a read would, when the fault is on. */
export async function injectFault(fault: Fault): Promise<void> {
  if (!faultOn(fault)) return;
  if (fault.endsWith("-timeout")) return new Promise<void>(() => {}); // never answers: the caller's timeout fires
  if (fault === "execute") throw new Error("injected fault: execute (rpc https://rpc.internal.example/v3/SECRETKEY)");
  throw new Error(`injected fault: ${fault}`);
}
