import { Action } from '../../../types/agents';
import { read } from '../../../integrations/zero-g/storage';

const readFromStorage: Action = {
  name: 'readFromStorage',
  description: 'Reads a value from 0G Storage by key',
  parameters: [
    { name: 'key', type: 'string', description: 'The storage key to read', required: true },
  ],
  handler: async (args: Record<string, unknown>): Promise<string> => {
    const key = args.key as string;
    const result = await read(key);
    return JSON.stringify(result);
  },
};

export default readFromStorage;
