'use client';

import { useCallback, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import VideoIntro      from '@/components/VideoIntro';
import WaitlistNav     from '@/components/WaitlistNav';
import WaitlistHero    from '@/components/WaitlistHero';
import FeatureCards    from '@/components/FeatureCards';
import TractionBadges  from '@/components/TractionBadges';
import WaitlistFooter  from '@/components/WaitlistFooter';

export default function Home() {
  const [introDone, setIntroDone] = useState(false);
  const finishIntro = useCallback(() => setIntroDone(true), []);

  return (
    <>
      {/* Intro vidéo — le contenu est déjà monté en dessous */}
      <AnimatePresence>
        {!introDone && (
          <motion.div
            key="intro"
            className="fixed inset-0 z-[60]"
            style={{ background: 'var(--bg)' }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
          >
            <VideoIntro onDone={finishIntro} />
          </motion.div>
        )}
      </AnimatePresence>

      <WaitlistNav />

      <main>
        <WaitlistHero />
        <FeatureCards />
        <TractionBadges />
      </main>

      <WaitlistFooter />
    </>
  );
}
