// ─── Safe — automatic onboarding: one deployment per wallet, rate-limited, finished step by step ───
// Every wallet's account is deployed at sign-in with gas paid by the agent wallet,
// so this is the only place that decides *whether* the agent may spend that gas. "Ready" means
// every setup step is done (setupSteps.ts); an account whose later steps failed is finished by
// the next start, which runs only what is missing and never deploys twice.
// Pure and injectable (clock, deploy function) so the rules are tested without network.

import { type SetupInspection, type SetupStep, type SetupSteps, isSetupComplete, needsDeployment, remainingSteps } from "./setupSteps";
import { shortAddr, safeErr } from "../../utils/redact";

export class OnboardingError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}

export interface OnboardingLimits {
  /** New deployments the agent pays for, across all users, per window. */
  globalPerWindow: number;
  /** New deployments started from one IP address per window. */
  perIpPerWindow: number;
  windowMs: number;
}

// Sizing: a deployment is ~7 Sepolia transactions (a few cents of testnet ETH, ~0.01 ETH at
// worst). 20/hour caps the agent's spend at ~0.2 ETH/hour even if someone scripts fresh wallets;
// 3/hour per IP is plenty for a person (a retry or two) and stops one machine using the whole budget.
export const DEFAULT_ONBOARDING_LIMITS: OnboardingLimits = {
  globalPerWindow: Number(process.env.ONBOARD_MAX_PER_HOUR) || 20,
  perIpPerWindow: Number(process.env.ONBOARD_MAX_PER_IP_PER_HOUR) || 3,
  windowMs: 3_600_000,
};

/** Sliding-window caps on new deployments (global and per IP). Failed attempts count: they spent gas too. */
export class OnboardingLimiter {
  private global: number[] = [];
  private byIp = new Map<string, number[]>();

  constructor(
    private limits: OnboardingLimits = DEFAULT_ONBOARDING_LIMITS,
    private now: () => number = Date.now,
    private perKeyMessage = (wait: string) => `You've set up several accounts from this connection recently. Try again in ${wait}.`,
  ) {}

  /** Takes one slot, or throws a 429 saying when to come back. `ip` is whatever the per-key cap is keyed by. */
  acquire(ip: string): void {
    const t = this.now();
    const fresh = (xs: number[]) => xs.filter((x) => t - x < this.limits.windowMs);
    this.global = fresh(this.global);
    const mine = fresh(this.byIp.get(ip) ?? []);
    if (mine.length) this.byIp.set(ip, mine); else this.byIp.delete(ip);

    const full = (xs: number[], max: number) => xs.length >= max ? Math.ceil((xs[0] + this.limits.windowMs - t) / 60_000) : 0;
    const waitIp = full(mine, this.limits.perIpPerWindow);
    const waitAll = full(this.global, this.limits.globalPerWindow);
    if (waitIp) throw new OnboardingError(429, this.perKeyMessage(`${waitIp} minute${waitIp === 1 ? "" : "s"}`), "onboarding_rate_limited");
    if (waitAll) throw new OnboardingError(429, `Lots of people are signing up right now. Try again in ${waitAll} minute${waitAll === 1 ? "" : "s"}.`, "onboarding_rate_limited");

    this.global.push(t);
    this.byIp.set(ip, [...mine, t]);
  }
}

// Finishing an account that is already deployed costs the agent a few transactions, not a
// deployment, so it doesn't use the deployment budget above (a user whose setup stopped partway
// must be able to finish). It has its own caps so a step that keeps failing, or a script that
// keeps asking, can't make the agent pay without limit: per account and across all accounts.
export const DEFAULT_COMPLETION_LIMITS: OnboardingLimits = {
  globalPerWindow: Number(process.env.ONBOARD_MAX_RESUMES_PER_HOUR) || 60,
  perIpPerWindow: Number(process.env.ONBOARD_MAX_RESUMES_PER_ACCOUNT_PER_HOUR) || 4,
  windowMs: 3_600_000,
};
const completionMessage = (wait: string) => `We're still finishing your account setup. Try again in ${wait}.`;

export type OnboardingState = "ready" | "deploying" | "failed" | "not_started";
export interface OnboardingStatus {
  status: OnboardingState;
  safeAddress: string;
  /** True when this call is the one that started a run (a deployment, or finishing the missing steps). */
  started?: boolean;
  /** The run only finishes steps of an account that was already deployed (the UI says "finishing", not "setting up"). */
  resumed?: boolean;
  error?: string;
  /** With `error`: `setup_pending` means an earlier transaction may still confirm; nothing was sent again. */
  errorCode?: string;
  /** Which setup steps are done (when known): "ready" only when all are. */
  steps?: SetupSteps;
  remaining?: SetupStep[];
}

/** Longest one deployment may take (≈7 Sepolia transactions); past it the job fails so the queue moves on. */
export const DEPLOY_TIMEOUT_MS = Number(process.env.ONBOARD_DEPLOY_TIMEOUT_MS) || 600_000;

interface Job { safeAddress: string; resumed: boolean; failed?: string; failedCode?: string }

/**
 * One deployment per wallet. Repeated or concurrent starts join the running job; a wallet
 * whose account is fully set up is never touched again; one whose later steps failed is finished
 * (only the missing steps, no second deployment); the agent's transactions for different
 * wallets run one after another so they can't race on the agent's nonce.
 */
export class OnboardingQueue {
  private jobs = new Map<string, Job>();
  private deciding = new Map<string, Promise<OnboardingStatus>>();
  private tail: Promise<unknown> = Promise.resolve();
  private completions: OnboardingLimiter;

