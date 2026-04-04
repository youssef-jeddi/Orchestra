import 'dotenv/config';
import * as crypto from 'crypto';
import { write, append, read, readMany, clear } from '../integrations/zero-g/storage';
import { runGatekeeper } from '../agents/gatekeeper/index';

function makePlan(overrides: Record<string, unknown>) {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    flagId: 'test',
    summary: 'test plan',
    steps: [],
    totalEstimatedValueUsd: 0,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

async function main() {
  // ========== SCENARIO A: Low risk plan (AUTO_EXECUTE) ==========
  console.log('\n=== CLEARING STORAGE ===');
  await clear();

  console.log('\n========================================');
  console.log('SCENARIO A: Low risk plan (AUTO_EXECUTE expected)');
  console.log('========================================');

  const planA = makePlan({ totalEstimatedValueUsd: 50, summary: 'execute pending transfers while gas is low' });
  console.log(`\nSeeding plan: $${planA.totalEstimatedValueUsd}, ${(planA.steps as unknown[]).length} steps`);
  await append('plans', planA);

  console.log('\n=== RUNNING GATEKEEPER (Scenario A) ===');
  const resultA = await runGatekeeper();
  console.log('\nGatekeeper result A:', JSON.stringify(resultA, null, 2));

  const assessmentsA = await readMany('assessments');
  console.log(`Assessments after A: ${assessmentsA.length}`);
  for (const a of assessmentsA) {
    const ass = a as Record<string, unknown>;
    console.log(`  - [${ass.verdict}] ${(ass.reasons as string[])?.[0] ?? 'no reason'} (plan: ${ass.planId})`);
  }

  // ========== SCENARIO B: High value plan (NEEDS_APPROVAL) ==========
  console.log('\n=== CLEARING STORAGE ===');
  await clear();

  console.log('\n========================================');
  console.log('SCENARIO B: High value plan (NEEDS_APPROVAL expected)');
  console.log('========================================');

  const planB = makePlan({ totalEstimatedValueUsd: 500, summary: 'send 500 USDC to external address' });
  console.log(`\nSeeding plan: $${planB.totalEstimatedValueUsd}, ${(planB.steps as unknown[]).length} steps`);
  await append('plans', planB);

  console.log('\n=== RUNNING GATEKEEPER (Scenario B) ===');
  const resultB = await runGatekeeper();
  console.log('\nGatekeeper result B:', JSON.stringify(resultB, null, 2));

  const assessmentsB = await readMany('assessments');
  console.log(`Assessments after B: ${assessmentsB.length}`);
  for (const a of assessmentsB) {
    const ass = a as Record<string, unknown>;
    console.log(`  - [${ass.verdict}] ${(ass.reasons as string[])?.[0] ?? 'no reason'} (plan: ${ass.planId})`);
  }

  const ledgerPending = await read('ledger:pending');
  console.log('\nLedger pending:', ledgerPending ? JSON.stringify(ledgerPending, null, 2) : 'none');

  // ========== SCENARIO C: No pending plans (no-op) ==========
  console.log('\n=== CLEARING STORAGE ===');
  await clear();

  console.log('\n========================================');
  console.log('SCENARIO C: No pending plans (no-op expected)');
  console.log('========================================');

  console.log('\n=== RUNNING GATEKEEPER (Scenario C) ===');
  const resultC = await runGatekeeper();
  console.log('\nGatekeeper result C:', JSON.stringify(resultC, null, 2));

  const assessmentsC = await readMany('assessments');
  console.log(`Assessments after C: ${assessmentsC.length} (should be 0)`);

  console.log('\n✅ Gatekeeper test complete');
}

main().catch(console.error);
