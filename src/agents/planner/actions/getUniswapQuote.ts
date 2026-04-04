import { Action } from '../../../types/agents';

const getUniswapQuote: Action = {
  name: 'getUniswapQuote',
  description: 'Gets a real swap quote from the Uniswap routing API',
  parameters: [
    { name: 'tokenIn', type: 'string', description: 'Input token contract address', required: true },
    { name: 'tokenOut', type: 'string', description: 'Output token contract address', required: true },
    { name: 'amount', type: 'string', description: 'Amount of tokenIn in its smallest unit (wei)', required: true },
    { name: 'chain', type: 'string', description: 'Chain ID (defaults to 1 for Ethereum mainnet)', required: false },
  ],
  handler: async (args: Record<string, unknown>): Promise<string> => {
    const apiKey = process.env.UNISWAP_API_KEY;
    if (!apiKey) {
      throw new Error('Missing required env var: UNISWAP_API_KEY');
    }

    const tokenIn = args.tokenIn as string;
    const tokenOut = args.tokenOut as string;
    const amount = args.amount as string;
    const chainId = Number(args.chain) || 1;

    const res = await fetch('https://trade-api.gateway.uniswap.org/v1/quote', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
      },
      body: JSON.stringify({
        tokenInChainId: chainId,
        tokenOutChainId: chainId,
        tokenIn,
        tokenOut,
        amount,
        type: 'EXACT_INPUT',
      }),
    });

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Uniswap API error ${res.status}: ${errBody}`);
    }

    const data = await res.json();
    return JSON.stringify(data);
  },
};

export default getUniswapQuote;
