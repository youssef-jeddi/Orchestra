import { Provider } from '../../../types/agents';
import { readMany } from '../../../integrations/zero-g/storage';

const pendingPlansProvider: Provider = {
  name: 'pendingPlansProvider',
  description: 'Reads all pending action plans from 0G Storage (recent only)',
  handler: async (): Promise<string> => {
    const allPlans = await readMany('plans');
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    const pending = allPlans.filter((p) => {
      const plan = p as Record<string, unknown>;
      if (plan.status !== 'pending') return false;
      const createdAt = plan.createdAt as string | undefined;
      if (createdAt && new Date(createdAt).getTime() < oneHourAgo) return false;
      return true;
    });
    return JSON.stringify(pending);
  },
};

export default pendingPlansProvider;
