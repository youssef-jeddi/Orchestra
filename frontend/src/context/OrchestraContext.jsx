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
  // Privy puts its children in a list next to its own overlays; an unkeyed element there
  // triggers React's "unique key" warning that names this component as the owner.
  const app = <OrchestraState key="orchestra">{children}</OrchestraState>;
  if (!PRIVY_APP_ID) return app;
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
