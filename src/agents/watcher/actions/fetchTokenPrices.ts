import { Action } from '../../../types/agents';

const fetchTokenPrices: Action = {
  name: 'fetchTokenPrices',
  description: 'Fetches current ETH and BTC prices in USD from CoinGecko',
  parameters: [],
  handler: async (): Promise<string> => {
    const url = 'https://api.coingecko.com/api/v3/simple/price?ids=ethereum,bitcoin&vs_currencies=usd';
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`CoinGecko API returned ${res.status}: ${res.statusText}`);
    }

    const data = await res.json() as { ethereum?: { usd: number }; bitcoin?: { usd: number } };
    if (!data.ethereum || !data.bitcoin) {
      throw new Error('CoinGecko response missing expected price data');
    }

    return JSON.stringify({ ethereum: data.ethereum.usd, bitcoin: data.bitcoin.usd });
  },
};

export default fetchTokenPrices;
