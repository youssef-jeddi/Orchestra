import Safe from '@safe-global/protocol-kit';
import { ethers } from 'ethers';
import { ALLOWANCE_MODULE_ADDRESS } from '../../types/safe';
import type { TxTracker } from './inflight';
import { makeSepoliaProvider, sepoliaRpcUrl } from '../../utils/rpc';

// Sepolia token addresses
const ETH_ADDRESS = '0x0000000000000000000000000000000000000000';
const USDC_SEPOLIA = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';
const WETH_SEPOLIA = '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14';

// AllowanceModule ABI (only the functions we need)
const ALLOWANCE_ABI = [
  'function addDelegate(address delegate)',
  'function setAllowance(address delegate, address token, uint96 allowanceAmount, uint16 resetTimeMin, uint32 resetBaseMin)',
  'function getTokenAllowance(address safe, address delegate, address token) view returns (uint256[5])',
  'function getDelegates(address safe, uint48 start, uint8 pageSize) view returns (address[] results, address next)',
];


// Helper: fresh Safe SDK instance (avoids stale nonce after tx execution)
async function initSafe(safeAddress: string, signerPrivateKey: string) {
  return Safe.init({ provider: sepoliaRpcUrl(), signer: signerPrivateKey, safeAddress });
}

// Helper: wait for nonce to increment on-chain
async function waitForNonce(safeAddress: string, signerPrivateKey: string, expectedNonce: number, maxWaitMs = 90000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const safe = await initSafe(safeAddress, signerPrivateKey);
    const current = await safe.getNonce();
    if (current >= expectedNonce) return;
    await new Promise(r => setTimeout(r, 2000));
  }
  // Not confirmed yet: carrying on would build the next transaction on a stale nonce. The caller's
  // in-flight record keeps the sent transaction from being sent again.
  throw new Error(`Safe transaction not confirmed yet (waiting for nonce ${expectedNonce})`);
}

// Helper: create, sign, execute one Safe tx with nonce confirmation. The tracker (setup only)
// records the send, so a run that stops while it is unconfirmed doesn't send it twice.
async function execSafeTx(safeAddress: string, signerPrivateKey: string, to: string, data: string, tracker?: TxTracker): Promise<string> {
  const safe = await initSafe(safeAddress, signerPrivateKey);
  const nonce = await safe.getNonce();
  const tx = await safe.createTransaction({ transactions: [{ to, value: '0', data }] });
  const signedTx = await safe.signTransaction(tx);
  await tracker?.begin();
  const result = await safe.executeTransaction(signedTx);
  const hash = (result as any).hash || '';
  if (hash) await tracker?.sent(hash);
  // Wait for nonce to increment (confirms tx was mined)
  await waitForNonce(safeAddress, signerPrivateKey, nonce + 1);
  await tracker?.settled();
  return hash;
}

/** The tokens the agent may spend through the AllowanceModule, with the amount for a USD limit. */
export function allowanceTokens(limitUSD: number) {
  const ethAmount = ethers.parseEther((limitUSD / 2500).toFixed(8));
  return [
    { address: USDC_SEPOLIA, amount: BigInt(limitUSD) * 1000000n, name: 'USDC' },
    { address: WETH_SEPOLIA, amount: ethAmount, name: 'WETH' },
    { address: ETH_ADDRESS, amount: ethAmount, name: 'ETH' },
  ];
}

/** Turn the AllowanceModule on for the Safe; does nothing if it already is. */
export async function enableAllowanceModule(safeAddress: string, signerPrivateKey: string, tracker?: TxTracker): Promise<void> {
  const safe = await initSafe(safeAddress, signerPrivateKey);
  if (await safe.isModuleEnabled(ALLOWANCE_MODULE_ADDRESS)) {
    console.log('[Safe] AllowanceModule already enabled');
    return;
  }
  console.log('[Safe] Enabling AllowanceModule...');
  const nonceBefore = await safe.getNonce();
  const enableTx = await safe.createEnableModuleTx(ALLOWANCE_MODULE_ADDRESS);
  const signedEnableTx = await safe.signTransaction(enableTx);
  await tracker?.begin();
  const enableResult = await safe.executeTransaction(signedEnableTx);
  const hash = (enableResult as any).hash || '';
  if (hash) await tracker?.sent(hash);
  console.log(`[Safe] AllowanceModule enabled: ${hash || 'ok'}`);
  // Wait for nonce to increment before proceeding
  await waitForNonce(safeAddress, signerPrivateKey, nonceBefore + 1);
  await tracker?.settled();
}

/** Make the agent a delegate of the module (required before setAllowance); does nothing if it already is. */
export async function addAgentDelegate(safeAddress: string, agentWalletAddress: string, signerPrivateKey: string, tracker?: TxTracker): Promise<void> {
  if (await isAgentDelegate(safeAddress, agentWalletAddress)) {
    console.log('[Safe] Agent already a delegate');
    return;
  }
  console.log('[Safe] Adding agent as delegate...');
  const data = new ethers.Interface(ALLOWANCE_ABI).encodeFunctionData('addDelegate', [agentWalletAddress]);
  const hash = await execSafeTx(safeAddress, signerPrivateKey, ALLOWANCE_MODULE_ADDRESS, data, tracker);
  console.log(`[Safe] Delegate added: ${hash}`);
}

/** Chain read: is the agent a delegate of the Safe's AllowanceModule? */
export async function isAgentDelegate(safeAddress: string, agentWalletAddress: string): Promise<boolean> {
  const moduleContract = new ethers.Contract(ALLOWANCE_MODULE_ADDRESS, ALLOWANCE_ABI, makeSepoliaProvider());
  const delegates = await moduleContract.getDelegates(safeAddress, 0, 10);
  return delegates.results.map((a: string) => a.toLowerCase()).includes(agentWalletAddress.toLowerCase());
}

