import { Provider } from '../../../types/agents';
import { read } from '../../../integrations/zero-g/storage';

const userProfileProvider: Provider = {
  name: 'userProfileProvider',
  description: 'Reads the user profile from 0G Storage, or returns a default',
  handler: async (): Promise<string> => {
    const profile = await read('user:profile');
    if (!profile) {
      return JSON.stringify({ autoApproveLimit: 100, currency: 'USD', knownAddresses: [] });
    }
    return JSON.stringify(profile);
  },
};

export default userProfileProvider;
