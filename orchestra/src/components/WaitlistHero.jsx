'use client';

import { useCallback, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowRight, Check } from 'lucide-react';
import AvatarStack from './AvatarStack';

const SPARK_CL = ['#C084FC', '#FFD700', '#E8E4DE'];
const EASE     = [0.16, 1, 0.3, 1];

export default function WaitlistHero() {
  const [email,  setEmail]  = useState('');
  const [joined, setJoined] = useState(false);
  const [error,  setError]  = useState('');
  const [sparks, setSparks] = useState([]);
  const sparkId = useRef(0);

  // Burst de sparks à la palette Orchestra — même esprit que LoadingIntro.
  const burst = useCallback(() => {
    const next = Array.from({ length: 18 }, (_, k) => {
      const angle = (k / 18) * Math.PI * 2 + Math.random() * 0.3;
      const dist  = 50 + Math.random() * 70;
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
    <section className="relative flex min-h-[100svh] flex-col items-center justify-center px-6 pt-28 pb-20 sm:px-8">
      {/* Halo violet très diffus derrière le hero */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-1/4 mx-auto h-[420px] max-w-3xl"
        style={{
          background: 'radial-gradient(ellipse at center, rgba(192,132,252,0.08), transparent 70%)',
          filter: 'blur(40px)',
        }}
      />

      <div className="relative flex w-full max-w-3xl flex-col items-center text-center">
        {/* Badge */}
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, ease: EASE }}
          className="inline-flex items-center gap-2 rounded-full px-4 py-1.5"
          style={{
            background: 'rgba(255,255,255,0.08)',
            backdropFilter: 'blur(20px)',
            border: '1px solid rgba(255,255,255,0.12)',
          }}
        >
          <span
            className="h-1.5 w-1.5 rounded-full"
            style={{ background: 'var(--accent)', boxShadow: '0 0 8px 1px rgba(192,132,252,0.6)' }}
          />
          <span
            className="text-[10px] uppercase sm:text-[11px]"
            style={{ color: 'var(--text-1)', letterSpacing: '0.2em', lineHeight: 1.6 }}
          >
            Launching soon
          </span>
        </motion.div>

        {/* Titre */}
        <motion.h1
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 0.1, ease: EASE }}
          className="shiny-text mt-8 text-[2.5rem] leading-[1.1] sm:text-6xl md:text-7xl"
          style={{ fontFamily: 'var(--font-playfair, serif)', fontWeight: 400 }}
        >
          Your AI-Powered
          <br />
          DeFi Conductor
        </motion.h1>

        {/* Sous-titre */}
        <motion.p
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 0.2, ease: EASE }}
          className="mt-7 max-w-xl text-[15px] italic sm:text-base"
          style={{ color: 'var(--text-2)', lineHeight: 1.8 }}
        >
          Three AI agents orchestrate your DeFi portfolio — so you can focus on the music.
        </motion.p>

        {/* Email CTA */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 0.3, ease: EASE }}
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
                transition={{ duration: 0.35, ease: EASE }}
                className="flex items-center justify-center gap-3 rounded-full px-6 py-4"
                style={{
                  background: 'rgba(255,255,255,0.08)',
                  backdropFilter: 'blur(20px)',
                  border: '1px solid rgba(192,132,252,0.3)',
                  boxShadow: '0 0 30px rgba(192,132,252,0.1)',
                }}
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
                transition={{ duration: 0.25, ease: EASE }}
                className="flex flex-col gap-2 rounded-2xl p-2 sm:flex-row sm:rounded-full"
                style={{
                  background: 'rgba(255,255,255,0.08)',
                  backdropFilter: 'blur(20px)',
                  border: '1px solid rgba(255,255,255,0.12)',
                }}
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
                  style={{ color: 'var(--text-1)', lineHeight: 1.6 }}
                />
                <button
                  type="submit"
                  className="flex items-center justify-center gap-2 rounded-full px-6 py-3 text-[11px] uppercase"
                  style={{
                    background: 'var(--text-1)',
                    color: 'var(--bg)',
                    letterSpacing: '0.14em',
                    lineHeight: 1.6,
                    transition:
                      'transform 0.3s cubic-bezier(0.16,1,0.3,1), box-shadow 0.3s cubic-bezier(0.16,1,0.3,1)',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.transform = 'translateY(-1px)';
                    e.currentTarget.style.boxShadow = '0 0 30px rgba(192,132,252,0.25)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.transform = 'translateY(0)';
                    e.currentTarget.style.boxShadow = 'none';
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
                transition={{ duration: 0.25, ease: EASE }}
                className="mt-3 text-center text-xs"
                style={{ color: '#FF453A' }}
                role="alert"
              >
                {error}
              </motion.p>
            )}
          </AnimatePresence>
        </motion.div>

        {/* Social proof */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 0.45, ease: EASE }}
          className="mt-10"
        >
          <AvatarStack count={500} />
        </motion.div>
      </div>
    </section>
  );
}
