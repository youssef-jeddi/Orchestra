import Safe from '@safe-global/protocol-kit';
import { ethers } from 'ethers';
import { read, write } from '../zero-g/storage';
import { getAgentAddress } from './agentWallet';

const SEPOLIA_RPC = process.env.SEPOLIA_RPC_URL || 'https://eth-sepolia.g.alchemy.com/v2/demo';

const ORCHESTRA_POLICY_ABI = [
  'function hasPolicy(address user) external view returns (bool)',
  'function getPolicy(address user) external view returns (tuple(address safeAddress, address agentWallet, uint256 spendingLimitUSD, bool initialized))',
];

export async function detectExistingSafe(ledgerAddress: string): Promise<string | null> {
  console.log(`[Safe] Detecting existing Safe for ${ledgerAddress}...`);

  // 1. Check 0G Storage (fast path)
  const stored = await read(`safe:${ledgerAddress.toLowerCase()}`);
  if (stored && (stored as any).safeAddress) {
    console.log(`[Safe] Found in storage: ${(stored as any).safeAddress}`);
    return (stored as any).safeAddress;
  }

  // 2. Predict the deterministic Safe address and check if code exists
  //    This works across clones — no registry or storage needed.
  try {
    const agentAddress = getAgentAddress();
    const safe = await Safe.init({
      provider: SEPOLIA_RPC,
      signer: process.env.AGENT_PRIVATE_KEY!,
      predictedSafe: {
        safeAccountConfig: {
          owners: [agentAddress, ledgerAddress],
          threshold: 1,
        },
      },
    });

    const predictedAddress = await safe.getAddress();
    const provider = new ethers.JsonRpcProvider(SEPOLIA_RPC);
    const code = await provider.getCode(predictedAddress);

    if (code !== '0x') {
      console.log(`[Safe] Found deployed Safe at predicted address: ${predictedAddress} — syncing to storage`);

      // Recover spending limit from OrchestraPolicy if available
      let spendingLimitUSD = 100;
      const policyAddress = process.env.ORCHESTRA_POLICY_ADDRESS;
      if (policyAddress) {
        try {
          const contract = new ethers.Contract(policyAddress, ORCHESTRA_POLICY_ABI, provider);
          // Policy is keyed by msg.sender (agent wallet), not ledger
          const exists = await contract.hasPolicy(agentAddress);
          if (exists) {
            const policy = await contract.getPolicy(agentAddress);
            spendingLimitUSD = Number(policy.spendingLimitUSD) / 100;
          }
        } catch (e: any) {
          console.warn(`[Safe] Policy read failed (using default limit): ${e.message}`);
        }
      }

      // Sync back to 0G Storage so future checks are fast
      await write(`safe:${ledgerAddress.toLowerCase()}`, {
        safeAddress: predictedAddress,
        agentWallet: agentAddress,
        spendingLimitUSD,
        deployedAt: new Date().toISOString(),
      });

      return predictedAddress;
    }
  } catch (err: any) {
    console.warn(`[Safe] Deterministic detection failed: ${err.message}`);
  }

  console.log('[Safe] No existing Safe found — new user');
  return null;
}
