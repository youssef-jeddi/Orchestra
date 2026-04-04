import { ethers } from 'ethers';
import { Provider } from '../../../types/agents';

const gasPriceProvider: Provider = {
  name: 'gasPriceProvider',
  description: 'Fetches current Ethereum gas price from RPC',
  handler: async (): Promise<string> => {
    const rpcUrl = process.env.RPC_URL;
    if (!rpcUrl) {
      throw new Error('Missing required env var: RPC_URL');
    }

    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const rawGasPrice = await provider.send('eth_gasPrice', []);
    console.log('[gasPriceProvider] Raw RPC response:', rawGasPrice);

    const wei = parseInt(rawGasPrice, 16);
    if (isNaN(wei) || wei === 0) {
      throw new Error(`Invalid gas price from RPC: ${rawGasPrice}`);
    }

    const gwei = Math.round((wei / 1e9) * 100) / 100;
    return JSON.stringify({ gasPrice: gwei, unit: 'gwei' });
  },
};

export default gasPriceProvider;
