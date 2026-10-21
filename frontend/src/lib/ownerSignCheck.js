// ─── Owner-sign check — what the wallet is really asked to sign, decoded in the browser ───
// A request over the on-chain daily ceiling comes back with a Safe transaction for the owner to sign
// (src/integrations/safe/ownerSign.ts). The bridge builds it, so a hacked or buggy bridge could word
// it "Send 2000 USDC to Bob" while the transaction adds an owner, enables a module or DelegateCalls
// into anything, which hands over the account (ORC-113). This page therefore never trusts the
// bridge's text or hash: it decodes the transaction itself, allows only the shapes the bridge
// really builds for a payment, shows the amount and recipient it decoded, and rebuilds the typed
// data (our types, Sepolia, the account shown on this page) so the wallet signs exactly that.
// Pure, so every refused shape is tested without a browser (src/integrations/safe/ownerSignCheck.test.ts).

import { ethers } from 'ethers';

export const SEPOLIA_CHAIN_ID = 11155111;

/** Shown instead of the Sign button whenever a request isn't a plain payment we can read. */
export const NOT_A_PAYMENT =
  "This request doesn't match a normal payment, so Orchestra won't ask you to sign it. Nothing was sent.";

/**
 * Tokens a payment may move, by address. An unknown contract is refused rather than shown raw:
 * a newcomer can't judge a contract address, and the send flow only ever pays in these.
 */
export const KNOWN_TOKENS = {
  '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238': { symbol: 'USDC', decimals: 6 },
  '0xaa8e23fb1079ea71e0a56f48a2aa51851d8433d0': { symbol: 'USDT', decimals: 6 },
  '0xfff9976782d46cc05630d1f6ebab18b2324d6b14': { symbol: 'WETH', decimals: 18 },
  '0xc558dbdd856501fcd9aaf1e62eae57a9f0629a3c': { symbol: 'WETH', decimals: 18 },
};

/** Safe's EIP-712 transaction type (Safe 1.3.0 / 1.4.1): our own copy, never the bridge's. */
export const SAFE_TX_TYPES = {
  SafeTx: [
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'data', type: 'bytes' },
    { name: 'operation', type: 'uint8' },
    { name: 'safeTxGas', type: 'uint256' },
    { name: 'baseGas', type: 'uint256' },
    { name: 'gasPrice', type: 'uint256' },
    { name: 'gasToken', type: 'address' },
    { name: 'refundReceiver', type: 'address' },
    { name: 'nonce', type: 'uint256' },
  ],
};

// eth_signTypedData_v4 (MetaMask) needs the domain's type spelled out; ethers' own hash ignores it.
const DOMAIN_TYPE = [
  { name: 'chainId', type: 'uint256' },
  { name: 'verifyingContract', type: 'address' },
];

const ERC20 = new ethers.Interface(['function transfer(address to, uint256 amount)']);
const TRANSFER = ERC20.getFunction('transfer').selector;

/** Why a request was refused (for tests and logs; the user only ever reads NOT_A_PAYMENT). */
export const REFUSED = {
  malformed: 'malformed',
  wrongChain: 'wrong-chain',
  wrongAccount: 'wrong-account',
  delegateCall: 'delegate-call',
  gasRefund: 'gas-refund',
  callsAccount: 'calls-account',
  unknownCall: 'unknown-call',
  unknownToken: 'unknown-token',
  badRecipient: 'bad-recipient',
  nothingSent: 'nothing-sent',
  hashMismatch: 'hash-mismatch',
  claimMismatch: 'claim-mismatch',
};

const refuse = (reason) => ({ ok: false, reason, message: NOT_A_PAYMENT });

function uint(v) {
  if (typeof v === 'bigint') return v >= 0n ? v : null;
  if (typeof v === 'number') return Number.isSafeInteger(v) && v >= 0 ? BigInt(v) : null;
  if (typeof v !== 'string' || !/^(0x[0-9a-fA-F]+|[0-9]+)$/.test(v)) return null;
  return BigInt(v);
}

function addr(v) {
  if (typeof v !== 'string' || !ethers.isAddress(v)) return null;
  try { return ethers.getAddress(v); } catch { return null; }
}

const same = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/** "0x1234…abcd", the way /simple shows addresses. */
export const shortAddr = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** The user-facing line for a decoded payment. */
export function paymentText(p) {
  return `Sign with your wallet to send ${p.amount} ${p.symbol} from your account to ${shortAddr(p.to)}.`;
}

/**
 * Decode the offer the bridge returned and decide whether this page may ask the wallet to sign it.
 * `safeAddress` is the account this page shows (never taken from the offer). Returns
 * `{ ok: true, payment, typedData, safeTxHash, text }`, where typedData is rebuilt from the decoded
 * fields and is what must be signed, or `{ ok: false, reason, message }`.
 */
