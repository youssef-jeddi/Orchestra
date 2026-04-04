'use client';

import { useEffect, useRef, useState } from 'react';
import { motion, useMotionValue, useSpring } from 'framer-motion';

const PARTICLE_POOL = [
  { type: 'circle', color: '#444' },
  { type: 'circle', color: '#333' },
  { type: 'circle', color: '#444' },
  { type: 'circle', color: '#333' },
];

const MAX_PARTICLES = 20;

export default function CustomCursor() {
  const [isTouch,   setIsTouch]   = useState(true); // true until we confirm pointer device
  const [particles, setParticles] = useState([]);
  const lastSpawnRef = useRef(0);
  const idRef        = useRef(0);

  const rawX = useMotionValue(-100);
  const rawY = useMotionValue(-100);
  const x = useSpring(rawX, { stiffness: 500, damping: 30, mass: 0.3 });
  const y = useSpring(rawY, { stiffness: 500, damping: 30, mass: 0.3 });

  useEffect(() => {
    // Masquer le curseur custom sur les appareils tactiles (pas de survol)
    const mq = window.matchMedia('(hover: none) and (pointer: coarse)');
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsTouch(mq.matches);
    const onChange = (e) => setIsTouch(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    if (isTouch) return;

    const onMove = (e) => {
      rawX.set(e.clientX);
      rawY.set(e.clientY);

      const now = Date.now();
      if (now - lastSpawnRef.current < 50) return;
      lastSpawnRef.current = now;

      const template = PARTICLE_POOL[Math.floor(Math.random() * PARTICLE_POOL.length)];
      const id = idRef.current++;
      const px = e.clientX + (Math.random() - 0.5) * 20;
      const py = e.clientY + (Math.random() - 0.5) * 20;

      // Limite à MAX_PARTICLES simultanées
      setParticles((prev) => {
        const trimmed = prev.length >= MAX_PARTICLES ? prev.slice(1) : prev;
        return [...trimmed, { id, x: px, y: py, ...template }];
      });
      setTimeout(() => setParticles((prev) => prev.filter((p) => p.id !== id)), 850);
    };

    window.addEventListener('mousemove', onMove);
    return () => window.removeEventListener('mousemove', onMove);
  }, [isTouch, rawX, rawY]);

  if (isTouch) return null;

  return (
    <>
      {/* Curseur clé de sol */}
      <motion.div
        aria-hidden="true"
        className="fixed top-0 left-0 pointer-events-none"
        style={{ x, y, zIndex: 99999, willChange: 'transform' }}
      >
        <div style={{ transform: 'translate(-10px, -4px)' }}>
          <span
            style={{
              fontSize: 26,
              lineHeight: 1,
              display: 'block',
              color: '#666',
              userSelect: 'none',
              textShadow: '0 2px 4px rgba(0,0,0,0.5), 0 0 8px rgba(192,132,252,0.15)',
            }}
          >
            𝄞
          </span>
        </div>
      </motion.div>

      {/* Particules trail */}
      {particles.map((p) => (
        <motion.div
          key={p.id}
          aria-hidden="true"
          className="fixed pointer-events-none"
          style={{ left: p.x - 8, top: p.y - 8, zIndex: 99998, willChange: 'transform, opacity' }}
          initial={{ opacity: 1, y: 0, scale: 1 }}
          animate={{ opacity: 0, y: -36, scale: 0.5 }}
          transition={{ duration: 0.8, ease: 'easeOut' }}
        >
          <div
            style={{
              width: 7,
              height: 7,
              borderRadius: '50%',
              background: p.color,
              boxShadow: `0 0 6px 1px ${p.color}99`,
            }}
          />
        </motion.div>
      ))}
    </>
  );
}
