'use client';

import { motion, useScroll, useTransform, useSpring } from 'framer-motion';

export default function ScrollTrack() {
  const { scrollYProgress } = useScroll();
  const smoothProgress = useSpring(scrollYProgress, { stiffness: 120, damping: 30 });
  const top = useTransform(smoothProgress, [0, 1], ['0%', '85%']);

  return (
    <div
      style={{
        position: 'fixed',
        right: 12,
        top: '10%',
        height: '80%',
        width: 4,
        background: 'rgba(255,255,255,0.06)',
        borderRadius: 100,
        zIndex: 40,
        pointerEvents: 'none',
      }}
    >
      <motion.div
        style={{
          position: 'absolute',
          top,
          left: 0,
          width: '100%',
          height: '15%',
          background: 'rgba(255,255,255,0.25)',
          borderRadius: 100,
        }}
      />
    </div>
  );
}
