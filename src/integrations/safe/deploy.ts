import Safe from '@safe-global/protocol-kit';
import { ethers } from 'ethers';
import { getAgentWallet } from './agentWallet';

const SEPOLIA_RPC = process.env.SEPOLIA_RPC_URL || 'https://eth-sepolia.g.alchemy.com/v2/demo';

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
    predictedSafe: {
      safeAccountConfig: {
        owners: [agentWalletAddress, ledgerAddress],
        threshold: 1,
      },
    },
  });

  const safeAddress = await safe.getAddress();
  console.log(`[Safe] Predicted address: ${safeAddress}`);

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
