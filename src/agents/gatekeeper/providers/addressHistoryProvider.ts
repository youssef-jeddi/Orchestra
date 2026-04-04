import { Provider } from '../../../types/agents';
import { read } from '../../../integrations/zero-g/storage';

const addressHistoryProvider: Provider = {
  name: 'addressHistoryProvider',
  description: 'Reads known address history from 0G Storage',
  handler: async (): Promise<string> => {
    const history = await read('history:addresses');
    if (!history) {
      return JSON.stringify([]);
    }
    return JSON.stringify(history);
  },
};

export default addressHistoryProvider;
