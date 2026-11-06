'use client';

// ─── Waitlist (/waitlist) — the public waitlist page (ORC-50) ───
// A dark scene with one door of light on the horizon: crypto has kept most people out, and
// Orchestra is the way in. A short promise, and an email field.
// The scene is CSS (waitlist.module.css); the text rises in with framer-motion. Wording and the
// email check come from lib/waitlist.js. Signups are not saved yet: see joinWaitlist there.

import { useState, useRef, useCallback } from 'react';
import Link from 'next/link';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import { WAITLIST_TEXT, emailProblem, joinWaitlist } from '@/lib/waitlist';
import s from './waitlist.module.css';

const EASE = [0.2, 0.7, 0.2, 1];

export default function WaitlistPage() {
  const reduceMotion = useReducedMotion();
  const inputRef = useRef(null);
  const [email, setEmail] = useState('');
  const [problem, setProblem] = useState(null);
  const [sending, setSending] = useState(false);
  const [joined, setJoined] = useState(false);

  // Text rises out of the dark one line after another; with reduced motion it is simply there.
  const rise = useCallback((step) => (reduceMotion ? {} : {
    initial: { opacity: 0, y: 14, filter: 'blur(6px)' },
    animate: { opacity: 1, y: 0, filter: 'blur(0px)' },
    transition: { duration: 1.1, ease: EASE, delay: 0.15 * step },
  }), [reduceMotion]);

  const onChange = useCallback((e) => {
    setEmail(e.target.value);
    setProblem(null); // the old message no longer describes what is typed
  }, []);

  const onSubmit = useCallback(async (e) => {
    e.preventDefault();
    const found = emailProblem(email);
    if (found) {
      setProblem(found);
      inputRef.current?.focus();
      return;
    }
    setSending(true);
    try {
      await joinWaitlist(email);
      setJoined(true);
    } catch (err) {
      setProblem(err.message);
    } finally {
      setSending(false);
    }
  }, [email]);

  const focusEmail = useCallback((e) => {
    if (joined) return;
    e.preventDefault();
    inputRef.current?.focus();
  }, [joined]);

  return (
    <main className={s.stage}>
      <div className={s.sky} aria-hidden="true" />
      <div className={s.stars} aria-hidden="true" />
      <div className={s.halo} aria-hidden="true" />
      <div className={`${s.halo} ${s.haloInner}`} aria-hidden="true" />
      <div className={s.floor} aria-hidden="true" />
      <div className={s.horizon} aria-hidden="true" />

      <motion.div
        className={s.doorWrap}
        aria-hidden="true"
        initial={reduceMotion ? false : { opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 2.4, ease: 'easeOut' }}
      >
        {/* Joining opens the door a little wider. */}
        <motion.div
          animate={{ scaleX: joined ? 1.3 : 1 }}
          transition={{ duration: reduceMotion ? 0 : 1.2, ease: EASE }}
          style={{ transformOrigin: 'bottom center' }}
        >
          <div className={s.door} />
        </motion.div>
        <div className={s.reflect} />
        <div className={s.spill} />
        <svg className={s.figure} viewBox="0 0 20 52">
          <circle cx="10" cy="5" r="4" fill="#0a0806" />
          <path d="M5 11 Q10 9 15 11 L16 30 L13 30 L12.6 51 L10.6 51 L10 33 L9.4 51 L7.4 51 L7 30 L4 30 Z" fill="#0a0806" />
        </svg>
      </motion.div>

      <div className={s.fog} aria-hidden="true" />
      <div className={`${s.fog} ${s.fogBack}`} aria-hidden="true" />

      <motion.nav className={s.nav} {...rise(0)}>
        <Link href="/waitlist" className={s.brand}>
          <span className={s.brandMark} aria-hidden="true" />Orchestra
        </Link>
        <div className={s.pill}>
          <Link href="/waitlist">Overview</Link>
          <Link href="/simple">Try the test version</Link>
        </div>
        <a href="#email" className={s.navCta} onClick={focusEmail}>Join waitlist</a>
      </motion.nav>

      <section className={s.copy}>
        <motion.p className={`${s.mono} ${s.eyebrow}`} {...rise(1)}>
          [ Crypto, <b>finally for everyone</b> ]
        </motion.p>
        <motion.h1 className={s.title} {...rise(2)}>
          Crypto kept you out.<br /><em>Here’s the door.</em>
        </motion.h1>
        <motion.p className={s.sub} {...rise(3)}>
          Orchestra makes crypto simple. Say what you want in plain words: everyday moves run on
          their own, and anything that matters waits for your approval.
        </motion.p>

        <AnimatePresence mode="wait" initial={false}>
          {joined ? (
            <motion.p
              key="joined"
              className={s.joined}
              role="status"
              initial={reduceMotion ? false : { opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, ease: EASE }}
            >
              <span className={s.mono}>{WAITLIST_TEXT.joinedTag}</span>
              {WAITLIST_TEXT.joined}
            </motion.p>
          ) : (
            <motion.div key="form" {...rise(4)} exit={{ opacity: 0, y: -6, transition: { duration: 0.25 } }}>
              <form className={`${s.form} ${problem ? s.formBad : ''}`} onSubmit={onSubmit} noValidate>
                <input
                  ref={inputRef}
                  id="email"
                  className={s.input}
                  type="email"
                  name="email"
                  autoComplete="email"
                  inputMode="email"
                  placeholder="you@email.com"
                  aria-label="Email address"
                  aria-invalid={problem ? 'true' : 'false'}
                  aria-describedby="email-problem"
                  value={email}
                  onChange={onChange}
                />
                <button type="submit" className={s.button} disabled={sending}>
                  {sending ? 'Joining…' : 'Join the waitlist'}
                </button>
              </form>
              <p id="email-problem" className={s.problem} aria-live="polite">{problem ?? ''}</p>
            </motion.div>
          )}
        </AnimatePresence>
      </section>

      <motion.aside className={`${s.note} ${s.noteLeft}`} {...rise(6)}>
        <span className={s.mono}>001 — You stay in control</span>
        <p>Small, routine moves within your limits run by themselves. Anything bigger waits for your passkey.</p>
      </motion.aside>
      <motion.aside className={`${s.note} ${s.noteRight}`} {...rise(6)}>
        <span className={s.mono}>002 — Early access</span>
        <p>Opening in small groups, first come first served.</p>
      </motion.aside>
    </main>
  );
}
