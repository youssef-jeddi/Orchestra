'use client';

import { motion } from 'framer-motion';

const EASE = [0.16, 1, 0.3, 1];

const BADGES = [
  { title: '3rd Place ETHGlobal Cannes', sub: '0G Track' },
  { title: 'Uniswap × Crecimiento',      sub: 'Acceleration Season' },
  { title: 'Protocol Labs',              sub: 'Demo Day' },
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
          {BADGES.map(({ title, sub }, i) => (
            <motion.div
              key={title}
              initial={{ opacity: 0, y: 30 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, amount: 0.3 }}
              transition={{ duration: 0.8, delay: 0.12 * i, ease: EASE }}
              className="glass flex flex-col items-center rounded-full px-6 py-3.5 sm:items-start"
            >
              <span
                style={{
                  color: 'var(--text-1)',
                  fontSize: 13,
                  fontWeight: 400,
                  lineHeight: 1.5,
                }}
              >
                {title}
              </span>
              <span className="eyebrow" style={{ color: 'var(--text-3)', fontSize: 9 }}>
                {sub}
              </span>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}
