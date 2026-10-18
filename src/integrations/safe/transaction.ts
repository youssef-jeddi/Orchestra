import Safe from '@safe-global/protocol-kit';
import { ethers } from 'ethers';
import { PERMIT2, UNIVERSAL_ROUTER } from '../uniswap/types';

const SEPOLIA_RPC = process.env.SEPOLIA_RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com';

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

/** Headroom over the estimate: the chain can move a little between estimating and mining. */
const GAS_HEADROOM_PERCENT = 20n;

/** The gas limit for an estimate: the estimate plus GAS_HEADROOM_PERCENT. */
export function gasLimitFromEstimate(estimate: bigint): bigint {
  return (estimate * (100n + GAS_HEADROOM_PERCENT)) / 100n;
}

/** A Safe revert reason (GS013, …) from a failed call, if it carries one. */
function safeRevertReason(err: any): string | null {
  const reason = err?.reason ?? err?.revert?.args?.[0] ?? err?.info?.error?.message;
  return typeof reason === "string" && reason ? reason : null;
}

/**
 * The gas limit for a Safe transaction from `estimate` (see executeBatchViaSafe).
 * Throws when the estimate reverts: the transaction would fail on-chain too.
 * Falls back to `fallbackGasLimit` only when the RPC can't estimate at all.
 */
export async function safeGasLimit(estimate: () => Promise<bigint>, fallbackGasLimit?: string): Promise<string | undefined> {
  try {
    const gas = await estimate();
    const limit = gasLimitFromEstimate(gas).toString();
    console.log(`[safe] gas estimate ${gas} → limit ${limit}`);
    return limit;
  } catch (err: any) {
    if (err?.code === "CALL_EXCEPTION") {
      const reason = safeRevertReason(err);
      throw new Error(
        `This transaction would fail${reason ? ` (${reason}${reason === "GS013" ? " — the inner call failed" : ""})` : ""}, so it wasn't sent. Nothing was spent.`
      );
    }
    console.warn(`[safe] couldn't estimate gas (${err?.shortMessage ?? err?.message}); using ${fallbackGasLimit ?? "the SDK's default"}`);
    return fallbackGasLimit;
  }
}

/**
 * Execute one or more transactions through the Safe in a single on-chain tx.
 * When transactions.length > 1, the SDK automatically uses MultiSend
 * (all operations execute atomically in one Safe tx with one nonce).
 *
 * The gas limit comes from estimating the whole Safe transaction (plus
 * headroom), not from the inner call's own estimate: a quote's gas estimate
 * leaves out the Safe's overhead, and on thin testnet pools it can be far too
 * low, so the inner call runs out of gas and Safe reverts with GS013.
 * safeTxGas and gasPrice are 0, so Safe reverts instead of returning false: if
 * the estimate itself reverts, the transaction would fail on-chain too, and
 * nothing is sent. Only when the RPC can't estimate at all is `fallbackGasLimit`
 * used.
 */
export async function executeBatchViaSafe(
  safeAddress: string,
  signerPrivateKey: string,
  transactions: Array<{ to: string; value: string; data: string }>,
  fallbackGasLimit?: string
): Promise<string> {
  const safe = await initSafe(safeAddress, signerPrivateKey);

  const tx = await safe.createTransaction({ transactions });
  const signedTx = await safe.signTransaction(tx);

  const provider = new ethers.JsonRpcProvider(SEPOLIA_RPC);
  const from = new ethers.Wallet(signerPrivateKey).address;
  const data = await safe.getEncodedTransaction(signedTx);
  // The Safe pays any value from its own balance, so the outer call carries none.
  const gasLimit = await safeGasLimit(() => provider.estimateGas({ from, to: safeAddress, data }), fallbackGasLimit);

  const opts = gasLimit ? { gasLimit } : {};
  const result = await safe.executeTransaction(signedTx, opts) as { hash?: string; transactionResponse?: { wait: () => Promise<{ status?: number } | null> } };
  const hash = result.hash || "";
  const receipt = await result.transactionResponse?.wait?.();
  if (receipt && Number(receipt.status) === 0) {
    // Shown to the user (chat error, approval card, Telegram): plain words; the technical detail stays in the log.
    console.error(`[safe] transaction reverted on-chain (GS013, the inner call failed): ${hash}`);
    throw new Error(`This didn't go through, so your funds were not moved. You can see what happened here: https://sepolia.etherscan.io/tx/${hash}`);
  }
  return hash;
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
