'use client';

import { useEffect, useRef } from 'react';
import { animate, motion, useInView } from 'framer-motion';

// Initiales + teinte — pas d'images externes, tout est généré en CSS.
const CONDUCTORS = [
  { initials: 'SY', tint: 'rgba(192,132,252,0.18)' },
  { initials: 'YJ', tint: 'rgba(212,175,55,0.16)'  },
  { initials: 'HE', tint: 'rgba(232,228,222,0.10)' },
  { initials: 'AM', tint: 'rgba(192,132,252,0.12)' },
  { initials: 'LK', tint: 'rgba(212,175,55,0.10)'  },
];

const EASE = [0.16, 1, 0.3, 1];

export default function AvatarStack({ target = 500 }) {
  const wrapRef  = useRef(null);
  const countRef = useRef(null);
  const inView   = useInView(wrapRef, { once: true, amount: 0.6 });

  // Compteur animé 0 → target, écrit directement dans le DOM (comme
  // TotalCounter dans PresentationFlow) : pas de re-render par frame.
  useEffect(() => {
    if (!inView) return;

    const node = countRef.current;
    if (!node) return;

    const controls = animate(0, target, {
      duration: 2,
      delay: 0.2,
      ease: EASE,
      onUpdate: (v) => {
        node.textContent = String(Math.floor(v));
      },
    });

    return () => controls.stop();
  }, [inView, target]);

  return (
    <div ref={wrapRef} className="flex flex-col items-center gap-3 sm:flex-row sm:gap-4">
      <div className="flex items-center">
        {CONDUCTORS.map((c, i) => (
          <motion.div
            key={c.initials}
            initial={{ opacity: 0, scale: 0.85, x: -8 }}
            animate={{ opacity: 1, scale: 1, x: 0 }}
            transition={{ duration: 0.8, delay: 0.12 * i, ease: EASE }}
            className="avatar-ring eyebrow flex h-9 w-9 items-center justify-center rounded-full"
            style={{
              marginLeft: i === 0 ? 0 : -10,
              zIndex: CONDUCTORS.length - i,
              background: c.tint,
              backdropFilter: 'blur(20px)',
              WebkitBackdropFilter: 'blur(20px)',
              border: '1px solid var(--border-hi)',
              color: 'var(--text-1)',
              fontSize: 10,
              letterSpacing: '0.08em',
              lineHeight: 1,
            }}
          >
            {c.initials}
          </motion.div>
        ))}
      </div>

      <p className="eyebrow text-center sm:text-left" style={{ color: 'var(--text-2)' }}>
        Join{' '}
        <span ref={countRef} style={{ color: 'var(--text-1)', fontVariantNumeric: 'tabular-nums' }}>
          0
        </span>
        + early conductors
      </p>
    </div>
  );
}
