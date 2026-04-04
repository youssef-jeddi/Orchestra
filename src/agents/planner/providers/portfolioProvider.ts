import { Provider } from '../../../types/agents';
import { read } from '../../../integrations/zero-g/storage';

const portfolioProvider: Provider = {
  name: 'portfolioProvider',
  description: 'Reads the current portfolio state from 0G Storage',
  handler: async (): Promise<string> => {
    const portfolio = await read('portfolio:current');
    if (portfolio === null) {
      throw new Error('No portfolio data found — seed it first');
    }
    return JSON.stringify(portfolio);
  },
};

export default portfolioProvider;
