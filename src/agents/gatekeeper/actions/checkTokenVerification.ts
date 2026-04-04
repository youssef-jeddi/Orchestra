import { Action } from '../../../types/agents';
import { read } from '../../../integrations/zero-g/storage';

const DEFAULT_TOKENS = [
  { symbol: 'ETH', address: '0x0000000000000000000000000000000000000000', verified: true },
  { symbol: 'USDC', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', verified: true },
  { symbol: 'USDT', address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', verified: true },
  { symbol: 'WBTC', address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', verified: true },
  { symbol: 'WETH', address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', verified: true },
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
