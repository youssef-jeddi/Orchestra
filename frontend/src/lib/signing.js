// ── Shared signing / execution helpers ──
// Turns the bridge's unsigned payloads (sendData / quoteData) into broadcast
// transactions. Supports both connection types:
//   • Ledger   — sign the raw tx locally, broadcast via the bridge.
//   • MetaMask — hand the tx to the extension (eth_sendTransaction), which signs
//                and broadcasts itself (and manages nonces/gas).
// Used by the /simple route; the full app has its own inline copy of this flow.

import { broadcast, submitSwap, getNonce } from './bridge';

const CHAIN_ID = 11155111; // Sepolia
const explorer = (h) => `https://sepolia.etherscan.io/tx/${h}`;

function toHex(v) {
  if (v == null) return '0x0';
  if (typeof v === 'string' && v.startsWith('0x')) return v;
  try { return '0x' + BigInt(v).toString(16); } catch { return '0x0'; }
}

// MetaMask: sign + broadcast in one call, returns the tx hash.
async function mmSend(ledger, tx) {
  const eth = typeof window !== 'undefined' ? window.ethereum : null;
  if (!eth) throw new Error('MetaMask not available');
  return eth.request({
    method: 'eth_sendTransaction',
    params: [{ from: ledger.walletAddress, to: tx.to, data: tx.data || '0x', value: toHex(tx.value) }],
  });
}

// Ledger: build EIP-1559 tx, sign the bytes, broadcast the signed tx.
async function ledgerSendTx(ledger, tx, gasLimit) {
  const { ethers } = await import('ethers');
  const nonceData = await getNonce(ledger.walletAddress);
  const built = ethers.Transaction.from({
    to: tx.to, data: tx.data || '0x', value: tx.value || '0x0',
    chainId: CHAIN_ID, gasLimit, type: 2,
    maxFeePerGas: BigInt(nonceData.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(nonceData.maxPriorityFeePerGas),
    nonce: nonceData.nonce,
  });
  const sig = await ledger.sign(built.unsignedSerialized);
  const signed = built.clone();
  signed.signature = ethers.Signature.from(sig);
  const result = await broadcast(signed.serialized);
  return result.txHash || result.hash;
}

async function sendTx(ledger, tx, gasLimit) {
  return ledger.connectionType === 'metamask'
    ? mmSend(ledger, tx)
    : ledgerSendTx(ledger, tx, gasLimit);
}

// ── Send: single transfer tx ──
export async function executeSend(ledger, data) {
  const txHash = await sendTx(ledger, data.sendData.unsignedTx, 60000);
  return { txHash, explorerUrl: explorer(txHash) };
}

// ── Swap: (optional approval) → (optional Permit2 typed data) → swap tx ──
export async function executeSwap(ledger, data) {
  const q = data.quoteData;
  if (!q) throw new Error('No quote to sign');

  // 1. Permit2 / ERC20 approval.
  if (q.approvalNeeded && q.approvalTx) {
    await sendTx(ledger, q.approvalTx, q.approvalTx.gasLimit || 100000);
    await new Promise((r) => setTimeout(r, 5000)); // let it land before the swap
  }

  // 2. Permit2 typed-data signature.
  let permit2Signature;
  if (q.permitData) {
    const { ethers } = await import('ethers');
    const typedData = {
      domain: q.permitData.domain,
      types: q.permitData.types,
      primaryType: q.permitData.primaryType
        || Object.keys(q.permitData.types).find((k) => k !== 'EIP712Domain')
        || 'PermitSingle',
      message: q.permitData.values,
    };
    const sig = await ledger.signTyped(typedData);
    // Ledger returns {v,r,s}; MetaMask returns a serialized hex string.
    permit2Signature = typeof sig === 'string'
      ? sig
      : ethers.Signature.from({ v: sig.v, r: sig.r, s: sig.s }).serialized;
  }

  // 3. Resolve the swap calldata from the bridge.
  const swapResult = await submitSwap(q.quote, q.permitData, permit2Signature, q.routing);
  if (swapResult.type === 'uniswapx') {
    return { orderId: swapResult.orderId };
  }

  // 4. Execute the swap tx.
  const unsignedTx = swapResult.unsignedTx;
  const gasLimit = Math.ceil(Number(unsignedTx.gasLimit || unsignedTx.gas || 350000) * 1.2);
  const txHash = await sendTx(ledger, unsignedTx, gasLimit);
  return { txHash, explorerUrl: explorer(txHash) };
}
