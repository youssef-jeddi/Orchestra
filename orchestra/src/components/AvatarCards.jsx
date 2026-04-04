'use client';

import { useRef, useState, useEffect, useCallback } from 'react';
import { motion, useInView, useAnimation, animate } from 'framer-motion';
import { BookOpen, ShieldAlert, TrendingUp } from 'lucide-react';
import MagicText from './MagicText';

// ─── CSS injected once ────────────────────────────────────────────
const INJECTED_CSS = `
  @keyframes ac-pulse-red {
    0%, 100% { opacity: 1; transform: scale(1); box-shadow: 0 0 0 0 rgba(239,68,68,0.4); }
    50%       { opacity: 0.7; transform: scale(1.35); box-shadow: 0 0 0 5px rgba(239,68,68,0); }
  }
  .ac-pulse-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: #EF4444;
    flex-shrink: 0;
    animation: ac-pulse-red 1.4s ease-in-out infinite;
  }
  /* Tablet — Scholar full-width en haut */
  @media (min-width: 481px) and (max-width: 900px) {
    .ac-grid { grid-template-columns: 1fr 1fr !important; }
    .ac-grid > *:nth-child(2) { grid-column: 1 / -1; order: -1; }
  }
  /* Mobile */
  @media (max-width: 480px) {
    .ac-grid { grid-template-columns: 1fr !important; }
  }
`;

// ─── Helpers ──────────────────────────────────────────────────────
function formatUSD(n) {
  return '$' + Math.round(n).toLocaleString('en-US');
}

// ─── Mini chat data ───────────────────────────────────────────────
const CHAT = [
  { role: 'user',  text: 'What\'s a liquidity pool?' },
  { role: 'agent', text: 'A shared vault — users deposit token pairs and earn fees from every swap.' },
  { role: 'user',  text: 'Got it — thanks!' },
];

// ─── Shared card hover styles ─────────────────────────────────────
function cardStyle(hovered, extra = {}) {
  return {
    height: '100%',
    background: '#111111',
    borderRadius: 20,
    padding: 'clamp(24px, 4vw, 32px) clamp(20px, 3.5vw, 28px)',
    border: `1px solid ${hovered ? '#333' : '#1A1A1A'}`,
    transform: hovered ? 'translateY(-4px)' : 'translateY(0)',
    transition: 'transform 0.35s cubic-bezier(0.16,1,0.3,1), border-color 0.35s ease',
    cursor: 'none',
    display: 'flex',
    flexDirection: 'column',
    gap: 18,
    position: 'relative',
    overflow: 'hidden',
    ...extra,
  };
}

// ═══════════════════════════════════════════════════════════════════
// GUARDIAN — shake on hover + every 8s auto
// ═══════════════════════════════════════════════════════════════════
function GuardianCard({ inView, delay }) {
  const [hovered, setHovered] = useState(false);
  const controls  = useAnimation();
  const isShaking = useRef(false);

  const shake = useCallback(async () => {
    if (isShaking.current) return;
    isShaking.current = true;
    await controls.start({
      x: [0, -3, 3, -3, 3, -3, 3, -2, 2, 0],
      transition: { duration: 0.42, ease: 'linear' },
    });
    controls.set({ x: 0 });
    isShaking.current = false;
  }, [controls]);

  useEffect(() => {
    if (!inView) return;
    const id = setInterval(shake, 8000);
    return () => clearInterval(id);
  }, [inView, shake]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 64 }}
      animate={inView ? { opacity: 1, y: 0 } : {}}
      transition={{ delay, duration: 0.62, ease: 'easeOut' }}
      style={{ height: '100%' }}
    >
      <motion.div
        animate={controls}
        onMouseEnter={() => { setHovered(true); shake(); }}
        onMouseLeave={() => setHovered(false)}
        role="article"
        aria-label="The Guardian — real-time security alerts"
        style={cardStyle(hovered)}
      >
        <ShieldAlert size={20} color="#444" />

        <div>
          <p style={{
            margin: 0,
            fontFamily: 'var(--font-playfair)',
            fontSize: 'clamp(18px, 2.2vw, 22px)',
            fontWeight: 400,
            color: '#E8E4DE',
            lineHeight: 1.1,
          }}>
            The Guardian
          </p>
          <p style={{
            margin: '8px 0 0',
            fontFamily: 'var(--font-inter)',
            fontSize: 11,
            color: '#666',
            letterSpacing: '0.15em',
            textTransform: 'uppercase',
          }}>
            Real-time security alerts
          </p>
        </div>

        {/* alert badge */}
        <div style={{
          marginTop: 'auto',
          background: 'rgba(239,68,68,0.06)',
          border: '1px solid rgba(239,68,68,0.18)',
          borderRadius: 10,
          padding: '11px 13px',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
        }}>
          <div className="ac-pulse-dot" />
          <span style={{
            fontSize: 11.5,
            fontFamily: 'var(--font-inter)',
            fontWeight: 400,
            color: '#EF4444',
            letterSpacing: '0.02em',
          }}>
            Suspicious approval detected
          </span>
        </div>
      </motion.div>
    </motion.div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// SCHOLAR — border-top accent, chat preview
