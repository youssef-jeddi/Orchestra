// ─── Safe — account setup steps: which are done, which remain ───
// Setting up an account is a deployment, a registration with OrchestraPolicy and our own
// records. Any of them can fail after the earlier ones succeeded, so "ready" means every step is
// done, and a retry runs only the steps still missing. Pure and injectable so it is tested without network.

export const SETUP_STEPS = ["deploy", "register", "record"] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];
export type SetupSteps = Record<SetupStep, boolean>;

/** What a status check found: the account's address and which steps are done. */
export interface SetupInspection {
  safeAddress: string;
  steps: SetupSteps;
  /**
   * A finished account that isn't registered on the registry this server now uses (it was set up
   * before the registry was configured or replaced). It stays ready: the registry is a record, it
   * doesn't gate spending, so the registration is done in the background at the next sign-in.
   */
  registrationPending?: boolean;
}

/** The steps still to do, in the order they must run. Later steps need the earlier ones. */
export function remainingSteps(steps: SetupSteps): SetupStep[] {
  return SETUP_STEPS.filter((s) => !steps[s]);
}

export const isSetupComplete = (steps: SetupSteps) => remainingSteps(steps).length === 0;

/** Does the account itself need deploying? Only then does a run count as a new deployment. */
export const needsDeployment = (steps: SetupSteps) => !steps.deploy;

export const allStepsDone = (): SetupSteps => ({ deploy: true, register: true, record: true });

/** What the chain and our records say about one account; `deriveSteps` turns it into the step states. */
export interface SetupFacts {
  /** Code exists at the predicted address. */
  hasCode: boolean;
  /** OrchestraPolicy is configured for this server; without it there is nothing to register. */
  policyConfigured: boolean;
  /** Registered on the configured registry: our record says so for that registry, or the registry has an entry for this account. */
  registered: boolean;
  /** Our stored account record and profile are written. */
  recorded: boolean;
}

/**
 * Step states from facts. Nothing after "deploy" can be done on an account that has no code yet,
 * whatever local flags say: the chain is the source of truth.
 */
export function deriveSteps(f: SetupFacts): SetupSteps {
  if (!f.hasCode) return { deploy: false, register: false, record: false };
  return {
    deploy: true,
    register: !f.policyConfigured || f.registered,
    record: f.recorded,
  };
}

/**
 * Finish the account: read what is done, then run only the missing steps in order. `isCancelled`
 * is checked before each step so a timed-out run stops before its next transaction. Never deploys
 * when the account already exists, and never touches the address.
 */
export async function finishSetup(
  inspect: () => Promise<SetupInspection>,
  run: Record<SetupStep, () => Promise<void>>,
  isCancelled: () => boolean,
): Promise<SetupStep[]> {
  const { steps } = await inspect();
  const ran: SetupStep[] = [];
  for (const step of remainingSteps(steps)) {
    if (isCancelled()) throw new Error("deployment timed out");
    await run[step]();
    ran.push(step);
  }
  return ran;
}
