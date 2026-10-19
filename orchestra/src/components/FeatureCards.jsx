'use client';

import { motion } from 'framer-motion';
import { BookOpen, Shield, Coins } from 'lucide-react';

const EASE = [0.16, 1, 0.3, 1];

const AGENTS = [
  {
    Icon: BookOpen,
    glyph: '🎵',
    name: 'The Notebook',
    role: 'Planner',
    line: 'Reads every protocol so you don’t have to.',
  },
  {
    Icon: Shield,
    glyph: '🛡️',
    name: 'The Guardian',
    role: 'Gatekeeper',
    line: 'Watches your back, 24/7.',
  },
  {
    Icon: Coins,
    glyph: '💰',
    name: 'The Treasurer',
    role: 'Executor',
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
          className="display text-center"
          style={{
            fontSize: 'clamp(32px, 5vw, 56px)',
            fontWeight: 600,
            color: 'var(--text-1)',
          }}
        >
          Three agents. One score.
        </motion.h2>

        <motion.p
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.5 }}
          transition={{ duration: 0.8, delay: 0.12, ease: EASE }}
          className="mx-auto mt-6 max-w-lg text-center text-base"
          style={{ color: 'var(--text-2)', fontWeight: 300, lineHeight: 1.6 }}
        >
          A Planner, a Gatekeeper and an Executor — each one plays its part before
          a single transaction leaves your wallet.
        </motion.p>

        <div className="mt-16 grid grid-cols-1 gap-5 sm:grid-cols-3 sm:gap-6">
          {AGENTS.map(({ Icon, glyph, name, role, line }, i) => (
            <motion.article
              key={name}
              initial={{ opacity: 0, y: 30 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, amount: 0.3 }}
              transition={{ duration: 0.8, delay: 0.12 * i, ease: EASE }}
              whileHover={{ scale: 1.03 }}
              className="glass flex flex-col rounded-3xl p-8"
              style={{
                transition:
                  'border-color 0.4s var(--ease), box-shadow 0.4s var(--ease)',
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
              <div className="flex items-center justify-between">
                <span
                  className="flex h-11 w-11 items-center justify-center rounded-2xl"
                  style={{
                    background: 'rgba(192,132,252,0.08)',
                    border: '1px solid rgba(192,132,252,0.18)',
                  }}
                >
                  <Icon size={18} strokeWidth={1.4} style={{ color: 'var(--accent)' }} />
                </span>
                <span className="eyebrow" style={{ color: 'var(--text-3)', fontSize: 10 }}>
                  {role}
                </span>
              </div>

              <h3
                className="display mt-8"
                style={{
                  fontSize: 22,
                  fontWeight: 600,
                  letterSpacing: '-0.02em',
                  color: 'var(--text-1)',
                  lineHeight: 1.3,
                }}
              >
                <span aria-hidden="true" className="mr-2">
                  {glyph}
                </span>
                {name}
              </h3>

              <p
                className="mt-3.5 text-sm"
                style={{ color: 'var(--text-2)', fontWeight: 300, lineHeight: 1.6 }}
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
