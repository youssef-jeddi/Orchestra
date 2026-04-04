import { Action } from '../../../types/agents';
import { read } from '../../../integrations/zero-g/storage';

const checkAddressHistory: Action = {
  name: 'checkAddressHistory',
  description: 'Checks if an address is known in the user address history',
  parameters: [
    { name: 'address', type: 'string', description: 'Ethereum address to check', required: true },
  ],
  handler: async (args: Record<string, unknown>): Promise<string> => {
    const address = (args.address as string).toLowerCase();
    const history = await read('history:addresses');
    const entries = (history as Array<{ address: string; transactionCount: number; firstSeen: string }>) || [];

    const match = entries.find((e) => e.address.toLowerCase() === address);

    if (match) {
      return JSON.stringify({
        address,
        known: true,
        transactionCount: match.transactionCount,
        firstSeen: match.firstSeen,
      });
    }
    return JSON.stringify({ address, known: false, transactionCount: 0, firstSeen: null });
  },
};

export default checkAddressHistory;
