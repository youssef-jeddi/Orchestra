import * as crypto from 'crypto';
import { Action } from '../../../types/agents';
import { ActionPlan, TransactionStep } from '../../../types/storage';
import { append } from '../../../integrations/zero-g/storage';

const writeActionPlan: Action = {
  name: 'writeActionPlan',
  description: 'Writes a fully specified ActionPlan to 0G Storage',
  parameters: [
    { name: 'intent', type: 'string', description: 'Human-readable summary of what this plan does', required: true },
    { name: 'steps', type: 'array', description: 'Array of TransactionStep objects, each with: protocol, action, params, estimatedGasWei, order', required: true },
    { name: 'totalEstimatedValueUsd', type: 'number', description: 'Total estimated value of the plan in USD', required: true },
    { name: 'flagId', type: 'string', description: 'ID of the flag that triggered this plan (if any)', required: false },
  ],
  handler: async (args: Record<string, unknown>): Promise<string> => {
    const intent = args.intent as string;
    const steps = (args.steps as TransactionStep[]) || [];
    const totalEstimatedValueUsd = (args.totalEstimatedValueUsd as number) || 0;
    const flagId = (args.flagId as string) || 'user-message';
    const now = new Date().toISOString();

    const plan: ActionPlan = {
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

    await append('plans', plan);
    return `ActionPlan written: ${plan.id}`;
  },
};

export default writeActionPlan;
