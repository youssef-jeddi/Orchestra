import 'dotenv/config';
import { write, append, read, readMany, clear } from '../integrations/zero-g/storage';
import { Orchestrator } from '../orchestrator/index';

async function main() {
  const orchestrator = new Orchestrator({
    watcherIntervalMs: 0,   // force Watcher to run on first tick
    pollIntervalMs: 5_000,
  });

  // ── Clean slate ────────────────────────────────────────────────────
  console.log('\n=== CLEARING STORAGE ===');
  await clear();

  // ── Seed portfolio + previous prices ───────────────────────────────
  console.log('\n=== SEEDING DATA ===');
  await write('portfolio:current', {
    eth: 2.5,
    usdc: 1000,
    wbtc: 0.1,
    updatedAt: new Date().toISOString(),
  });

  await write('prices:previous', {
    eth: 3500,
    usdc: 1.0,
    wbtc: 65000,
    fetchedAt: new Date(Date.now() - 3_600_000).toISOString(),
  });

  // ── Seed user message ──────────────────────────────────────────────
  const userMessage = 'send 50 USDC to 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
  await write('messages:latest', {
    message: userMessage,
    timestamp: new Date().toISOString(),
  });
  console.log(`Seeded user message: "${userMessage}"`);

  // ── Tick 1: Watcher + user message → Planner ──────────────────────
  console.log('\n========================================');
  console.log('TICK 1: Watcher + user message → Planner');
  console.log('========================================');
  await orchestrator.runOnce();

  // ── Tick 2: pending plan → Gatekeeper ──────────────────────────────
  console.log('\n========================================');
  console.log('TICK 2: pending plan → Gatekeeper');
  console.log('========================================');
  await orchestrator.runOnce();

  // ── Tick 3: verdict → Executor stub ────────────────────────────────
  console.log('\n========================================');
  console.log('TICK 3: verdict → Executor stub');
  console.log('========================================');
  await orchestrator.runOnce();

  // ── Pipeline summary ───────────────────────────────────────────────
  console.log('\n========================================');
  console.log('PIPELINE SUMMARY');
  console.log('========================================');

  const flags = (await readMany('flags')) as Record<string, unknown>[];
  console.log(`\nFlags written by Watcher: ${flags.length}`);
  for (const f of flags) {
    console.log(`  - [${f.type}] ${f.summary ?? 'no summary'}`);
  }

  const plans = (await readMany('plans')) as Record<string, unknown>[];
  console.log(`\nPlans written by Planner: ${plans.length}`);
  for (const p of plans) {
    console.log(`  - [${p.status}] ${p.summary ?? 'no summary'} ($${p.totalEstimatedValueUsd})`);
  }

  const assessments = (await readMany('assessments')) as Record<string, unknown>[];
  console.log(`\nAssessments written by Gatekeeper: ${assessments.length}`);
  for (const a of assessments) {
    console.log(`  - [${a.verdict}] plan=${a.planId} score=${a.riskScore} executed=${a.executed ?? false}`);
  }

  const results = (await readMany('results')) as Record<string, unknown>[];
  console.log(`\nExecution results: ${results.length}`);
  for (const r of results) {
    console.log(`  - [${r.status}] plan=${r.planId} tx=${r.txHash ?? 'none'}`);
  }

  // ── PASS / FAIL ────────────────────────────────────────────────────
  console.log('\n========================================');
  const hasPlans = plans.length > 0;
  const hasAssessments = assessments.length > 0;
  const hasExecOrApproval = results.length > 0 ||
    assessments.some((a) => a.ledgerTriggered === true);

  if (hasPlans && hasAssessments && hasExecOrApproval) {
    console.log('RESULT: PASS — full pipeline completed');
  } else {
    const reasons: string[] = [];
    if (!hasPlans) reasons.push('no plans written');
    if (!hasAssessments) reasons.push('no assessments written');
    if (!hasExecOrApproval) reasons.push('no execution or ledger approval');
    console.log(`RESULT: FAIL — ${reasons.join(', ')}`);
  }
  console.log('========================================');
}

main().catch(console.error);
