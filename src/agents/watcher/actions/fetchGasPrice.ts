import { ethers } from 'ethers';
import { Action } from '../../../types/agents';

const fetchGasPrice: Action = {
  name: 'fetchGasPrice',
  description: 'Fetches the current Ethereum gas price from RPC',
  parameters: [],
  handler: async (): Promise<string> => {
    const rpcUrl = process.env.RPC_URL;
    if (!rpcUrl) {
      throw new Error('Missing required env var: RPC_URL');
    }

    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const rawGasPrice = await provider.send('eth_gasPrice', []);
    console.log('[fetchGasPrice] Raw RPC response:', rawGasPrice);

    const wei = parseInt(rawGasPrice, 16);
    if (isNaN(wei) || wei === 0) {
      throw new Error(`Invalid gas price from RPC: ${rawGasPrice}`);
    }

    const gwei = Math.round((wei / 1e9) * 100) / 100;
    return `Current gas price: ${gwei} gwei`;
  },
};

export default fetchGasPrice;
