import Safe from '@safe-global/protocol-kit';
import { ethers } from 'ethers';
import { PERMIT2, UNIVERSAL_ROUTER } from '../uniswap/types';

const SEPOLIA_RPC = process.env.SEPOLIA_RPC_URL || 'https://eth-sepolia.g.alchemy.com/v2/demo';

export async function initSafe(safeAddress: string, signerPrivateKey: string): Promise<InstanceType<typeof Safe>> {
  return Safe.init({
    provider: SEPOLIA_RPC,
    signer: signerPrivateKey,
    safeAddress,
  });
}

/** Normalize hex values like "0x00" to decimal strings the Safe SDK expects */
function normalizeValue(value: string): string {
  if (!value || value === '0') return '0';
  if (value.startsWith('0x')) return BigInt(value).toString();
  return value;
}

/**
 * Execute a single transaction through the Safe.
 */
export async function executeViaSafe(
  safeAddress: string,
  signerPrivateKey: string,
  to: string,
  value: string,
  data: string
): Promise<string> {
  return executeBatchViaSafe(safeAddress, signerPrivateKey, [
    { to, value: normalizeValue(value), data },
  ]);
}

/**
 * Execute one or more transactions through the Safe in a single on-chain tx.
 * When transactions.length > 1, the SDK automatically uses MultiSend
 * (all operations execute atomically in one Safe tx with one nonce).
 */
export async function executeBatchViaSafe(
  safeAddress: string,
  signerPrivateKey: string,
  transactions: Array<{ to: string; value: string; data: string }>,
  gasLimit?: string
): Promise<string> {
  const safe = await initSafe(safeAddress, signerPrivateKey);

  const tx = await safe.createTransaction({ transactions });
  const signedTx = await safe.signTransaction(tx);

  // Bypass gas estimation for complex calldata (e.g. Uniswap swaps) —
  // eth_estimateGas simulation incorrectly reverts with GS013 for large
  // calldata even though actual on-chain execution succeeds.
  const opts = gasLimit ? { gasLimit } : {};
  const result = await safe.executeTransaction(signedTx, opts);
  return (result as any).hash || '';
}

/**
 * Check what Permit2 approval transactions are needed for a Uniswap swap.
 * Returns an array of tx data (may be empty if approvals already exist).
 * Does NOT execute anything — just reads chain state.
 *
 * @param routerAddress The actual router address from the Uniswap API swap response.
 *                      Do NOT use a hardcoded constant — the API may use different router versions.
 */
export async function getApprovalTxsForSwap(
  safeAddress: string,
  tokenAddress: string,
  amount: bigint,
  routerAddress: string
): Promise<Array<{ to: string; value: string; data: string }>> {
  const provider = new ethers.JsonRpcProvider(SEPOLIA_RPC);
  const txs: Array<{ to: string; value: string; data: string }> = [];

  // Step 1: Check ERC20 → Permit2 allowance
  const erc20 = new ethers.Contract(tokenAddress, [
    'function allowance(address owner, address spender) view returns (uint256)',
  ], provider);

  const permit2Allowance: bigint = await erc20.allowance(safeAddress, PERMIT2);
  if (permit2Allowance < amount) {
    console.log(`[Safe] Batch will include: approve ${tokenAddress} → Permit2`);
    const iface = new ethers.Interface(['function approve(address spender, uint256 amount) returns (bool)']);
    txs.push({
      to: tokenAddress,
      value: '0',
      data: iface.encodeFunctionData('approve', [PERMIT2, ethers.MaxUint256]),
    });
  } else {
    console.log(`[Safe] Token already approved to Permit2`);
  }

  // Step 2: Check Permit2 → actual router allowance
  const permit2Contract = new ethers.Contract(PERMIT2, [
    'function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)',
  ], provider);

  const [currentAmount, expiration] = await permit2Contract.allowance(safeAddress, tokenAddress, routerAddress);
  const now = Math.floor(Date.now() / 1000);

  if (currentAmount < amount || expiration <= now) {
    console.log(`[Safe] Batch will include: Permit2.approve → Router ${routerAddress}`);
    const iface = new ethers.Interface(['function approve(address token, address spender, uint160 amount, uint48 expiration)']);
    const maxUint160 = (1n << 160n) - 1n;
    const maxUint48 = (1n << 48n) - 1n;
    txs.push({
      to: PERMIT2,
      value: '0',
      data: iface.encodeFunctionData('approve', [tokenAddress, routerAddress, maxUint160, maxUint48]),
    });
  } else {
    console.log(`[Safe] Permit2 already approved Router`);
  }

  return txs;
}
