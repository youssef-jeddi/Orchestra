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
    <section className="px-6 pb-24 sm:px-8 sm:pb-32">
      <div className="mx-auto flex max-w-4xl flex-col items-center">
        <motion.p
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.5 }}
          transition={{ duration: 0.8, ease: EASE }}
          className="eyebrow"
          style={{ color: 'var(--text-3)' }}
        >
          Backed by the stage we played on
        </motion.p>

        <div className="mt-10 flex w-full flex-col items-stretch gap-3 sm:flex-row sm:justify-center sm:gap-4">
          {BADGES.map(({ glyph, label, sub }, i) => (
            <motion.div
              key={label}
              initial={{ opacity: 0, y: 30 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, amount: 0.3 }}
              transition={{ duration: 0.8, delay: 0.12 * i, ease: EASE }}
              className="glass flex items-center gap-3 rounded-full px-5 py-3"
            >
              <span aria-hidden="true" className="text-sm">
                {glyph}
              </span>
              <span className="flex min-w-0 flex-col">
                <span
                  className="truncate text-xs"
                  style={{ color: 'var(--text-1)', fontWeight: 400, lineHeight: 1.5 }}
                >
                  {label}
                </span>
                <span className="eyebrow truncate" style={{ color: 'var(--text-3)', fontSize: 9 }}>
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