/**
 * Chain read: which of the tokens have never had an allowance set for the agent. A later change
 * of the limit doesn't count as missing (amount or nonce is non-zero once it was ever set).
 */
export async function tokensWithoutAllowance(safeAddress: string, agentWalletAddress: string): Promise<string[]> {
  const moduleContract = new ethers.Contract(ALLOWANCE_MODULE_ADDRESS, ALLOWANCE_ABI, makeSepoliaProvider());
  const missing: string[] = [];
  for (const token of allowanceTokens(1)) {
    const a = await moduleContract.getTokenAllowance(safeAddress, agentWalletAddress, token.address);
    if (BigInt(a[0]) === 0n && BigInt(a[4]) === 0n) missing.push(token.address);
  }
  return missing;
}

/** Set the allowance for the given token addresses only (all three when omitted). */
export async function setAgentAllowances(
  safeAddress: string, agentWalletAddress: string, limitUSD: number, signerPrivateKey: string, only?: string[], tracker?: TxTracker,
): Promise<void> {
  const allowanceIface = new ethers.Interface(ALLOWANCE_ABI);
  for (const token of allowanceTokens(limitUSD)) {
    if (only && !only.includes(token.address)) continue;
    console.log(`[Safe] Setting ${token.name} allowance: ${token.amount}`);
    const data = allowanceIface.encodeFunctionData('setAllowance', [
      agentWalletAddress, token.address, token.amount, 1440, 0,
    ]);
    const hash = await execSafeTx(safeAddress, signerPrivateKey, ALLOWANCE_MODULE_ADDRESS, data, tracker);
    console.log(`[Safe] ${token.name} allowance set: ${hash}`);
  }
}

// ── Ledger-signed limit update ──
// Builds a single unsigned tx that batches all 3 setAllowance calls via MultiSend
// through the Safe. The Ledger owner signs this as a regular ETH tx.

const MULTISEND_ADDRESS = '0x38869bf66a61cF6bDB996A6aE40D5853Fd43B526';

const SAFE_EXEC_ABI = [
  'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)',
];

/** Pack inner txs into MultiSend's `transactions` bytes (packed encoding). */
function encodeMultiSendData(txs: Array<{ to: string; value: string; data: string }>): string {
  const parts: string[] = [];
  for (const tx of txs) {
    const dataBytes = ethers.getBytes(tx.data);
    const packed = ethers.solidityPacked(
      ['uint8', 'address', 'uint256', 'uint256', 'bytes'],
      [0, tx.to, BigInt(tx.value || '0'), dataBytes.length, tx.data],
    );
    parts.push(packed.slice(2)); // strip 0x for concat
  }
  return '0x' + parts.join('');
}

/**
 * Build an unsigned ETH transaction that, when sent by `ledgerAddress`,
 * executes a MultiSend of 3 setAllowance calls through the Safe.
 * Returns { to, data, value } — caller adds nonce/gas/chainId and signs on Ledger.
 */
export function buildLimitUpdateTx(
  safeAddress: string,
  ledgerAddress: string,
  agentWalletAddress: string,
  newLimitUSD: number,
): { to: string; data: string; value: string; gasLimit: number } {
  const allowanceIface = new ethers.Interface(ALLOWANCE_ABI);

  const usdcAmount = BigInt(newLimitUSD) * 1000000n;
  const ethAmount = ethers.parseEther((newLimitUSD / 2500).toFixed(8));

  const innerTxs = [
    { to: ALLOWANCE_MODULE_ADDRESS, value: '0', data: allowanceIface.encodeFunctionData('setAllowance', [agentWalletAddress, USDC_SEPOLIA, usdcAmount, 1440, 0]) },
    { to: ALLOWANCE_MODULE_ADDRESS, value: '0', data: allowanceIface.encodeFunctionData('setAllowance', [agentWalletAddress, WETH_SEPOLIA, ethAmount, 1440, 0]) },
    { to: ALLOWANCE_MODULE_ADDRESS, value: '0', data: allowanceIface.encodeFunctionData('setAllowance', [agentWalletAddress, ETH_ADDRESS, ethAmount, 1440, 0]) },
  ];

  // Pack into MultiSend calldata
  const packed = encodeMultiSendData(innerTxs);
  const multiSendIface = new ethers.Interface(['function multiSend(bytes transactions)']);
  const multiSendCalldata = multiSendIface.encodeFunctionData('multiSend', [packed]);

  // Owner pre-approved signature: when msg.sender is a Safe owner and v=1,
  // the Safe contract accepts it without an ECDSA check (threshold=1).
  const ownerSig = ethers.solidityPacked(
    ['uint256', 'uint256', 'uint8'],
    [BigInt(ledgerAddress), 0n, 1],
  );

  // Encode Safe.execTransaction (DELEGATECALL to MultiSend)
  const safeIface = new ethers.Interface(SAFE_EXEC_ABI);
  const execData = safeIface.encodeFunctionData('execTransaction', [
    MULTISEND_ADDRESS,    // to
    0,                     // value
    multiSendCalldata,     // data
    1,                     // operation = DELEGATECALL
    0,                     // safeTxGas
    0,                     // baseGas
    0,                     // gasPrice
    ethers.ZeroAddress,    // gasToken
    ethers.ZeroAddress,    // refundReceiver
    ownerSig,              // signatures
  ]);

  return { to: safeAddress, data: execData, value: '0', gasLimit: 500000 };
}
