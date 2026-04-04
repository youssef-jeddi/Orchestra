import { Provider } from '../../../types/agents';
import { read } from '../../../integrations/zero-g/storage';

const portfolioProvider: Provider = {
  name: 'portfolioProvider',
  description: 'Reads the current portfolio state from 0G Storage',
  handler: async (): Promise<string> => {
    const portfolio = await read('portfolio:current');
    if (portfolio === null) {
      return JSON.stringify({ holdings: [], note: "No portfolio data available" });
    }
    return JSON.stringify(portfolio);
  },
};

export default portfolioProvider;
