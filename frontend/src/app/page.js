'use client';

import { useState, useCallback, useEffect } from 'react';
import dynamic from 'next/dynamic';
import { motion, AnimatePresence } from 'framer-motion';
import LoadingIntro   from '@/components/LoadingIntro';
import CustomCursor   from '@/components/CustomCursor';
import ScrollTrack    from '@/components/ScrollTrack';
import ConnectWallet  from '@/components/ConnectWallet';
import { OrchestraProvider } from '@/context/OrchestraContext';
import ApprovalOverlay from '@/components/ApprovalOverlay';
import SafePanel from '@/components/SafePanel';
import PolicyPanel from '@/components/PolicyPanel';

const PresentationFlow   = dynamic(() => import('@/components/PresentationFlow'),   { loading: () => null });
const FuturisticNotebook = dynamic(() => import('@/components/FuturisticNotebook'), { loading: () => null });

export default function Home() {
  const [introComplete, setIntroComplete] = useState(false);
  const [notebookOpen, setNotebookOpen]   = useState(false);
  const [initialMsg, setInitialMsg]       = useState('');

  const handleIntroComplete = useCallback(() => {
    setIntroComplete(true);
    setTimeout(() => {
      window.scrollTo({ top: Math.round(window.innerHeight * 0.08), behavior: 'smooth' });
    }, 200);
  }, []);

  const openNotebook = useCallback((msg = '') => {
    setInitialMsg(msg);
    setNotebookOpen(true);
  }, []);

  const closeNotebook = useCallback(() => {
    setNotebookOpen(false);
    setInitialMsg('');
    window.dispatchEvent(new Event('close-scholar-notebook'));
  }, []);

  useEffect(() => {
    console.log('notebookOpen:', notebookOpen);
  }, [notebookOpen]);

  return (
    <OrchestraProvider>
      {!introComplete && (
        <LoadingIntro onComplete={handleIntroComplete} />
      )}

      {introComplete && (
        <>
          <CustomCursor />
          <ScrollTrack />
          <ConnectWallet />
          <ApprovalOverlay />
          <SafePanel />
          <PolicyPanel />
          <motion.main
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.8, ease: 'easeOut' }}
          >
            <PresentationFlow onOpenNotebook={openNotebook} />
          </motion.main>

          <AnimatePresence>
            {notebookOpen && (
              <FuturisticNotebook
                onClose={closeNotebook}
                initialMessage={initialMsg}
              />
            )}
          </AnimatePresence>
        </>
      )}
    </OrchestraProvider>
  );
}
