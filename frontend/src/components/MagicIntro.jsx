'use client';

import { motion } from 'framer-motion';
import MagicButton from './MagicButton';

// ─── Variants ─────────────────────────────────────────────────────
const titleContainer = {
  hidden:  {},
  visible: { transition: { staggerChildren: 0.04, delayChildren: 0.2 } },
};

const letterVariant = {
  hidden:  { opacity: 0, filter: 'blur(10px)', y: 12 },
  visible: {
    opacity: 1, filter: 'blur(0px)', y: 0,
    transition: { duration: 0.6, ease: [0.16, 1, 0.3, 1] },
  },
};

// ─── MagicIntro ───────────────────────────────────────────────────
// S'affiche APRÈS la fin de LoadingIntro (monté par page.js).
// Fond transparent — la scène 3D est visible en arrière-plan.

export default function MagicIntro() {
  return (
    <section
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'transparent',
        position: 'relative',
        zIndex: 10,
        gap: '2.5rem',
        padding: 'clamp(2rem, 8vh, 6rem) 2rem',
        textAlign: 'center',
        pointerEvents: 'none',
      }}
    >
      {/* ── Titre — énorme, fin, centré ── */}
      <motion.h1
        variants={titleContainer}
        initial="hidden"
        animate="visible"
        style={{
          fontSize: 'clamp(3.5rem, 9vw, 8rem)',
          fontFamily: 'var(--font-playfair)',
          fontWeight: 400,
          color: '#E8E4DE',
          letterSpacing: '-0.03em',
          lineHeight: 1.05,
          margin: 0,
        }}
      >
        {'Orchestra'.split('').map((char, i) => (
          <motion.span key={i} variants={letterVariant} style={{ display: 'inline-block' }}>
            {char}
          </motion.span>
        ))}
      </motion.h1>

      {/* ── Sous-titre ── */}
      <motion.p
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.8, duration: 0.7, ease: 'easeOut' }}
        style={{
          fontFamily: 'var(--font-inter)',
          fontSize: 12,
          fontWeight: 300,
          color: '#666',
          letterSpacing: '0.2em',
          textTransform: 'uppercase',
          margin: 0,
        }}
      >
        Your AI-Powered DeFi Conductor
      </motion.p>

      {/* ── CTA ghost button ── */}
      <MagicButton
        aria-label="Start the Orchestra app"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 1.1, duration: 0.6, ease: 'easeOut' }}
        hoverBg="#C084FC"
        hoverColor="#000"
        style={{
          padding: '13px 40px',
          borderRadius: 4,
          background: 'transparent',
          color: '#E8E4DE',
          fontSize: 12,
          fontFamily: 'var(--font-inter)',
          fontWeight: 400,
          letterSpacing: '0.15em',
          textTransform: 'uppercase',
          border: '1px solid #333',
          pointerEvents: 'auto',
          cursor: 'none',
          transition: 'background 0.35s ease, color 0.35s ease',
        }}
      >
        Start the Symphony
      </MagicButton>
    </section>
  );
}
