import Safe from '@safe-global/protocol-kit';
import { ethers } from 'ethers';
import { getAgentWallet } from './agentWallet';

const SEPOLIA_RPC = process.env.SEPOLIA_RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com';

/**
 * The one Safe configuration every user's account is created from. The address is
 * derived from it (CREATE2), so changing the owner order, the threshold or adding a
 * saltNonce would silently move every user's account — safe.test.ts pins it.
 */
export function predictedSafeConfig(userAddress: string, agentWalletAddress: string) {
  return {
    safeAccountConfig: {
      owners: [agentWalletAddress, userAddress],
      threshold: 1,
    },
  };
}

/** The user's account address, known before it is deployed. */
export async function predictSafeAddress(userAddress: string, agentWalletAddress: string): Promise<string> {
  const safe = await Safe.init({
    provider: SEPOLIA_RPC,
    predictedSafe: predictedSafeConfig(userAddress, agentWalletAddress),
  });
  return safe.getAddress();
}

export async function deploySafe(
  ledgerAddress: string,
  agentWalletAddress: string,
  provider: ethers.Provider
): Promise<string> {
  console.log('[Safe] Deploying new Safe...');
  console.log(`[Safe]   owners: [${agentWalletAddress}, ${ledgerAddress}]`);
  console.log('[Safe]   threshold: 1');

  const agentWallet = getAgentWallet(provider);

  const safe = await Safe.init({
    provider: SEPOLIA_RPC,
    signer: agentWallet.privateKey,
    predictedSafe: predictedSafeConfig(ledgerAddress, agentWalletAddress),
  });

  const safeAddress = await safe.getAddress();
  console.log(`[Safe] Predicted address: ${safeAddress}`);

  // Never deploy twice: the second CREATE2 would revert and burn the agent's gas.
  if ((await provider.getCode(safeAddress)) !== '0x') {
    console.log('[Safe] Already deployed — skipping');
    return safeAddress;
  }

  const deploymentTx = await safe.createSafeDeploymentTransaction();
  const txResponse = await agentWallet.sendTransaction({
    to: deploymentTx.to,
    value: BigInt(deploymentTx.value),
    data: deploymentTx.data,
  });

  console.log(`[Safe] Deployment tx: ${txResponse.hash}`);
  const receipt = await txResponse.wait();
  console.log(`[Safe] Deployed at: ${safeAddress} (block ${receipt?.blockNumber})`);

  return safeAddress;
}
