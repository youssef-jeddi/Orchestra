import 'dotenv/config';
import * as crypto from 'crypto';
import { write, append, readMany, clear } from '../integrations/zero-g/storage';
import { runPlanner } from '../agents/planner/index';

async function main() {
  console.log('\n=== CLEARING STORAGE ===');
  await clear();

  // ========== SCENARIO A: User message triggers planning ==========
  console.log('\n========================================');
  console.log('SCENARIO A: User message triggers planning');
  console.log('========================================');

  // Seed user message
  console.log('\n=== SEED: Writing user message ===');
  const userMessage = { message: 'send 10 USDC to 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', timestamp: new Date().toISOString() };
  console.log('Message:', userMessage);
  await write('messages:latest', userMessage);

  // Seed portfolio if needed
  console.log('\n=== SEED: Writing portfolio ===');
  const portfolio = { eth: 2.5, usdc: 1000, wbtc: 0.1 };
  await write('portfolio:current', portfolio);

  // Run planner
  console.log('\n=== RUNNING PLANNER (Scenario A) ===');
  const resultA = await runPlanner();
  console.log('\nPlanner result A:', JSON.stringify(resultA, null, 2));

  // Read plans
  console.log('\n=== READING PLANS (after Scenario A) ===');
  const plansA = await readMany('plans');
  console.log(`Plans after A: ${plansA.length}`);
  for (const p of plansA) {
    const plan = p as Record<string, unknown>;
    console.log(`  - [${plan.id}] ${plan.summary} (status: ${plan.status})`);
  }

  // ========== SCENARIO B: Watcher flag triggers planning ==========
  console.log('\n========================================');
  console.log('SCENARIO B: Watcher flag triggers planning');
  console.log('========================================');

  // Clear user message
  console.log('\n=== SEED: Clearing user message ===');
  await write('messages:latest', { message: null, timestamp: null });

  // Seed a real unprocessed flag
  console.log('\n=== SEED: Writing GAS_SPIKE flag ===');
  const flag = {
    id: crypto.randomUUID(),
    type: 'GAS_SPIKE',
    source: 'watcher',
    summary: 'Gas is at 8 gwei — good time to transact',
    data: { gasPrice: 8 },
    processed: false,
    createdAt: new Date().toISOString(),
  };
  await append('flags', flag);

  // Run planner
  console.log('\n=== RUNNING PLANNER (Scenario B) ===');
  const resultB = await runPlanner();
  console.log('\nPlanner result B:', JSON.stringify(resultB, null, 2));

  // Read all plans
  console.log('\n=== READING ALL PLANS ===');
  const plansAll = await readMany('plans');
  console.log(`\nTotal plans written: ${plansAll.length}`);
  for (const p of plansAll) {
    const plan = p as Record<string, unknown>;
    console.log(`  - [${plan.id}] ${plan.summary} (status: ${plan.status}, flagId: ${plan.flagId})`);
  }

  console.log('\n✅ Planner test complete');
}

main().catch(console.error);
