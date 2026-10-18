// ─── Safe — automatic onboarding: one deployment per wallet, rate-limited ───
// Every wallet's account is deployed at sign-in with gas paid by the agent wallet,
// so this is the only place that decides *whether* the agent may spend that gas.
// Pure and injectable (clock, deploy function) so the rules are tested without network.

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

  constructor(private limits: OnboardingLimits = DEFAULT_ONBOARDING_LIMITS, private now: () => number = Date.now) {}

  /** Takes one slot, or throws a 429 saying when to come back. */
  acquire(ip: string): void {
    const t = this.now();
    const fresh = (xs: number[]) => xs.filter((x) => t - x < this.limits.windowMs);
    this.global = fresh(this.global);
    const mine = fresh(this.byIp.get(ip) ?? []);
    if (mine.length) this.byIp.set(ip, mine); else this.byIp.delete(ip);

    const full = (xs: number[], max: number) => xs.length >= max ? Math.ceil((xs[0] + this.limits.windowMs - t) / 60_000) : 0;
    const waitIp = full(mine, this.limits.perIpPerWindow);
    const waitAll = full(this.global, this.limits.globalPerWindow);
    if (waitIp) throw new OnboardingError(429, `You've set up several accounts from this connection recently. Try again in ${waitIp} minute${waitIp === 1 ? "" : "s"}.`, "onboarding_rate_limited");
    if (waitAll) throw new OnboardingError(429, `Lots of people are signing up right now. Try again in ${waitAll} minute${waitAll === 1 ? "" : "s"}.`, "onboarding_rate_limited");

    this.global.push(t);
    this.byIp.set(ip, [...mine, t]);
  }
}

export type OnboardingState = "ready" | "deploying" | "failed" | "not_started";
export interface OnboardingStatus {
  status: OnboardingState;
  safeAddress: string;
  /** True when this call is the one that started a deployment. */
  started?: boolean;
  error?: string;
}

/** Longest one deployment may take (≈7 Sepolia transactions); past it the job fails so the queue moves on. */
export const DEPLOY_TIMEOUT_MS = Number(process.env.ONBOARD_DEPLOY_TIMEOUT_MS) || 600_000;

interface Job { safeAddress: string; failed?: string }

/**
 * One deployment per wallet. Repeated or concurrent starts join the running job; a wallet
 * that already has an account is never deployed again; the agent's transactions for
 * different wallets run one after another so they can't race on the agent's nonce.
 */
export class OnboardingQueue {
  private jobs = new Map<string, Job>();
  private deciding = new Map<string, Promise<OnboardingStatus>>();
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private deps: {
    /** The account address if the wallet already has a deployed or stored one, else null. */
    existing: (wallet: string) => Promise<string | null>;
    predict: (wallet: string) => Promise<string>;
    /**
     * `isCancelled()` turns true once the job timed out: the deploy must check it before each
     * transaction it is about to send and stop, so an abandoned job can't keep sending while
     * the next one runs. A transaction already sent may still confirm later; ethers takes the
     * pending nonce for the next send, so it queues behind it instead of replacing it.
     */
    deploy: (wallet: string, isCancelled: () => boolean) => Promise<void>;
    limiter: OnboardingLimiter;
    timeoutMs?: number;
  }) {}

  /** Starts (or joins) the wallet's deployment. Returns at once; poll `status` for the outcome. */
  start(wallet: string, ip: string): Promise<OnboardingStatus> {
    const key = wallet.toLowerCase();
    const job = this.jobs.get(key);
    if (job && !job.failed) return Promise.resolve({ status: "deploying", safeAddress: job.safeAddress });
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
      ? { status: "failed", safeAddress: job.safeAddress, error: job.failed }
      : { status: "deploying", safeAddress: job.safeAddress };
    const existing = await this.deps.existing(wallet);
    if (existing) return { status: "ready", safeAddress: existing };
    return { status: "not_started", safeAddress: await this.deps.predict(wallet) };
  }

  private async decide(key: string, wallet: string, ip: string): Promise<OnboardingStatus> {
    const job = this.jobs.get(key);
    if (job && !job.failed) return { status: "deploying", safeAddress: job.safeAddress };
    const existing = await this.deps.existing(wallet);
    if (existing) {
      this.jobs.delete(key);
      return { status: "ready", safeAddress: existing };
    }
    this.deps.limiter.acquire(ip); // throws 429; a failed job stays so the error remains visible
    const safeAddress = await this.deps.predict(wallet);
    const fresh: Job = { safeAddress };
    this.jobs.set(key, fresh);
    const run = this.tail.then(() => this.withTimeout(wallet));
    this.tail = run.catch(() => {});
    run.then(
      () => { if (this.jobs.get(key) === fresh) this.jobs.delete(key); },
      (err) => {
        console.error(`[onboard] Deployment failed for ${wallet}:`, err?.message);
        fresh.failed = "We couldn't finish setting up your account. Please try again.";
      },
    );
    return { status: "deploying", safeAddress, started: true };
  }

  /** Runs one deployment, failing it if it takes longer than the timeout (a transaction that never confirms). */
  private async withTimeout(wallet: string): Promise<void> {
    let cancelled = false;
    let timer: NodeJS.Timeout | undefined;
    const limit = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { cancelled = true; reject(new Error("deployment timed out")); }, this.deps.timeoutMs ?? DEPLOY_TIMEOUT_MS);
      timer.unref(); // never keeps the process alive on its own
    });
    try {
      await Promise.race([this.deps.deploy(wallet, () => cancelled), limit]);
    } finally {
      clearTimeout(timer);
    }
  }
}
