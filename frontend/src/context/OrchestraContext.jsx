'use client';

import { createContext, useContext } from 'react';
import { PrivyProvider } from '@privy-io/react-auth';
import { useLedger } from '@/hooks/useLedger';
import { useBridge } from '@/hooks/useBridge';
import { useSafe } from '@/hooks/useSafe';
import { useSession } from '@/hooks/useSession';
import { PRIVY_APP_ID, privyConfig } from '@/lib/privy';
import PrivyWalletSync from '@/components/PrivyWalletSync';

const OrchestraContext = createContext(null);

export function useOrchestra() {
  const ctx = useContext(OrchestraContext);
  if (!ctx) throw new Error('useOrchestra must be inside OrchestraProvider');
  return ctx;
}

export function OrchestraProvider({ children }) {
  const app = <OrchestraState>{children}</OrchestraState>;
  if (!PRIVY_APP_ID) return app;
  return <PrivyProvider appId={PRIVY_APP_ID} config={privyConfig}>{app}</PrivyProvider>;
}

function OrchestraState({ children }) {
  const ledger = useLedger();
  const bridge = useBridge();
  const safe = useSafe(ledger);
  const session = useSession(ledger);

  return (
    <OrchestraContext.Provider value={{ ledger, bridge, safe, session }}>
      {PRIVY_APP_ID && <PrivyWalletSync ledger={ledger} />}
      {children}
    </OrchestraContext.Provider>
  );
}
