'use client';

import { useCallback, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowRight, Check, ChevronDown } from 'lucide-react';
import AvatarStack from './AvatarStack';

const SPARK_CL = ['#C084FC', '#FFD700', '#E8E4DE'];
const EASE     = [0.16, 1, 0.3, 1];
const TITLE    = 'DeFi, conducted.';

// Index de chaque lettre dans le titre complet, pour un stagger continu
// même lorsque le reveal est groupé par mots.
const WORDS = (() => {
  let offset = 0;
  return TITLE.split(' ').map((word) => {
    const entry = { word, offset };
    offset += word.length + 1;
    return entry;
  });
})();

export default function WaitlistHero() {
  const [email,  setEmail]  = useState('');
  const [joined, setJoined] = useState(false);
  const [error,  setError]  = useState('');
  const [sparks, setSparks] = useState([]);
  const sparkId = useRef(0);

  // Burst de sparks à la palette Orchestra — même esprit que LoadingIntro.
  const burst = useCallback(() => {
    const next = Array.from({ length: 22 }, (_, k) => {
      const angle = (k / 22) * Math.PI * 2 + Math.random() * 0.3;
      const dist  = 55 + Math.random() * 75;
      return {
        id: sparkId.current++,
        x:  Math.cos(angle) * dist,
        y:  Math.sin(angle) * dist,
        cl: SPARK_CL[k % SPARK_CL.length],
      };
    });
    setSparks((p) => [...p, ...next]);
    const ids = new Set(next.map((s) => s.id));
    setTimeout(() => setSparks((p) => p.filter((s) => !ids.has(s.id))), 1000);
  }, []);

  const onSubmit = useCallback(
    (e) => {
      e.preventDefault();
      const value = email.trim();
      // Pas de backend : state local uniquement.
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)) {
        setError('Enter a valid email address.');
        return;
      }
      setError('');
      setJoined(true);
      burst();
    },
    [email, burst]
  );

  return (
    <section
      id="hero"
      className="grainient-bg relative flex min-h-[100svh] flex-col items-center justify-center overflow-hidden px-6 pt-32 pb-24 sm:px-8"
    >
      <div className="relative z-10 flex w-full max-w-4xl flex-col items-center text-center">
        {/* Badge */}
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, ease: EASE }}
          className="glass inline-flex items-center gap-2.5 rounded-full px-4 py-1.5"
        >
          <span
            className="h-1.5 w-1.5 rounded-full"
            style={{ background: 'var(--accent)', boxShadow: '0 0 8px 1px rgba(192,132,252,0.6)' }}
          />
          <span className="eyebrow" style={{ color: 'var(--text-1)' }}>
            Launching Soon
          </span>
        </motion.div>

        {/* Titre — reveal lettre par lettre, style Lusion */}
        <h1
          className="display-hero mt-9"
          style={{ color: 'var(--text-1)', textWrap: 'balance' }}
        >
          <span className="sr-only">{TITLE}</span>
          {/* Mots groupés : le reveal est lettre par lettre, mais les retours
              à la ligne ne tombent qu'entre les mots. */}
          <span aria-hidden="true">
            {WORDS.map(({ word, offset }, w) => (
              <span key={`${word}-${w}`}>
                {w > 0 ? ' ' : null}
                <span style={{ display: 'inline-block', whiteSpace: 'nowrap' }}>
                  {word.split('').map((ch, c) => (
                    <motion.span
                      key={`${ch}-${c}`}
                      initial={{ opacity: 0, y: 26, filter: 'blur(6px)' }}
                      animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                      transition={{
                        duration: 0.9,
                        delay: 0.12 + (offset + c) * 0.035,
                        ease: EASE,
                      }}
                      style={{ display: 'inline-block' }}
                    >
                      {ch}
                    </motion.span>
                  ))}
                </span>
              </span>
            ))}
          </span>
        </h1>

        {/* Sous-titre */}
        <motion.p
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 0.7, ease: EASE }}
          className="mt-7 max-w-xl"
          style={{ color: 'var(--text-2)', fontSize: 18, fontWeight: 300, lineHeight: 1.6 }}
        >
          Three AI agents. One symphony. Your portfolio on autopilot.
        </motion.p>

        {/* Email CTA */}
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 0.82, ease: EASE }}
          className="relative mt-12 w-full max-w-md"
        >
          {/* Sparks au-dessus du formulaire */}
          {sparks.map((s) => (
            <motion.span
              key={s.id}
              aria-hidden="true"
              className="pointer-events-none absolute left-1/2 top-1/2 h-1.5 w-1.5 rounded-full"
              initial={{ opacity: 1, x: 0, y: 0, scale: 1 }}
              animate={{ opacity: 0, x: s.x, y: s.y, scale: 0.3 }}
              transition={{ duration: 0.9, ease: 'easeOut' }}
              style={{ background: s.cl, boxShadow: `0 0 8px 1px ${s.cl}aa`, zIndex: 20 }}
            />
          ))}

          <AnimatePresence mode="wait" initial={false}>
            {joined ? (
              <motion.div
                key="done"
                initial={{ opacity: 0, scale: 0.97 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.97 }}
                transition={{ duration: 0.4, ease: EASE }}
                className="glass flex items-center justify-center gap-3 rounded-full px-6 py-4"
                style={{ borderColor: 'rgba(192,132,252,0.3)' }}
              >
                <Check size={16} strokeWidth={1.5} style={{ color: 'var(--accent)' }} />
                <span className="text-sm" style={{ color: 'var(--text-1)' }}>
                  You&apos;re on the list! 🎵
                </span>
              </motion.div>
            ) : (
              <motion.form
                key="form"
                onSubmit={onSubmit}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.3, ease: EASE }}
                className="glass flex flex-col gap-2 rounded-2xl p-2 sm:flex-row sm:rounded-full"
              >
                <label htmlFor="waitlist-email" className="sr-only">
                  Email address
                </label>
                <input
                  id="waitlist-email"
                  type="email"
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    if (error) setError('');
                  }}
                  placeholder="you@protocol.xyz"
                  autoComplete="email"
                  className="min-w-0 flex-1 bg-transparent px-5 py-3 text-sm outline-none"
                  style={{ color: 'var(--text-1)', fontWeight: 300 }}
                />
                <button
                  type="submit"
                  className="eyebrow cta-glow flex items-center justify-center gap-2 rounded-full px-6 py-3"
                  style={{
                    background: 'var(--text-1)',
                    color: 'var(--bg)',
                    transition: 'transform 0.4s var(--ease)',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.transform = 'translateY(-1px)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.transform = 'translateY(0)';
                  }}
                >
                  Join the Waitlist
                  <ArrowRight size={13} strokeWidth={1.8} />
                </button>
              </motion.form>
            )}
          </AnimatePresence>

          <AnimatePresence>
            {error && (
              <motion.p
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.3, ease: EASE }}
                className="mt-3 text-center text-xs"
                style={{ color: 'var(--red)' }}
                role="alert"
              >
                {error}
              </motion.p>
            )}
          </AnimatePresence>
        </motion.div>

        {/* Social proof */}
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 0.94, ease: EASE }}
          className="mt-11"
        >
          <AvatarStack target={500} />
        </motion.div>
      </div>

      {/* Scroll indicator */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 1, delay: 1.5, ease: EASE }}
        className="absolute bottom-9 left-1/2 z-10 -translate-x-1/2"
        aria-hidden="true"
      >
        <ChevronDown
          size={18}
          strokeWidth={1.2}
          className="chevron-drift"
          style={{ color: 'var(--text-3)' }}
        />
      </motion.div>
    </section>
  );
}
