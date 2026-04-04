import { ethers } from 'ethers';
import { Action } from '../../../types/agents';

const resolveENS: Action = {
  name: 'resolveENS',
  description: 'Resolves an ENS name to an Ethereum address',
  parameters: [
    { name: 'name', type: 'string', description: 'ENS name to resolve (e.g. vitalik.eth)', required: true },
  ],
  handler: async (args: Record<string, unknown>): Promise<string> => {
    const name = (args.ensName ?? args.name) as string;
    if (!name) {
      throw new Error('resolveENS: name argument is required');
    }
    const provider = new ethers.JsonRpcProvider('https://cloudflare-eth.com');
    const address = await provider.resolveName(name);

    if (!address) {
      throw new Error(`Could not resolve ENS name: ${name}`);
    }

    return JSON.stringify({ name, address });
  },
};

export default resolveENS;
