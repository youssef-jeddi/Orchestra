'use client';

import { useCallback } from 'react';
import { motion } from 'framer-motion';

const EASE = [0.16, 1, 0.3, 1];

export default function WaitlistNav() {
  // Ramène au champ email du hero et le met au focus.
  const focusEmail = useCallback(() => {
    const input = document.getElementById('waitlist-email');
    if (!input) return;
    input.scrollIntoView({ behavior: 'smooth', block: 'center' });
    input.focus({ preventScroll: true });
  }, []);

  return (
    <motion.nav
      initial={{ opacity: 0, y: -12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.8, ease: EASE }}
      className="fixed inset-x-0 top-0 z-50 px-4 pt-4 sm:px-6 sm:pt-5"
    >
      <div className="glass mx-auto flex max-w-5xl items-center justify-between rounded-full px-5 py-2.5 sm:px-6">
        <span className="wordmark" style={{ color: 'var(--text-1)' }}>
          Orchestra
        </span>

        <button
          type="button"
          onClick={focusEmail}
          className="eyebrow rounded-full px-4 py-2"
          style={{
            background: 'rgba(255,255,255,0.06)',
            border: '1px solid var(--border-hi)',
            color: 'var(--text-1)',
            fontSize: 10,
            transition: 'background 0.4s var(--ease), box-shadow 0.4s var(--ease)',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'rgba(192,132,252,0.12)';
            e.currentTarget.style.boxShadow  = '0 0 24px rgba(192,132,252,0.18)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'rgba(255,255,255,0.06)';
            e.currentTarget.style.boxShadow  = 'none';
          }}
        >
          Get Early Access
        </button>
      </div>
    </motion.nav>
  );
}
