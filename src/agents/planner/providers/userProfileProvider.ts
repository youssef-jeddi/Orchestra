import { Provider } from '../../../types/agents';

// The profile used to come from the shared `user:profile` record, which held one user's settings
// for everyone. Settings are per wallet now (`user:profile:<wallet>`, read by the policy store) and
// this provider has no wallet to ask for, so it gives the defaults and never the shared record.
const userProfileProvider: Provider = {
  name: 'userProfileProvider',
  description: 'The default user profile (currency and known addresses only; spending limits are decided by the server policy, not by this agent)',
  handler: async (): Promise<string> => {
    return JSON.stringify({ currency: 'USD', knownAddresses: [] });
  },
};

export default userProfileProvider;