// ═══════════════════════════════════════════════════════════════════
function ScholarCard({ inView, delay }) {
  const [hovered, setHovered] = useState(false);

  return (
    <motion.div
      initial={{ opacity: 0, y: 64 }}
      animate={inView ? { opacity: 1, y: 0 } : {}}
      transition={{ delay, duration: 0.62, ease: 'easeOut' }}
      style={{ height: '100%' }}
    >
      <div
        role="article"
        aria-label="The Scholar — DeFi tutor"
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={cardStyle(hovered, { borderTop: '2px solid #C084FC' })}
      >
        <BookOpen size={20} color="#444" />

        <div>
          <p style={{
            margin: 0,
            fontFamily: 'var(--font-playfair)',
            fontSize: 'clamp(20px, 2.4vw, 26px)',
            fontWeight: 400,
            color: '#E8E4DE',
            lineHeight: 1.1,
          }}>
            The Scholar
          </p>
          <p style={{
            margin: '8px 0 0',
            fontFamily: 'var(--font-inter)',
            fontSize: 11,
            color: '#666',
            letterSpacing: '0.15em',
            textTransform: 'uppercase',
          }}>
            Your personal DeFi tutor
          </p>
        </div>

        {/* chat preview */}
        <div style={{
          marginTop: 'auto',
          background: 'rgba(255,255,255,0.02)',
          border: '1px solid #1A1A1A',
          borderRadius: 12,
          padding: '14px 13px',
          display: 'flex',
          flexDirection: 'column',
          gap: 7,
        }}>
          {CHAT.map((msg, i) => (
            <div key={i} style={{
              display: 'flex',
              justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start',
            }}>
              <span style={{
                fontSize: 11,
                fontFamily: 'var(--font-inter)',
                lineHeight: 1.5,
                maxWidth: '87%',
                padding: '5px 10px',
                borderRadius: msg.role === 'user'
                  ? '10px 10px 3px 10px'
                  : '10px 10px 10px 3px',
                background: msg.role === 'user'
                  ? 'rgba(192,132,252,0.08)'
                  : 'rgba(255,255,255,0.04)',
                border: '1px solid ' + (msg.role === 'user'
                  ? 'rgba(192,132,252,0.18)'
                  : '#1A1A1A'),
                color: msg.role === 'user' ? '#C084FC' : '#666',
              }}>
                {msg.text}
              </span>
            </div>
          ))}
        </div>
      </div>
    </motion.div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// TREASURER — counter-up on hover
// ═══════════════════════════════════════════════════════════════════
function TreasurerCard({ inView, delay }) {
  const [hovered, setHovered] = useState(false);
  const [display, setDisplay] = useState(1247832);
  const animCtrlRef           = useRef(null);

  const handleHoverStart = useCallback(() => {
    setHovered(true);
    if (animCtrlRef.current) animCtrlRef.current.stop();
    setDisplay(0);
    animCtrlRef.current = animate(0, 1247832, {
      duration: 1.5,
      ease: 'easeOut',
      onUpdate: (v) => setDisplay(Math.round(v)),
    });
  }, []);

  const handleHoverEnd = useCallback(() => {
    setHovered(false);
    if (animCtrlRef.current) {
      animCtrlRef.current.stop();
      animCtrlRef.current = null;
    }
    setDisplay(1247832);
  }, []);

  return (
    <motion.div
      initial={{ opacity: 0, y: 64 }}
      animate={inView ? { opacity: 1, y: 0 } : {}}
      transition={{ delay, duration: 0.62, ease: 'easeOut' }}
      style={{ height: '100%' }}
    >
      <div
        role="article"
        aria-label="The Treasurer — portfolio tracker"
        onMouseEnter={handleHoverStart}
        onMouseLeave={handleHoverEnd}
        style={cardStyle(hovered)}
      >
        <TrendingUp size={20} color="#444" />

        <div>
          <p style={{
            margin: 0,
            fontFamily: 'var(--font-playfair)',
            fontSize: 'clamp(18px, 2.2vw, 22px)',
            fontWeight: 400,
            color: '#E8E4DE',
            lineHeight: 1.1,
          }}>
            The Treasurer
          </p>
          <p style={{
            margin: '8px 0 0',
            fontFamily: 'var(--font-inter)',
            fontSize: 11,
            color: '#666',
            letterSpacing: '0.15em',
            textTransform: 'uppercase',
          }}>
            Your portfolio, amplified
          </p>
        </div>

        <div style={{ marginTop: 'auto' }}>
          <p
            style={{
              margin: 0,
              fontFamily: 'var(--font-playfair)',
              fontWeight: 400,
              fontSize: 'clamp(28px, 3.5vw, 36px)',
              color: '#E8E4DE',
              lineHeight: 1,
              letterSpacing: '-0.02em',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {formatUSD(display)}
          </p>
          <p style={{
            margin: '8px 0 0',
            fontSize: 10.5,
            fontFamily: 'var(--font-inter)',
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
            color: '#444',
          }}>
            Total portfolio value
          </p>
        </div>
      </div>
    </motion.div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// AVATAR CARDS — section root
// ═══════════════════════════════════════════════════════════════════
export default function AvatarCards() {
  const ref    = useRef(null);
  const inView = useInView(ref, { once: true, margin: '-80px 0px' });

  return (
    <section
      ref={ref}
      style={{
        padding: 'clamp(72px, 12vh, 128px) clamp(20px, 6vw, 80px)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '3rem',
        position: 'relative',
        zIndex: 10,
        background: 'rgba(10,10,10,0.92)',
        backdropFilter: 'blur(2px)',
      }}
    >
      <style>{INJECTED_CSS}</style>

      <div style={{ textAlign: 'center' }}>
        <MagicText
          text="Meet the Maestro's Masks"
          tag="h2"
          style={{
            margin: 0,
            fontFamily: 'var(--font-playfair)',
            fontSize: 'clamp(1.8rem, 4.5vw, 3.6rem)',
            fontWeight: 400,
            color: '#E8E4DE',
            letterSpacing: '-0.02em',
            lineHeight: 1.1,
            display: 'block',
          }}
        />
        <MagicText
          text="Three agents. One conductor."
          tag="p"
          delay={0.3}
          style={{
            margin: '12px 0 0',
            fontFamily: 'var(--font-inter)',
            fontSize: 11,
            fontWeight: 300,
            color: '#666',
            letterSpacing: '0.2em',
            textTransform: 'uppercase',
            display: 'block',
          }}
        />
      </div>

      {/* asymmetric grid 1fr · 1.5fr · 1fr */}
      <div
        className="ac-grid"
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1.5fr 1fr',
          gap: '1.25rem',
          width: '100%',
          maxWidth: 1100,
          alignItems: 'stretch',
        }}
      >
        <GuardianCard  inView={inView} delay={0.05} />
        <ScholarCard   inView={inView} delay={0.17} />
        <TreasurerCard inView={inView} delay={0.29} />
      </div>
    </section>
  );
}
