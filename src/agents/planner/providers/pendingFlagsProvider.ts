import { Provider } from '../../../types/agents';
import { readMany } from '../../../integrations/zero-g/storage';

const pendingFlagsProvider: Provider = {
  name: 'pendingFlagsProvider',
  description: 'Reads all unprocessed flags from 0G Storage',
  handler: async (): Promise<string> => {
    const allFlags = await readMany('flags');
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    const pending = allFlags.filter((f) => {
      const flag = f as Record<string, unknown>;
      if (flag.processed !== false) return false;
      const createdAt = flag.createdAt as string | undefined;
      if (createdAt && new Date(createdAt).getTime() < oneHourAgo) return false;
      return true;
    });
    return JSON.stringify(pending);
  },
};

export default pendingFlagsProvider;
