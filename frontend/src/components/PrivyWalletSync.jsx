'use client';

// Mirrors the Privy sign-in into useLedger: once the user is signed in (passkey,
// email or an external wallet) and Privy has issued an identity token, their
// wallet becomes the app's wallet, exactly like a MetaMask connection. The
// identity token is what /auth/privy turns into a bridge session.

import { useEffect } from 'react';
import { usePrivy, useWallets, useIdentityToken } from '@privy-io/react-auth';

// The wallet the user signed in with. A passkey/email user only has the embedded
// one; a wallet user has theirs (Privy creates no embedded wallet for them).
function pickWallet(wallets) {
  const linked = wallets.filter((w) => w.linked);
  return linked.find((w) => w.walletClientType !== 'privy') || linked.find((w) => w.walletClientType === 'privy') || null;
}

export default function PrivyWalletSync({ ledger }) {
  const { ready, authenticated, login, logout } = usePrivy();
  const { wallets, ready: walletsReady } = useWallets();
  const { identityToken } = useIdentityToken();
  const { attachWallet, detachWallet, setPrivy } = ledger;

  useEffect(() => {
    setPrivy({ ready, login, logout, identityToken });
  }, [setPrivy, ready, login, logout, identityToken]);

  const wallet = authenticated && walletsReady ? pickWallet(wallets) : null;
  const address = wallet?.address;
  const embedded = wallet?.walletClientType === 'privy';
  const hasToken = !!identityToken;

  useEffect(() => {
    if (!wallet || !hasToken) { detachWallet(); return; }
    let alive = true;
    wallet.getEthereumProvider()
      .then((provider) => {
        if (!alive) return;
        attachWallet({
          address,
          provider,
          type: embedded ? 'privy' : 'external',
          label: embedded ? 'Passkey' : wallet.meta?.name || 'Wallet',
        });
      })
      .catch((err) => ledger.log(`Wallet unavailable: ${err.message}`));
    return () => { alive = false; };
  }, [address, embedded, hasToken]); // eslint-disable-line react-hooks/exhaustive-deps -- re-attach only when the wallet itself changes

  return null;
}
