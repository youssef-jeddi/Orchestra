import * as crypto from 'crypto';
import { Action } from '../../../types/agents';
import { Flag, FlagType } from '../../../types/storage';
import { append } from '../../../integrations/zero-g/storage';

const validFlagTypes = Object.values(FlagType) as string[];

const writeFlag: Action = {
  name: 'writeFlag',
  description: 'Writes a structured Flag to 0G Storage when a condition is met',
  parameters: [
    { name: 'type', type: 'string', description: `Flag type: ${validFlagTypes.join(', ')}`, required: true },
    { name: 'message', type: 'string', description: 'Human-readable summary of what was detected', required: true },
    { name: 'data', type: 'object', description: 'Additional data payload for the flag', required: false },
  ],
  handler: async (args: Record<string, unknown>): Promise<string> => {
    const typeStr = args.type as string;
    const message = args.message as string;
    const data = (args.data as Record<string, unknown>) || {};

    if (!validFlagTypes.includes(typeStr)) {
      throw new Error(`Invalid FlagType "${typeStr}". Valid types: ${validFlagTypes.join(', ')}`);
    }

    const flag: Flag = {
      id: crypto.randomUUID(),
      type: typeStr as FlagType,
      source: 'watcher',
      summary: message,
      data,
      processed: false,
      createdAt: new Date().toISOString(),
    };

    await append('flags', flag);
    return `Flag written: ${typeStr}`;
  },
};

export default writeFlag;
