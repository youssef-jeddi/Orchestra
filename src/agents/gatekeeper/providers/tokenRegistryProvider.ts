import { Provider } from '../../../types/agents';
import { read } from '../../../integrations/zero-g/storage';

const DEFAULT_TOKENS = [
  { symbol: 'ETH', address: '0x0000000000000000000000000000000000000000', verified: true },
  { symbol: 'WETH', address: '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14', verified: true },
  { symbol: 'USDC', address: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238', verified: true },
  { symbol: 'USDT', address: '0xaA8E23Fb1079EA71e0a56F48a2aA51851D8433D0', verified: true },
  { symbol: 'WBTC', address: '0x29f2D40B0605204364af54EC677bD022dA425d03', verified: true },
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
