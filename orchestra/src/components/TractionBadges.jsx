'use client';

import { motion } from 'framer-motion';

const EASE = [0.16, 1, 0.3, 1];

const BADGES = [
  { glyph: '🏆', label: '3rd Place ETHGlobal Cannes', sub: '0G Track' },
  { glyph: '🚀', label: 'Uniswap × Crecimiento',      sub: 'Acceleration Season' },
  { glyph: '🔬', label: 'Protocol Labs',              sub: 'Demo Day' },
];

export default function TractionBadges() {
  return (
    <section className="px-6 py-20 sm:px-8">
      <div className="mx-auto flex max-w-4xl flex-col items-center">
        <motion.p
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={{ once: true, amount: 0.5 }}
          transition={{ duration: 0.8, ease: EASE }}
          className="text-[10px] uppercase sm:text-[11px]"
          style={{ color: 'var(--text-3)', letterSpacing: '0.24em', lineHeight: 1.6 }}
        >
          Backed by the stage we played on
        </motion.p>

        <div className="mt-10 flex w-full flex-col items-stretch gap-3 sm:flex-row sm:justify-center sm:gap-4">
          {BADGES.map(({ glyph, label, sub }, i) => (
            <motion.div
              key={label}
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, amount: 0.3 }}
              transition={{ duration: 0.6, delay: 0.1 * i, ease: EASE }}
              className="flex items-center gap-3 rounded-full px-5 py-3"
              style={{
                background: 'rgba(255,255,255,0.08)',
                backdropFilter: 'blur(20px)',
                border: '1px solid rgba(255,255,255,0.12)',
              }}
            >
              <span aria-hidden="true" className="text-sm">
                {glyph}
              </span>
              <span className="flex min-w-0 flex-col">
                <span
                  className="truncate text-xs"
                  style={{ color: 'var(--text-1)', lineHeight: 1.5 }}
                >
                  {label}
                </span>
                <span
                  className="truncate text-[9px] uppercase"
                  style={{ color: 'var(--text-3)', letterSpacing: '0.18em', lineHeight: 1.6 }}
                >
                  {sub}
                </span>
              </span>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}
