export const ALLOWANCE_MODULE_ADDRESS = '0xCFbFaC74C26F8647cBDb8c5caf80BB5b32E43134';

export interface SafeUserPolicy {
  safeAddress: string;
  agentWallet: string;
  spendingLimitUSD: number;
  deployedAt: string;
}
