import { Provider } from '../../../types/agents';

// The profile used to come from the shared `user:profile` record, which held one user's settings
// for everyone. Settings are per wallet now (`user:profile:<wallet>`, read by the policy store) and
// this provider has no wallet to ask for, so it gives the defaults and never the shared record.
const userProfileProvider: Provider = {
  name: 'userProfileProvider',
  description: 'The default user profile (settings are per wallet and checked by the policy, not by this agent)',
  handler: async (): Promise<string> => {
    return JSON.stringify({ autoApproveLimit: 100, currency: 'USD', knownAddresses: [] });
  },
};

export default userProfileProvider;
