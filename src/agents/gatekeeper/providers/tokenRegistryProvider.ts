import { Provider } from '../../../types/agents';
import { read } from '../../../integrations/zero-g/storage';

const DEFAULT_TOKENS = [
  { symbol: 'ETH', address: '0x0000000000000000000000000000000000000000', verified: true },
  { symbol: 'USDC', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', verified: true },
  { symbol: 'USDT', address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', verified: true },
  { symbol: 'WBTC', address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', verified: true },
  { symbol: 'WETH', address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', verified: true },
];

const tokenRegistryProvider: Provider = {
  name: 'tokenRegistryProvider',
  description: 'Reads the verified token registry from 0G Storage',
  handler: async (): Promise<string> => {
    const registry = await read('registry:tokens');
    if (!registry) {
      return JSON.stringify(DEFAULT_TOKENS);
    }
    return JSON.stringify(registry);
  },
};

export default tokenRegistryProvider;
