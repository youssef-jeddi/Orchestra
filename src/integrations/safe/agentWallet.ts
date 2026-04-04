import { ethers } from 'ethers';

export function getAgentWallet(provider: ethers.Provider): ethers.Wallet {
  const key = process.env.AGENT_PRIVATE_KEY;
  if (!key) throw new Error('AGENT_PRIVATE_KEY not set');
  return new ethers.Wallet(key, provider);
}

export function getAgentAddress(): string {
  const key = process.env.AGENT_PRIVATE_KEY;
  if (!key) throw new Error('AGENT_PRIVATE_KEY not set');
  return new ethers.Wallet(key).address;
}
