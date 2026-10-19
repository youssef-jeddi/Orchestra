'use client';

import { motion } from 'framer-motion';

// Initiales + teinte — pas d'images externes, tout est généré en CSS.
const CONDUCTORS = [
  { initials: 'SY', tint: 'rgba(192,132,252,0.18)' },
  { initials: 'YJ', tint: 'rgba(212,175,55,0.16)'  },
  { initials: 'HE', tint: 'rgba(232,228,222,0.10)' },
  { initials: 'AM', tint: 'rgba(192,132,252,0.12)' },
  { initials: 'LK', tint: 'rgba(212,175,55,0.10)'  },
];

export default function AvatarStack({ count = 500 }) {
  return (
    <div className="flex flex-col items-center gap-3 sm:flex-row sm:gap-4">
      <div className="flex items-center">
        {CONDUCTORS.map((c, i) => (
          <motion.div
            key={c.initials}
            initial={{ opacity: 0, scale: 0.8, x: -8 }}
            animate={{ opacity: 1, scale: 1, x: 0 }}
            transition={{ duration: 0.5, delay: 0.1 * i, ease: [0.16, 1, 0.3, 1] }}
            className="flex h-9 w-9 items-center justify-center rounded-full"
            style={{
              marginLeft: i === 0 ? 0 : -10,
              zIndex: CONDUCTORS.length - i,
              background: c.tint,
              backdropFilter: 'blur(20px)',
              border: '1px solid rgba(255,255,255,0.12)',
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

      <p
        className="text-center text-[12px] uppercase sm:text-left"
        style={{ color: 'var(--text-2)', letterSpacing: '0.16em', lineHeight: 1.6 }}
      >
        Join {count}+ early conductors
      </p>
    </div>
  );
}
