import { ethers } from 'ethers';
import { Action } from '../../../types/agents';

const estimateGas: Action = {
  name: 'estimateGas',
  description: 'Estimates gas for a transaction via RPC',
  parameters: [
    { name: 'to', type: 'string', description: 'Destination address', required: true },
    { name: 'value', type: 'string', description: 'Value in wei (optional)', required: false },
    { name: 'data', type: 'string', description: 'Transaction calldata (optional)', required: false },
  ],
  handler: async (args: Record<string, unknown>): Promise<string> => {
    const rpcUrl = process.env.RPC_URL;
    if (!rpcUrl) {
      throw new Error('Missing required env var: RPC_URL');
    }

    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const tx: Record<string, string> = { to: args.to as string };
    if (args.value) tx.value = args.value as string;
    if (args.data) tx.data = args.data as string;

    const estimate = await provider.estimateGas(tx);
    return JSON.stringify({ gasEstimate: Number(estimate), unit: 'wei' });
  },
};

export default estimateGas;
