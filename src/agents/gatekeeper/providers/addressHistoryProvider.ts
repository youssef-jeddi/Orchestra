import { Provider } from '../../../types/agents';
import { read, write } from '../../../integrations/zero-g/storage';

const addressHistoryProvider: Provider = {
  name: 'addressHistoryProvider',
  description: 'Reads known address history from 0G Storage',
  handler: async (): Promise<string> => {
    const history = await read('history:addresses');
    if (history) {
      return JSON.stringify(history);
    }

    // Seed default entry with user's own wallet address so self-transfers aren't flagged
    const profile = (await read('user:profile')) as Record<string, unknown> | null;
    const walletAddress = profile?.address as string | undefined;

    if (walletAddress) {
      const defaultHistory = [
        { address: walletAddress, transactionCount: 0, firstSeen: new Date().toISOString() },
      ];
      await write('history:addresses', defaultHistory);
      return JSON.stringify(defaultHistory);
    }

    return JSON.stringify([]);
  },
};

export default addressHistoryProvider;
