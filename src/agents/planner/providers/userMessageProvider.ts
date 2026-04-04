import { Provider } from '../../../types/agents';
import { read } from '../../../integrations/zero-g/storage';

const userMessageProvider: Provider = {
  name: 'userMessageProvider',
  description: 'Reads the latest user message from 0G Storage',
  handler: async (): Promise<string> => {
    const data = await read('messages:latest');
    if (!data) {
      return JSON.stringify({ message: null, timestamp: null });
    }
    return JSON.stringify(data);
  },
};

export default userMessageProvider;
