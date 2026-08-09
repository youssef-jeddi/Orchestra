import * as crypto from 'crypto';
import { Action } from '../../../types/agents';
import { ActionPlan, TransactionStep } from '../../../types/storage';
import { append } from '../../../integrations/zero-g/storage';

/**
 * Build a fully-specified ActionPlan from raw LLM args. Pure (aside from a fresh
 * uuid/timestamp) so the /intent pipeline can reconstruct the plan in-process from
 * the Planner's return value — no 0G read-back required.
 */
export function buildActionPlan(args: Record<string, unknown>): ActionPlan {
  const intent = args.intent as string;
  const steps = (args.steps as TransactionStep[]) || [];
  const totalEstimatedValueUsd = (args.totalEstimatedValueUsd as number) || 0;
  const flagId = (args.flagId as string) || 'user-message';
  const now = new Date().toISOString();

  return {
    id: crypto.randomUUID(),
    flagId,
    summary: intent,
    steps: steps.map((s, i) => ({
      protocol: s.protocol || 'unknown',
      action: s.action || 'unknown',
      params: s.params || {},
      estimatedGasWei: s.estimatedGasWei || '0',
      order: s.order ?? i,
    })),
    totalEstimatedValueUsd,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
  };
}

const writeActionPlan: Action = {
  name: 'writeActionPlan',
  description: 'Writes a fully specified ActionPlan to 0G Storage',
  parameters: [
    { name: 'intent', type: 'string', description: 'Human-readable summary of what this plan does', required: true },
    { name: 'steps', type: 'array', description: 'Array of TransactionStep objects, each with: protocol, action, params, estimatedGasWei, order', required: true },
    { name: 'totalEstimatedValueUsd', type: 'number', description: 'Set to 0 — the server values the plan from step params using live prices', required: false },
    { name: 'flagId', type: 'string', description: 'ID of the flag that triggered this plan (if any)', required: false },
  ],
  handler: async (args: Record<string, unknown>): Promise<string> => {
    const plan = buildActionPlan(args);
    await append('plans', plan);
    return `ActionPlan written: ${plan.id}`;
  },
};

export default writeActionPlan;