export function checkOwnerSign(offer, { safeAddress, chainId = SEPOLIA_CHAIN_ID } = {}) {
  const m = offer?.typedData?.message;
  const d = offer?.typedData?.domain;
  if (!m || typeof m !== 'object' || !d || typeof d !== 'object') return refuse(REFUSED.malformed);

  // The domain binds the signature to one chain and one account: only Sepolia and the account on this page.
  const safe = addr(safeAddress);
  if (!safe) return refuse(REFUSED.wrongAccount);
  if (uint(d.chainId) !== BigInt(chainId)) return refuse(REFUSED.wrongChain);
  if (!same(addr(d.verifyingContract), safe)) return refuse(REFUSED.wrongAccount);

  const to = addr(m.to);
  const value = uint(m.value);
  const operation = uint(m.operation);
  const nonce = uint(m.nonce);
  const gas = [uint(m.safeTxGas), uint(m.baseGas), uint(m.gasPrice)];
  const gasToken = addr(m.gasToken);
  const refundReceiver = addr(m.refundReceiver);
  const data = typeof m.data === 'string' && /^0x([0-9a-fA-F]{2})*$/.test(m.data) ? m.data.toLowerCase() : null;
  if (!to || value === null || operation === null || nonce === null || data === null
    || gas.some((g) => g === null) || !gasToken || !refundReceiver) return refuse(REFUSED.malformed);

  // A DelegateCall runs another contract's code as the account itself: it can do anything, so the
  // owner path never needs one for a payment (a MultiSend is a DelegateCall too).
  if (operation !== 0n) return refuse(REFUSED.delegateCall);
  // Safe pays the "refund" to refundReceiver out of the account; the bridge never asks for one.
  if (gas.some((g) => g !== 0n) || gasToken !== ethers.ZeroAddress || refundReceiver !== ethers.ZeroAddress) {
    return refuse(REFUSED.gasRefund);
  }
  // Calls to the account itself are its admin functions: owners, threshold, modules, guard, fallback handler.
  if (same(to, safe)) return refuse(REFUSED.callsAccount);

  let payment;
  if (data === '0x') {
    if (value === 0n) return refuse(REFUSED.nothingSent);
    payment = { symbol: 'ETH', decimals: 18, raw: value, to, token: null };
  } else {
    // Only an ERC-20 transfer of a known token, with no ETH attached and nothing appended.
    if (value !== 0n) return refuse(REFUSED.unknownCall);
    if (data.slice(0, 10) !== TRANSFER || data.length !== 2 + 8 + 128) return refuse(REFUSED.unknownCall);
    const token = KNOWN_TOKENS[to.toLowerCase()];
    if (!token) return refuse(REFUSED.unknownToken);
    let recipient;
    let amount;
    try {
      [recipient, amount] = ERC20.decodeFunctionData('transfer', data);
    } catch {
      return refuse(REFUSED.malformed);
    }
    // Re-encoding must give the same bytes: no dirty high bits hiding a different reading.
    if (ERC20.encodeFunctionData('transfer', [recipient, amount]).toLowerCase() !== data) return refuse(REFUSED.malformed);
    if (amount === 0n) return refuse(REFUSED.nothingSent);
    payment = { symbol: token.symbol, decimals: token.decimals, raw: amount, to: ethers.getAddress(recipient), token: to };
  }
  if (payment.to === ethers.ZeroAddress || same(payment.to, safe)) return refuse(REFUSED.badRecipient);
  payment.amount = ethers.formatUnits(payment.raw, payment.decimals).replace(/\.0$/, '');

  // What the bridge says it is sending must be what the transaction sends.
  const claim = offer.claim;
  if (claim && typeof claim === 'object') {
    if (claim.to != null && !same(addr(claim.to), payment.to)) return refuse(REFUSED.claimMismatch);
    if (claim.symbol != null && String(claim.symbol).toUpperCase() !== payment.symbol) return refuse(REFUSED.claimMismatch);
    if (claim.amount != null) {
      let claimed;
      try { claimed = ethers.parseUnits(String(claim.amount), payment.decimals); } catch { return refuse(REFUSED.claimMismatch); }
      if (claimed !== payment.raw) return refuse(REFUSED.claimMismatch);
    }
  }

  const domain = { chainId, verifyingContract: safe };
  const message = {
    to, value: value.toString(), data, operation: 0,
    safeTxGas: '0', baseGas: '0', gasPrice: '0',
    gasToken: ethers.ZeroAddress, refundReceiver: ethers.ZeroAddress, nonce: nonce.toString(),
  };
  const safeTxHash = ethers.TypedDataEncoder.hash(domain, SAFE_TX_TYPES, message);
  // The bridge relays what it stored; if its hash differs from ours, what it would send isn't this.
  if (offer.safeTxHash != null && String(offer.safeTxHash).toLowerCase() !== safeTxHash) return refuse(REFUSED.hashMismatch);

  const { raw, ...shown } = payment;
  return {
    ok: true,
    payment: { ...shown, raw: raw.toString() },
    safeTxHash,
    typedData: { domain, types: { EIP712Domain: DOMAIN_TYPE, ...SAFE_TX_TYPES }, primaryType: 'SafeTx', message },
    text: paymentText(payment),
  };
}
