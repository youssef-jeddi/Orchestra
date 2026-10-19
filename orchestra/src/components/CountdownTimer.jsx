'use client';

import { useMemo, useSyncExternalStore } from 'react';
import { motion } from 'framer-motion';

// Date de launch — à ajuster librement.
export const LAUNCH_DATE = '2026-12-01T12:00:00Z';

const EASE  = [0.16, 1, 0.3, 1];
const UNITS = [
  ['days',    'Days'],
  ['hours',   'Hours'],
  ['minutes', 'Minutes'],
  ['seconds', 'Seconds'],
];

// Horloge externe : un tick par seconde, snapshot stable (entier de secondes).
function subscribe(onTick) {
  const id = setInterval(onTick, 1000);
  return () => clearInterval(id);
}
const clientNow = () => Math.floor(Date.now() / 1000);
const serverNow = () => null;

function remaining(target, nowSec) {
  const s = Math.max(0, Math.floor(target / 1000) - nowSec);
  return {
    days:    Math.floor(s / 86400),
    hours:   Math.floor((s % 86400) / 3600),
    minutes: Math.floor((s % 3600) / 60),
    seconds: s % 60,
  };
}

export default function CountdownTimer({ date = LAUNCH_DATE }) {
  const target = useMemo(() => new Date(date).getTime(), [date]);

  // null au rendu serveur / à l'hydratation : le compte à rebours ne vit que
  // côté client, ce qui évite tout mismatch.
  const nowSec = useSyncExternalStore(subscribe, clientNow, serverNow);
  const left =
    nowSec === null || Number.isNaN(target) ? null : remaining(target, nowSec);

  return (
    <motion.section
      initial={{ opacity: 0, y: 24 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.4 }}
      transition={{ duration: 0.8, ease: EASE }}
      className="px-6 py-20 sm:px-8"
    >
      <div className="mx-auto flex max-w-3xl flex-col items-center">
        <p
          className="text-[10px] uppercase sm:text-[11px]"
          style={{ color: 'var(--text-3)', letterSpacing: '0.24em', lineHeight: 1.6 }}
        >
          The first movement begins in
        </p>

        <div className="mt-8 grid w-full max-w-md grid-cols-2 gap-3 sm:max-w-none sm:grid-cols-4 sm:gap-4">
          {UNITS.map(([key, label], i) => (
            <motion.div
              key={key}
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, amount: 0.4 }}
              transition={{ duration: 0.6, delay: 0.1 * i, ease: EASE }}
              className="flex flex-col items-center rounded-2xl px-4 py-6"
              style={{
                background: 'rgba(255,255,255,0.08)',
                backdropFilter: 'blur(20px)',
                border: '1px solid rgba(255,255,255,0.12)',
              }}
            >
              <span
                className="text-3xl sm:text-4xl"
                style={{
                  fontFamily: 'var(--font-playfair, serif)',
                  fontWeight: 400,
                  color: 'var(--gold)',
                  lineHeight: 1.2,
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {left ? String(left[key]).padStart(2, '0') : '--'}
              </span>
              <span
                className="mt-2 text-[9px] uppercase sm:text-[10px]"
                style={{ color: 'var(--text-2)', letterSpacing: '0.2em', lineHeight: 1.6 }}
              >
                {label}
              </span>
            </motion.div>
          ))}
        </div>
      </div>
    </motion.section>
  );
}
