import { Action } from '../../../types/agents';
import { write } from '../../../integrations/zero-g/storage';

const triggerLedgerApproval: Action = {
  name: 'triggerLedgerApproval',
  description: 'Sends an approval request to the Ledger device (writes to storage for now)',
  parameters: [
    { name: 'planId', type: 'string', description: 'ID of the plan requiring approval', required: true },
    { name: 'message', type: 'object', description: 'Clear signing message with action, amount, currency, warning', required: true },
  ],
  handler: async (args: Record<string, unknown>): Promise<string> => {
    const planId = args.planId as string;
    const message = args.message as Record<string, unknown>;

    await write('ledger:pending', {
      planId,
      message,
      requestedAt: new Date().toISOString(),
      status: 'waiting',
    });

    console.log(`[Gatekeeper] Ledger approval requested for plan ${planId}`);
    return `Ledger approval requested for plan ${planId}`;
  },
};

export default triggerLedgerApproval;
