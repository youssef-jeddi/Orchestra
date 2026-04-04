'use client';

import { createContext, useContext } from 'react';
import { useLedger } from '@/hooks/useLedger';
import { useBridge } from '@/hooks/useBridge';
import { useSafe } from '@/hooks/useSafe';

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

  return (
    <OrchestraContext.Provider value={{ ledger, bridge, safe }}>
      {children}
    </OrchestraContext.Provider>
  );
}
