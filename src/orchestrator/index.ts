import { write, read, readMany, append, clear } from '../integrations/zero-g/storage';
import { runWatcher } from '../agents/watcher/index';
import { runPlanner } from '../agents/planner/index';
import { runGatekeeper } from '../agents/gatekeeper/index';

interface OrchestratorConfig {
  watcherIntervalMs: number;
  pollIntervalMs: number;
}

const DEFAULT_CONFIG: OrchestratorConfig = {
  watcherIntervalMs: 300_000, // 5 minutes
  pollIntervalMs: 5_000,      // 5 seconds
};

// ── Executor stub (real implementation in Step 8) ──────────────────────
async function executePlan(assessment: Record<string, unknown>): Promise<void> {
  const planId = assessment.planId as string;
  const assessmentId = assessment.id as string;

  console.log(`[Executor] Executing plan ${planId} — stub, real execution in Step 8`);

  await append('results', {
    planId,
    executedAt: new Date().toISOString(),
    status: 'executed_stub',
    txHash: null,
  });

  await append('assessments', {
    ...assessment,
    executed: true,
  });
}

// ── Orchestrator ───────────────────────────────────────────────────────
export class Orchestrator {
  private config: OrchestratorConfig;
  private isRunning: boolean;
  private lastWatcherRun: number;
  private timer: ReturnType<typeof setTimeout> | null;

  constructor(config?: Partial<OrchestratorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.isRunning = false;
    this.lastWatcherRun = 0;
    this.timer = null;
  }

  // ── Public API ─────────────────────────────────────────────────────

  start(): void {
    this.isRunning = true;
    console.log('[Orchestrator] Starting...');
    this.scheduleNext(0); // tick immediately
  }

  stop(): void {
    this.isRunning = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    console.log('[Orchestrator] Stopped');
  }

  async runOnce(): Promise<void> {
    await this.tick();
  }

  // ── Internal ───────────────────────────────────────────────────────

  private scheduleNext(delayMs: number): void {
    this.timer = setTimeout(async () => {
      if (!this.isRunning) return;
      await this.tick();
      if (this.isRunning) {
        this.scheduleNext(this.config.pollIntervalMs);
      }
    }, delayMs);
  }

  private async tick(): Promise<void> {
    let plannerTriggered = false;

    // 1. Watcher check
    try {
      if (Date.now() - this.lastWatcherRun > this.config.watcherIntervalMs) {
        console.log('[Orchestrator] Running Watcher...');
        await runWatcher();
        this.lastWatcherRun = Date.now();
        console.log('[Orchestrator] Watcher run complete');
      }
    } catch (err) {
      console.error('[Orchestrator] Watcher error:', err);
    }

    // 2. New user message check
    try {
      const msg = (await read('messages:latest')) as Record<string, unknown> | null;
      if (msg && msg.message && msg.timestamp) {
        const ts = new Date(msg.timestamp as string).getTime();
        if (Date.now() - ts < 60_000) {
          console.log('[Orchestrator] Planner triggered by user message');
          await runPlanner(msg.message as string);
          await write('messages:latest', { message: null, timestamp: null });
          plannerTriggered = true;
        }
      }
    } catch (err) {
      console.error('[Orchestrator] User message check error:', err);
    }

    // 3. Pending flags check (skip if planner already triggered)
    if (!plannerTriggered) {
      try {
        const flags = (await readMany('flags')) as Record<string, unknown>[];
        const oneHourAgo = Date.now() - 3_600_000;
        const pending = flags.filter((f) => {
          if (f.processed !== false) return false;
          const created = new Date(f.createdAt as string).getTime();
          return created > oneHourAgo;
        });

        if (pending.length > 0) {
          console.log(`[Orchestrator] Planner triggered by ${pending.length} pending flags`);
          await runPlanner();
          plannerTriggered = true;
        }
      } catch (err) {
        console.error('[Orchestrator] Flags check error:', err);
      }
    }

    // 4. Pending plans check → Gatekeeper
    try {
      const plans = (await readMany('plans')) as Record<string, unknown>[];
      const oneHourAgo = Date.now() - 3_600_000;
      const pending = plans.filter((p) => {
        if (p.status !== 'pending') return false;
        const created = new Date(p.createdAt as string).getTime();
        return created > oneHourAgo;
      });

      if (pending.length > 0) {
        console.log(`[Orchestrator] Gatekeeper triggered by ${pending.length} pending plans`);
        await runGatekeeper();
        console.log('[Orchestrator] Gatekeeper run complete');
      }
    } catch (err) {
      console.error('[Orchestrator] Plans check error:', err);
    }

    // 5. AUTO_EXECUTE verdicts → Executor stub
    try {
      const assessments = (await readMany('assessments')) as Record<string, unknown>[];
      const autoExec = assessments.filter(
        (a) => a.verdict === 'AUTO_EXECUTE' && a.executed !== true
      );

      for (const assessment of autoExec) {
        console.log(`[Orchestrator] AUTO_EXECUTE: plan ${assessment.planId}`);
        await executePlan(assessment);
      }
    } catch (err) {
      console.error('[Orchestrator] AUTO_EXECUTE check error:', err);
    }

    // 6. NEEDS_APPROVAL verdicts → Ledger approval
    try {
      const assessments = (await readMany('assessments')) as Record<string, unknown>[];
      const needsApproval = assessments.filter(
        (a) => a.verdict === 'NEEDS_APPROVAL' && a.ledgerTriggered !== true
      );

      for (const assessment of needsApproval) {
        const planId = assessment.planId as string;
        const assessmentId = assessment.id as string;

        await write('ledger:pending', {
          planId,
          requestedAt: new Date().toISOString(),
          status: 'waiting',
        });

        await write('assessments:' + assessmentId, {
          ...assessment,
          ledgerTriggered: true,
        });

        console.log(`[Orchestrator] Ledger approval triggered for plan ${planId}`);
      }
    } catch (err) {
      console.error('[Orchestrator] NEEDS_APPROVAL check error:', err);
    }
  }
}

const orchestrator = new Orchestrator();
export default orchestrator;
