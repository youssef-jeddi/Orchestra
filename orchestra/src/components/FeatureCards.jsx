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
    <section className="px-6 py-20 sm:px-8 sm:py-28">
      <div className="mx-auto max-w-5xl">
        <motion.h2
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.5 }}
          transition={{ duration: 0.8, ease: EASE }}
          className="text-center text-2xl sm:text-4xl"
          style={{
            fontFamily: 'var(--font-playfair, serif)',
            fontWeight: 400,
            color: 'var(--text-1)',
            lineHeight: 1.3,
          }}
        >
          Three agents. One score.
        </motion.h2>

        <motion.p
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.5 }}
          transition={{ duration: 0.8, delay: 0.1, ease: EASE }}
          className="mx-auto mt-5 max-w-lg text-center text-sm"
          style={{ color: 'var(--text-2)', lineHeight: 1.8 }}
        >
          A Planner, a Gatekeeper and an Executor — each one plays its part before
          a single transaction leaves your wallet.
        </motion.p>

        <div className="mt-14 grid grid-cols-1 gap-5 sm:grid-cols-3 sm:gap-6">
          {AGENTS.map(({ Icon, glyph, name, role, line }, i) => (
            <motion.article
              key={name}
              initial={{ opacity: 0, y: 24 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, amount: 0.3 }}
              transition={{ duration: 0.7, delay: 0.1 * i, ease: EASE }}
              whileHover={{ scale: 1.02 }}
              className="group flex flex-col rounded-2xl p-7"
              style={{
                background: 'var(--bg-card)',
                border: '1px solid var(--border)',
                transition:
                  'border-color 0.3s cubic-bezier(0.16,1,0.3,1), box-shadow 0.3s cubic-bezier(0.16,1,0.3,1)',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = 'var(--border-hi)';
                e.currentTarget.style.boxShadow   = '0 0 30px rgba(192,132,252,0.1)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = 'var(--border)';
                e.currentTarget.style.boxShadow   = 'none';
              }}
            >
              <div className="flex items-center justify-between">
                <span
                  className="flex h-10 w-10 items-center justify-center rounded-xl"
                  style={{
                    background: 'rgba(192,132,252,0.08)',
                    border: '1px solid rgba(192,132,252,0.18)',
                  }}
                >
                  <Icon size={17} strokeWidth={1.4} style={{ color: 'var(--accent)' }} />
                </span>
                <span
                  className="text-[9px] uppercase"
                  style={{ color: 'var(--text-3)', letterSpacing: '0.2em', lineHeight: 1.6 }}
                >
                  {role}
                </span>
              </div>

              <h3
                className="mt-7 text-xl"
                style={{
                  fontFamily: 'var(--font-playfair, serif)',
                  fontWeight: 400,
                  color: 'var(--text-1)',
                  lineHeight: 1.4,
                }}
              >
                <span aria-hidden="true" className="mr-2">
                  {glyph}
                </span>
                {name}
              </h3>

              <p className="mt-3 text-sm" style={{ color: 'var(--text-2)', lineHeight: 1.8 }}>
                {line}
              </p>
            </motion.article>
          ))}
        </div>
      </div>
    </section>
  );
}
