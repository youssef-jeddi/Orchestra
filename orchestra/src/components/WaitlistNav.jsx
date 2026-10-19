'use client';

import { motion } from 'framer-motion';

export default function WaitlistNav() {
  return (
    <motion.nav
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
      className="fixed inset-x-0 top-0 z-50 px-6 py-6 sm:px-8"
    >
      <div className="mx-auto flex max-w-5xl items-center">
        <span
          className="text-[13px] uppercase"
          style={{
            fontFamily: 'var(--font-playfair, serif)',
            color: 'var(--text-1)',
            letterSpacing: '0.3em',
            lineHeight: 1.6,
          }}
        >
          Orchestra
        </span>
      </div>
    </motion.nav>
  );
}
