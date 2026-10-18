// ── Privy: one sign-in window for newcomers and crypto users ──
// Newcomers sign up with a passkey (or email) and Privy creates a wallet for
// them; people who already use crypto connect MetaMask, Phantom, Coinbase,
// Rabby, Trust (WalletConnect)… Either way the wallet address is the Safe owner
// and the bridge session comes from Privy's identity token (/auth/privy).
//
// Without NEXT_PUBLIC_PRIVY_APP_ID the app falls back to MetaMask + Ledger.

import { sepolia } from 'viem/chains';

export const PRIVY_APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID || '';

export const privyConfig = {
  // Each method must also be enabled in the Privy dashboard.
  loginMethods: ['passkey', 'email', 'wallet'],
  appearance: {
    theme: '#0F0F12',
    accentColor: '#C084FC',
    landingHeader: 'Sign in to Orchestra',
    loginMessage: 'Use a passkey or your email. Already have a wallet? Connect it.',
    walletChainType: 'ethereum-only',
    // Rabby and other browser wallets show up under detected wallets; Trust and
    // mobile wallets through WalletConnect.
    walletList: ['detected_ethereum_wallets', 'metamask', 'phantom', 'coinbase_wallet', 'rainbow', 'wallet_connect'],
  },
  // Only users who arrive without a wallet get one: the passkey/email path.
  embeddedWallets: { ethereum: { createOnLogin: 'users-without-wallets' } },
  // Embedded wallets start on the first supported chain. No `defaultChain`: with it,
  // Privy switches an external wallet's network right after connecting, while the
  // wallet is still busy with sign-in, which crashed MetaMask's popup (ORC-62).
  // ensureSepolia switches before the first transaction or Permit2 signature.
  supportedChains: [sepolia],
};
