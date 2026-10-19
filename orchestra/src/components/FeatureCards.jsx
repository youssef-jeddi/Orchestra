'use client';

import { motion } from 'framer-motion';

const EASE = [0.16, 1, 0.3, 1];

const AGENTS = [
  {
    role: 'Planner',
    name: 'The Notebook',
    line: 'Reads every protocol so you don’t have to.',
  },
  {
    role: 'Gatekeeper',
    name: 'The Guardian',
    line: 'Watches your back, 24/7.',
  },
  {
    role: 'Executor',
    name: 'The Treasurer',
    line: 'Knows where your money works hardest.',
  },
];

export default function FeatureCards() {
  return (
    <section className="px-6 py-24 sm:px-8 sm:py-32">
      <div className="mx-auto max-w-5xl">
        <motion.h2
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.5 }}
          transition={{ duration: 0.8, ease: EASE }}
          className="display-section text-center"
          style={{ color: 'var(--text-1)' }}
        >
          Three agents. One score.
        </motion.h2>

        <motion.p
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.5 }}
          transition={{ duration: 0.8, delay: 0.12, ease: EASE }}
          className="mx-auto mt-6 max-w-lg text-center"
          style={{ color: 'var(--text-2)', fontSize: 17, fontWeight: 300, lineHeight: 1.6 }}
        >
          A Planner, a Gatekeeper and an Executor — each one plays its part before
          a single transaction leaves your wallet.
        </motion.p>

        <div className="mt-16 grid grid-cols-1 gap-5 sm:grid-cols-3 sm:gap-6">
          {AGENTS.map(({ role, name, line }, i) => (
            <motion.article
              key={name}
              initial={{ opacity: 0, y: 30 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, amount: 0.3 }}
              transition={{ duration: 0.8, delay: 0.12 * i, ease: EASE }}
              whileHover={{ scale: 1.03 }}
              className="glass flex flex-col rounded-3xl p-8"
              style={{
                transition: 'border-color 0.4s var(--ease), box-shadow 0.4s var(--ease)',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = 'var(--border-hi)';
                e.currentTarget.style.boxShadow   = '0 0 40px rgba(192,132,252,0.12)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = '';
                e.currentTarget.style.boxShadow   = 'none';
              }}
            >
              <span className="eyebrow self-end" style={{ color: 'var(--text-3)', fontSize: 10 }}>
                {role}
              </span>

              <h3
                className="display mt-10"
                style={{ fontSize: 24, color: 'var(--text-1)' }}
              >
                {name}
              </h3>

              <p
                className="mt-3.5"
                style={{
                  color: 'var(--text-2)',
                  fontSize: 15,
                  fontWeight: 300,
                  lineHeight: 1.6,
                }}
              >
                {line}
              </p>
            </motion.article>
          ))}
        </div>
      </div>
    </section>
  );
}
