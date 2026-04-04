import { RiskAssessment, ActionPlan, Verdict } from '../types/storage';
import { executeViaSafe } from '../integrations/safe/transaction';
import { getAgentWallet } from '../integrations/safe/agentWallet';
import { logTradeResult } from './logResult';
import { ethers } from 'ethers';

const SEPOLIA_RPC = process.env.SEPOLIA_RPC_URL || 'https://eth-sepolia.g.alchemy.com/v2/demo';

export async function executePlan(
  assessment: RiskAssessment,
  plan: ActionPlan,
  safeAddress: string,
  quoteData?: any,
  ledgerSignerKey?: string
): Promise<string> {
  const step = plan.steps[0];
  if (!step) throw new Error('Plan has no steps');

  // Build transaction from plan step or quoteData
  const to = quoteData?.quote?.methodParameters?.to
    || (step.params as any).to
    || '';
  const value = quoteData?.quote?.methodParameters?.value
    || (step.params as any).value
    || '0';
  const data = quoteData?.quote?.methodParameters?.calldata
    || (step.params as any).calldata
    || (step.params as any).data
    || '0x';

  if (!to) throw new Error('No target address in plan step');

  console.log(`[Executor] Executing via Safe: ${safeAddress}`);
  console.log(`[Executor]   verdict: ${assessment.verdict}`);
  console.log(`[Executor]   to: ${to}`);
  console.log(`[Executor]   value: ${value}`);

  let txHash: string;

  if (assessment.verdict === Verdict.AUTO_EXECUTE) {
    // Agent hot wallet signs through Safe
    const agentKey = process.env.AGENT_PRIVATE_KEY;
    if (!agentKey) throw new Error('AGENT_PRIVATE_KEY not set for auto-execute');

    console.log('[Executor] AUTO_EXECUTE — signing with agent wallet');
    txHash = await executeViaSafe(safeAddress, agentKey, to, value, data);
  } else if (ledgerSignerKey) {
    // Ledger-signed path (after user approved on device)
    console.log('[Executor] NEEDS_APPROVAL — signing with Ledger key');
    txHash = await executeViaSafe(safeAddress, ledgerSignerKey, to, value, data);
  } else {
    throw new Error('NEEDS_APPROVAL verdict but no Ledger signer provided');
  }

  console.log(`[Executor] Transaction hash: ${txHash}`);

  // Log to 0G Storage
  await logTradeResult(plan.id, txHash, 'success');

  return txHash;
}
