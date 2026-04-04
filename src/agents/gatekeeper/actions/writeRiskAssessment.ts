import * as crypto from 'crypto';
import { Action } from '../../../types/agents';
import { RiskAssessment, Verdict } from '../../../types/storage';
import { append } from '../../../integrations/zero-g/storage';

const validVerdicts = Object.values(Verdict) as string[];

const defaultRiskScores: Record<string, number> = {
  [Verdict.AUTO_EXECUTE]: 10,
  [Verdict.NEEDS_APPROVAL]: 70,
  [Verdict.BLOCKED]: 100,
};

const writeRiskAssessment: Action = {
  name: 'writeRiskAssessment',
  description: 'Writes a risk assessment verdict for an action plan to 0G Storage',
  parameters: [
    { name: 'planId', type: 'string', description: 'ID of the action plan being assessed', required: true },
    { name: 'verdict', type: 'string', description: `Verdict: ${validVerdicts.join(', ')}`, required: true },
    { name: 'reason', type: 'string', description: 'Reason for the verdict', required: true },
    { name: 'riskScore', type: 'number', description: 'Risk score 0-100 (optional, defaults based on verdict)', required: false },
  ],
  handler: async (args: Record<string, unknown>): Promise<string> => {
    const planId = args.planId as string;
    const verdictStr = args.verdict as string;
    const reason = args.reason as string;

    if (!validVerdicts.includes(verdictStr)) {
      throw new Error(`Invalid verdict "${verdictStr}". Valid: ${validVerdicts.join(', ')}`);
    }

    const verdict = verdictStr as Verdict;
    const riskScore = (args.riskScore as number) ?? defaultRiskScores[verdict] ?? 50;

    const assessment: RiskAssessment = {
      id: crypto.randomUUID(),
      planId,
      verdict,
      reasons: [reason],
      riskScore,
      requiresLedger: verdict === Verdict.NEEDS_APPROVAL,
      assessedAt: new Date().toISOString(),
    };

    await append('assessments', assessment);
    return `RiskAssessment written: ${verdict} for plan ${planId}`;
  },
};

export default writeRiskAssessment;
