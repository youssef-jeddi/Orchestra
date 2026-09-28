'use client';

import { createContext, useContext } from 'react';
import { useLedger } from '@/hooks/useLedger';
import { useBridge } from '@/hooks/useBridge';
import { useSafe } from '@/hooks/useSafe';
import { useSession } from '@/hooks/useSession';

const OrchestraContext = createContext(null);

export function useOrchestra() {
  const ctx = useContext(OrchestraContext);
  if (!ctx) throw new Error('useOrchestra must be inside OrchestraProvider');
  return ctx;
}

export function OrchestraProvider({ children }) {
  const ledger = useLedger();
  const bridge = useBridge();
  const safe = useSafe(ledger);
  const session = useSession(ledger);

  return (
    <OrchestraContext.Provider value={{ ledger, bridge, safe, session }}>
      {children}
    </OrchestraContext.Provider>
  );
}
