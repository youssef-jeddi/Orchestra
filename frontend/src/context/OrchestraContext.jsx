'use client';

import { createContext, useContext } from 'react';
import { PrivyProvider } from '@privy-io/react-auth';
import { useLedger } from '@/hooks/useLedger';
import { useBridge } from '@/hooks/useBridge';
import { useSafe } from '@/hooks/useSafe';
import { useSession } from '@/hooks/useSession';
import { PRIVY_APP_ID, privyConfig } from '@/lib/privy';
import PrivyWalletSync from '@/components/PrivyWalletSync';
import OAuthReturn from '@/components/OAuthReturn';

const OrchestraContext = createContext(null);

export function useOrchestra() {
  const ctx = useContext(OrchestraContext);
  if (!ctx) throw new Error('useOrchestra must be inside OrchestraProvider');
  return ctx;
}

export function OrchestraProvider({ children }) {
  const app = <OrchestraState>{children}</OrchestraState>;
  if (!PRIVY_APP_ID) return app;
  // React may log "Each child in a list should have a unique key" with this line as the visible
  // frame once the sign-in window opens for someone whose last login was a wallet. That comes from
  // inside Privy's landing screen (@privy-io/react-auth 3.48–3.50: the "Last used" wallet row has no
  // key), not from a list of ours, and it is harmless. Nothing here can fix it.
  return <PrivyProvider appId={PRIVY_APP_ID} config={privyConfig}>{app}</PrivyProvider>;
}

function OrchestraState({ children }) {
  const ledger = useLedger();
  const session = useSession(ledger);
  const bridge = useBridge(ledger.walletAddress, session.ready);
  const safe = useSafe(ledger, session);

  return (
    <OrchestraContext.Provider value={{ ledger, bridge, safe, session }}>
      {PRIVY_APP_ID && <PrivyWalletSync ledger={ledger} />}
      {PRIVY_APP_ID && <OAuthReturn />}
      {children}
    </OrchestraContext.Provider>
  );
}