  constructor(private deps: {
    /** The account's address and which setup steps are done, read from the chain (and our records). */
    inspect: (wallet: string) => Promise<SetupInspection>;
    /**
     * Runs the steps `inspect` reports missing, and only those. `isCancelled()` turns true once
     * the job timed out: it must check it before each transaction it is about to send and stop,
     * so an abandoned job can't keep sending while the next one runs. A transaction already sent
     * may still confirm later; ethers takes the pending nonce for the next send, so it queues
     * behind it instead of replacing it.
     */
    finish: (wallet: string, isCancelled: () => boolean) => Promise<void>;
    /** Caps new deployments (per IP, global). */
    limiter: OnboardingLimiter;
    /** Caps runs that only finish a deployed account (per account, global). */
    completionLimiter?: OnboardingLimiter;
    timeoutMs?: number;
  }) {
    this.completions = deps.completionLimiter ?? new OnboardingLimiter(DEFAULT_COMPLETION_LIMITS, Date.now, completionMessage);
  }

  /** Starts (or joins) the wallet's setup. Returns at once; poll `status` for the outcome. */
  start(wallet: string, ip: string): Promise<OnboardingStatus> {
    const key = wallet.toLowerCase();
    const job = this.jobs.get(key);
    if (job && !job.failed) return Promise.resolve({ status: "deploying", safeAddress: job.safeAddress, ...(job.resumed ? { resumed: true } : {}) });
    const joined = this.deciding.get(key);
    if (joined) return joined.then(({ started: _, ...rest }) => rest);
    const pending = this.decide(key, wallet, ip).finally(() => this.deciding.delete(key));
    this.deciding.set(key, pending);
    return pending;
  }

  /** Where the wallet's account stands, without starting anything. */
  async status(wallet: string): Promise<OnboardingStatus> {
    const key = wallet.toLowerCase();
    const job = this.jobs.get(key);
    if (job) return job.failed
      ? { status: "failed", safeAddress: job.safeAddress, error: job.failed, ...(job.failedCode ? { errorCode: job.failedCode } : {}), ...(await this.stepsOf(wallet)) }
      : { status: "deploying", safeAddress: job.safeAddress, ...(job.resumed ? { resumed: true } : {}) };
    const found = await this.deps.inspect(wallet);
    return isSetupComplete(found.steps)
      ? { status: "ready", safeAddress: found.safeAddress, ...describeSteps(found.steps) }
      : { status: "not_started", safeAddress: found.safeAddress, ...describeSteps(found.steps) };
  }

  /** The steps for a failed job; a chain read that fails here must not hide the failure itself. */
  private async stepsOf(wallet: string): Promise<{ steps?: SetupSteps; remaining?: SetupStep[] }> {
    try { return describeSteps((await this.deps.inspect(wallet)).steps); } catch { return {}; }
  }

  private async decide(key: string, wallet: string, ip: string): Promise<OnboardingStatus> {
    const job = this.jobs.get(key);
    if (job && !job.failed) return { status: "deploying", safeAddress: job.safeAddress, ...(job.resumed ? { resumed: true } : {}) };
    const found = await this.deps.inspect(wallet);
    if (isSetupComplete(found.steps)) {
      this.jobs.delete(key);
      return { status: "ready", safeAddress: found.safeAddress, ...describeSteps(found.steps) };
    }
    // A new deployment uses the deployment budget; finishing an account that already exists uses
    // the (separate, per-account) completion budget. A failed job stays so the error remains visible.
    const resumed = !needsDeployment(found.steps);
    if (resumed) this.completions.acquire(key); else this.deps.limiter.acquire(ip); // throws 429
    const safeAddress = found.safeAddress;
    const fresh: Job = { safeAddress, resumed };
    this.jobs.set(key, fresh);
    const run = this.tail.then(() => this.withTimeout(wallet));
    this.tail = run.catch(() => {});
    run.then(
      () => { if (this.jobs.get(key) === fresh) this.jobs.delete(key); },
      (err) => {
        console.error(`[onboard] Setup failed for ${shortAddr(wallet)}: ${safeErr(err)}`);
        // Our own plain sentences (e.g. "still finishing") are shown as they are; anything else is not.
        fresh.failed = err instanceof OnboardingError ? err.message : "We couldn't finish setting up your account. Please try again.";
        if (err instanceof OnboardingError && err.code) fresh.failedCode = err.code;
      },
    );
    return { status: "deploying", safeAddress, started: true, ...(resumed ? { resumed: true } : {}), remaining: remainingSteps(found.steps) };
  }

  /** Runs one setup, failing it if it takes longer than the timeout (a transaction that never confirms). */
  private async withTimeout(wallet: string): Promise<void> {
    let cancelled = false;
    let timer: NodeJS.Timeout | undefined;
    const limit = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { cancelled = true; reject(new Error("deployment timed out")); }, this.deps.timeoutMs ?? DEPLOY_TIMEOUT_MS);
      timer.unref(); // never keeps the process alive on its own
    });
    try {
      await Promise.race([this.deps.finish(wallet, () => cancelled), limit]);
    } finally {
      clearTimeout(timer);
    }
  }
}

const describeSteps = (steps: SetupSteps) => ({ steps, remaining: remainingSteps(steps) });

/**
 * May the agent act for this wallet's account? Only when every setup step is done. Anything
 * unknown (a failed chain read, a running or failed setup) counts as not ready.
 */
export async function accountReady(queue: Pick<OnboardingQueue, "status">, wallet: string): Promise<boolean> {
  try { return (await queue.status(wallet)).status === "ready"; } catch { return false; }
}

export const ACCOUNT_NOT_READY_REASON = "Your account isn't fully set up yet, so I can't do that right now. Give it a minute and try again.";
