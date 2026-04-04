import { ethers } from 'ethers';
import { read, write } from '../zero-g/storage';

const ORCHESTRA_POLICY_ABI = [
  'function hasPolicy(address user) external view returns (bool)',
  'function getPolicy(address user) external view returns (tuple(address safeAddress, address agentWallet, uint256 spendingLimitUSD, bool initialized))',
];

export async function detectExistingSafe(ledgerAddress: string): Promise<string | null> {
  console.log(`[Safe] Detecting existing Safe for ${ledgerAddress}...`);

  // 1. Check 0G Storage
  const stored = await read(`safe:${ledgerAddress.toLowerCase()}`);
  if (stored && (stored as any).safeAddress) {
    console.log(`[Safe] Found in storage: ${(stored as any).safeAddress}`);
    return (stored as any).safeAddress;
  }

  // 2. Check OrchestraPolicy contract on-chain
  const policyAddress = process.env.ORCHESTRA_POLICY_ADDRESS;
  if (policyAddress) {
    try {
      const rpc = process.env.SEPOLIA_RPC_URL || 'https://eth-sepolia.g.alchemy.com/v2/demo';
      const provider = new ethers.JsonRpcProvider(rpc);
      const contract = new ethers.Contract(policyAddress, ORCHESTRA_POLICY_ABI, provider);

      const exists = await contract.hasPolicy(ledgerAddress);
      if (exists) {
        const policy = await contract.getPolicy(ledgerAddress);
        const safeAddress = policy.safeAddress;
        console.log(`[Safe] Found on-chain: ${safeAddress} — syncing to storage`);

        await write(`safe:${ledgerAddress.toLowerCase()}`, {
          safeAddress,
          agentWallet: policy.agentWallet,
          spendingLimitUSD: Number(policy.spendingLimitUSD),
          deployedAt: new Date().toISOString(),
        });

        return safeAddress;
      }
    } catch (err: any) {
      console.warn(`[Safe] On-chain check failed: ${err.message}`);
    }
  }

  console.log('[Safe] No existing Safe found — new user');
  return null;
}
