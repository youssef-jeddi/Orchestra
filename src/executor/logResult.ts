import { append } from '../integrations/zero-g/storage';

export async function logTradeResult(
  planId: string,
  txHash: string,
  status: 'success' | 'reverted' | 'pending'
): Promise<void> {
  console.log(`[Executor] Logging trade: ${txHash} (${status})`);

  await append('history/trades', {
    planId,
    txHash,
    status,
    executedAt: new Date().toISOString(),
  });
}
