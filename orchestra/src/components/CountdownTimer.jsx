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
    <section className="px-6 py-24 sm:px-8 sm:py-32">
      <div className="mx-auto flex max-w-4xl flex-col items-center">
        <motion.p
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.4 }}
          transition={{ duration: 0.8, ease: EASE }}
          className="eyebrow"
          style={{ color: 'var(--text-3)' }}
        >
          Launching in
        </motion.p>

        <div className="mt-10 grid w-full max-w-lg grid-cols-2 gap-3 sm:max-w-none sm:grid-cols-4 sm:gap-4">
          {UNITS.map(([key, label], i) => (
            <motion.div
              key={key}
              initial={{ opacity: 0, y: 30 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, amount: 0.3 }}
              transition={{ duration: 0.8, delay: 0.12 * i, ease: EASE }}
              className="glass flex flex-col items-center rounded-3xl px-4 py-8"
            >
              <span
                className="display"
                style={{
                  fontSize: 'clamp(36px, 5vw, 64px)',
                  fontWeight: 600,
                  color: 'var(--text-1)',
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {left ? String(left[key]).padStart(2, '0') : '--'}
              </span>
              <span className="eyebrow mt-3" style={{ color: 'var(--text-3)', fontSize: 10 }}>
                {label}
              </span>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}
