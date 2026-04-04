import { Action } from '../../../types/agents';
import { read } from '../../../integrations/zero-g/storage';

const DEFAULT_TOKENS = [
  { symbol: 'ETH', address: '0x0000000000000000000000000000000000000000', verified: true },
  { symbol: 'WETH', address: '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14', verified: true },
  { symbol: 'USDC', address: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238', verified: true },
  { symbol: 'USDT', address: '0xaA8E23Fb1079EA71e0a56F48a2aA51851D8433D0', verified: true },
  { symbol: 'WBTC', address: '0x29f2D40B0605204364af54EC677bD022dA425d03', verified: true },
];

const checkTokenVerification: Action = {
  name: 'checkTokenVerification',
  description: 'Checks if a token is verified in the token registry',
  parameters: [
    { name: 'token', type: 'string', description: 'Token symbol or contract address to check', required: true },
  ],
  handler: async (args: Record<string, unknown>): Promise<string> => {
    const token = (args.token as string).toUpperCase();
    const registry = await read('registry:tokens');
    const tokens = (registry as Array<{ symbol: string; address: string; verified: boolean }>) || DEFAULT_TOKENS;

    const match = tokens.find(
      (t) => t.symbol.toUpperCase() === token || t.address.toLowerCase() === token.toLowerCase()
    );

    if (match && match.verified) {
      return JSON.stringify({ token, verified: true, reason: `${match.symbol} is a verified token` });
    }
    return JSON.stringify({ token, verified: false, reason: `${token} is not in the verified token registry` });
  },
};

export default checkTokenVerification;
