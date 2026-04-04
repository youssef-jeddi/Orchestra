'use client';

import { useRef, useState, useEffect } from 'react';
import {
  motion,
  AnimatePresence,
  useScroll,
  useTransform,
  useSpring,
  useMotionValueEvent,
  useAnimation,
  animate,
} from 'framer-motion';
import { Wand2, ChevronDown } from 'lucide-react';
import FontMorph from './FontMorph';

// ─── Scroll landmarks (500vh) ─────────────────────────────────────
// [0.00–0.18] Hero / Podium
// [0.18–0.28] Transition — dezoom + 180° rotation
// [0.28–0.50] Scholar
// [0.50–0.55] Micro-transition → Guardian
// [0.55–0.75] Guardian
// [0.75–0.80] Micro-transition → Treasurer
// [0.80–1.00] Treasurer

// ─── Data ─────────────────────────────────────────────────────────

const CHATS = [
  {
    user: "What's the best yield strategy for 10 ETH right now?",
    agent:
      'Based on current rates, splitting between Aave V3 (4.2% APY) and Lido staking (3.8%) gives you optimal risk-adjusted returns. Want me to execute?',
    time: '2 min ago',
  },
  {
    user: "Explain impermanent loss like I'm 5",
    agent:
      "Imagine you have a piggy bank with equal amounts of apples and oranges. When apple prices go up, people take your apples and leave oranges. You still have value, but less than if you'd just held your apples.",
    time: '4 min ago',
  },
  {
    user: 'Is it safe to bridge to Arbitrum right now?',
    agent:
      'Bridge liquidity is healthy at $2.4B. Gas on Arbitrum is 0.01 gwei. The official bridge has no pending incidents. Green light \u2713',
    time: '6 min ago',
  },
];

const ALERTS = [
  { icon: '\u26A0\uFE0F', text: 'Suspicious approval on contract 0x7a2f8B\u2026', color: '#EF4444' },
  { icon: '\uD83D\uDD34', text: 'Unlimited token approval detected \u2014 revoke immediately', color: '#EF4444' },
  { icon: '\u26A1', text: 'Unusual gas spike: 847 gwei \u2014 possible sandwich attack', color: '#F97316' },
  { icon: '\uD83D\uDEA8', text: 'This address flagged by Forta: potential phishing', color: '#EF4444' },
  { icon: '\uD83D\uDCE1', text: 'New approval request from unknown dApp', color: '#EAB308' },
  { icon: '\uD83D\uDD36', text: 'Flash loan detected in mempool \u2014 monitoring', color: '#F97316' },
  { icon: '\uD83E\uDD16', text: 'MEV bot activity detected on your LP position', color: '#EAB308' },
  { icon: '\u26D4', text: 'Contract interaction with known scam pattern', color: '#EF4444' },
];

const POSITIONS = [
  { label: 'ETH Staking \u2014 Lido', amount: '$847,291', change: '+12.4% this month', positive: true, amountFs: 'clamp(2rem, 5vw, 5.5vw)', cardW: 'clamp(280px, 46%, 560px)', top: '16%', left: '5%' },
  { label: 'USDC/ETH LP \u2014 Uniswap V3', amount: '$312,847', change: '+4.7% this month', positive: true, amountFs: 'clamp(1.6rem, 3.5vw, 4vw)', cardW: 'clamp(220px, 34%, 420px)', top: '40%', left: '34%' },
  { label: 'ARB Holding', amount: '$87,694', change: '-2.1% this month', positive: false, amountFs: 'clamp(1.3rem, 2.3vw, 2.8vw)', cardW: 'clamp(180px, 24%, 300px)', top: '63%', left: '63%' },
];

const MUSIC_NOTES = [
  { ch: '\u266A', x: '8%',  y: '15%', sz: 18 },
  { ch: '\u266B', x: '92%', y: '25%', sz: 14 },
  { ch: '\u2669', x: '23%', y: '72%', sz: 16 },
  { ch: '\u266A', x: '67%', y: '8%',  sz: 12 },
  { ch: '\u266C', x: '45%', y: '88%', sz: 20 },
  { ch: '\u266B', x: '78%', y: '45%', sz: 15 },
  { ch: '\u266A', x: '15%', y: '35%', sz: 11 },
  { ch: '\u2669', x: '55%', y: '62%', sz: 17 },
  { ch: '\u266A', x: '85%', y: '78%', sz: 13 },
  { ch: '\u266B', x: '35%', y: '92%', sz: 14 },
  { ch: '\u266A', x: '5%',  y: '55%', sz: 16 },
  { ch: '\u266C', x: '72%', y: '30%', sz: 12 },
];

// ═══════════════════════════════════════════════════════════════════
// HERO
// ═══════════════════════════════════════════════════════════════════

function HeroSection({ hintOpacity }) {
  const openChat = () => window.dispatchEvent(new CustomEvent('open-maestro-chat'));

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        position: 'relative',
        gap: '1.6rem',
        textAlign: 'center',
        padding: '0 2rem',
      }}
    >
      <motion.h1
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.8, delay: 0.3, ease: [0.16, 1, 0.3, 1] }}
        className="shiny-text"
        style={{
          fontSize: 'clamp(3.5rem, 9vw, 8rem)',
          fontWeight: 400,
          letterSpacing: '-0.03em',
          lineHeight: 1.05,
          margin: 0,
        }}
      >
        <FontMorph text="Orchestra" />
      </motion.h1>

      <motion.p
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.7, delay: 0.7, ease: 'easeOut' }}
        style={{
          fontFamily: 'var(--font-inter)',
          fontSize: 11,
          fontWeight: 300,
          color: '#666',
          letterSpacing: '0.2em',
          textTransform: 'uppercase',
          margin: 0,
        }}
      >
        Your AI-Powered DeFi{' '}
        <FontMorph text="Conductor" settle={false} />
      </motion.p>

      <motion.button
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.6, delay: 1.0 }}
        onClick={openChat}
        whileHover={{
          background: '#C084FC',
          color: '#000',
          boxShadow: '0 0 30px rgba(192,132,252,0.3)',
        }}
        whileTap={{ scale: 0.96 }}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '20px 48px',
          borderRadius: 4,
          background: 'transparent',
          color: '#E8E4DE',
          fontSize: 13,
          fontFamily: 'var(--font-inter)',
          fontWeight: 400,
          letterSpacing: '0.15em',
          textTransform: 'uppercase',
          border: '1px solid #333',
          cursor: 'none',
          pointerEvents: 'auto',
        }}
      >
        <Wand2 size={16} />
        Ask the Maestro
      </motion.button>

      {/* Scroll hint */}
      <motion.div
        style={{
          position: 'absolute',
          bottom: '2.5rem',
          left: '50%',
          x: '-50%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          opacity: hintOpacity,
          pointerEvents: 'none',
        }}
      >
        <motion.div
          animate={{ scaleY: [0, 1, 0] }}
          transition={{ duration: 1.5, repeat: Infinity, ease: 'easeInOut' }}
          style={{
            width: 1,
            height: 60,
            background: '#444',
            transformOrigin: 'top center',
            marginBottom: 12,
          }}
        />
        <motion.p
          animate={{ opacity: [0.35, 0.75, 0.35] }}
          transition={{ duration: 2.2, repeat: Infinity, ease: 'easeInOut' }}
          style={{
            fontFamily: 'var(--font-inter)',
            fontSize: 15,
            fontWeight: 300,
            color: '#444',
            letterSpacing: '0.22em',
            textTransform: 'uppercase',
            margin: 0,
          }}
        >
          scroll to explore
        </motion.p>
        <motion.div
          animate={{ y: [0, 12, 0] }}
          transition={{ duration: 1.4, repeat: Infinity, ease: 'easeInOut' }}
          style={{ marginTop: 6 }}
        >
          <ChevronDown size={16} color="#444" />
        </motion.div>
      </motion.div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// SCHOLAR
// ═══════════════════════════════════════════════════════════════════

function ScholarSection({ progress }) {
  const titleOp = useTransform(progress, [0, 0.12], [0, 1]);
  const titleY = useTransform(progress, [0, 0.12], [28, 0]);

  const c0Op = useTransform(progress, [0.06, 0.22], [0, 1]);
  const c0Y = useTransform(progress, [0.06, 0.22], [24, 0]);
  const c1Op = useTransform(progress, [0.28, 0.44], [0, 1]);
  const c1Y = useTransform(progress, [0.28, 0.44], [24, 0]);
  const c2Op = useTransform(progress, [0.52, 0.68], [0, 1]);
  const c2Y = useTransform(progress, [0.52, 0.68], [24, 0]);

  const chatAnims = [
    { opacity: c0Op, y: c0Y },
    { opacity: c1Op, y: c1Y },
    { opacity: c2Op, y: c2Y },
  ];

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        background: '#0F0F12',
        overflow: 'hidden',
      }}
    >
      <motion.div
        style={{
          width: 'clamp(260px, 36%, 480px)',
          padding: 'clamp(3rem, 8vh, 6rem) clamp(2.5rem, 5vw, 5rem)',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          gap: '1.4rem',
          flexShrink: 0,
          opacity: titleOp,
          y: titleY,
        }}
      >
        <h2
          style={{
            fontFamily: 'var(--font-playfair)',
            fontSize: 'clamp(2.4rem, 4vw, 5rem)',
            fontWeight: 400,
            color: '#E8E4DE',
            lineHeight: 1.05,
            margin: 0,
          }}
        >
          The Scholar
        </h2>
        <p
          style={{
            fontFamily: 'var(--font-inter)',
            fontSize: 11,
            fontWeight: 300,
            color: '#666',
            letterSpacing: '0.2em',
            textTransform: 'uppercase',
            margin: 0,
          }}
        >
          Your personal DeFi tutor
        </p>
        <p
          style={{
            fontFamily: 'var(--font-inter)',
            fontSize: 14,
            fontWeight: 300,
            color: '#444',
            lineHeight: 1.85,
            margin: 0,
          }}
        >
          Ask anything. The Scholar explains DeFi concepts in plain language and guides your every
          decision.
        </p>
      </motion.div>

      <div
        style={{
          flex: 1,
          padding: 'clamp(2.5rem, 7vh, 5rem) clamp(2rem, 4vw, 4rem) clamp(2.5rem, 7vh, 5rem) 0',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          gap: '2.2rem',
          overflowY: 'auto',
          scrollbarWidth: 'none',
        }}
      >
        {CHATS.map((chat, i) => (
          <motion.div key={i} style={{ opacity: chatAnims[i].opacity, y: chatAnims[i].y }}>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
              <div
                style={{
                  maxWidth: '78%',
                  padding: '12px 16px',
                  background: '#222228',
                  borderRadius: '16px 16px 4px 16px',
                  fontFamily: 'var(--font-inter)',
                  fontSize: 14,
                  lineHeight: 1.7,
                  color: '#E8E4DE',
                }}
              >
                {chat.user}
              </div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: 6 }}>
              <div
                style={{
                  maxWidth: '82%',
                  padding: '12px 16px',
                  background: '#141418',
                  borderLeft: '2px solid #C084FC',
                  borderRadius: '4px 16px 16px 4px',
                  fontFamily: 'var(--font-inter)',
                  fontSize: 14,
                  lineHeight: 1.7,
                  color: '#E8E4DE',
                }}
              >
                {chat.agent}
              </div>
            </div>
            <p
              style={{
                margin: 0,
                textAlign: 'right',
                fontFamily: 'var(--font-inter)',
                fontSize: 10,
                color: '#444',
                letterSpacing: '0.1em',
              }}
            >
              {chat.time}
            </p>
          </motion.div>
        ))}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// GUARDIAN
// ═══════════════════════════════════════════════════════════════════

function GuardianSection() {
  const [isAlert, setIsAlert] = useState(true);
  const shake = useAnimation();

  useEffect(() => {
    const id = setInterval(() => {
      setIsAlert((prev) => {
        const next = !prev;
        if (next) {
          shake.start({
            x: [0, -3, 3, -3, 3, -2, 2, -1, 1, 0],
            transition: { duration: 0.35, ease: 'linear' },
          });
        }
        return next;
      });
    }, 4000);
    return () => clearInterval(id);
  }, [shake]);

  return (
    <motion.div
      initial={{ x: 0 }}
      animate={shake}
      style={{
        width: '100%',
        height: '100%',
        position: 'relative',
        background: '#0F0F12',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        padding: 'clamp(3rem, 8vh, 5rem) clamp(2rem, 6vw, 6rem) 0',
      }}
    >
      {/* Corner gradient */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: 'radial-gradient(ellipse 60% 50% at 0% 0%, #1A0000 0%, transparent 70%)',
          pointerEvents: 'none',
        }}
      />

      {/* Pulsing red halo during alert */}
      {isAlert && (
        <motion.div
          animate={{ opacity: [0.15, 0.35, 0.15] }}
          transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
          style={{
            position: 'absolute',
            inset: 0,
            boxShadow: 'inset 0 0 100px rgba(239,68,68,0.12)',
            pointerEvents: 'none',
          }}
        />
      )}

      <h2
        style={{
          fontFamily: 'var(--font-playfair)',
          fontSize: 'clamp(2.4rem, 4vw, 5rem)',
          fontWeight: 400,
          color: '#E8E4DE',
          lineHeight: 1.05,
          margin: '0 0 2.5rem',
          position: 'relative',
        }}
      >
        The Guardian
      </h2>

      <AnimatePresence mode="wait">
        {isAlert ? (
          <motion.div
            key="alert"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, transition: { duration: 0.6 } }}
            style={{
              width: '100%',
              maxWidth: 680,
              display: 'flex',
              flexDirection: 'column',
              gap: 9,
              position: 'relative',
            }}
          >
            {ALERTS.map((a, i) => (
              <motion.div
                key={i}
                initial={{ opacity: 0, x: i % 2 === 0 ? -50 : 50 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: i * 0.07, duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
                style={{
                  background: '#141418',
                  borderLeft: `3px solid ${a.color}`,
                  borderRadius: '0 8px 8px 0',
                  padding: '11px 16px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  fontFamily: 'var(--font-inter)',
                  fontSize: 13,
                  color: '#E8E4DE',
                  lineHeight: 1.5,
                }}
              >
                <span style={{ fontSize: 15, flexShrink: 0 }}>{a.icon}</span>
                <span>{a.text}</span>
              </motion.div>
            ))}
          </motion.div>
        ) : (
          <motion.div
            key="zen"
            initial={{ opacity: 0, scale: 0.88 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: '1.8rem',
              position: 'relative',
            }}
          >
            <motion.div
              animate={{ scale: [1, 1.05, 1] }}
              transition={{ duration: 3.5, repeat: Infinity, ease: 'easeInOut' }}
              style={{
                width: 88,
                height: 88,
                borderRadius: '50%',
                border: '1px solid #10B981',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <span style={{ fontSize: 38, color: '#10B981', lineHeight: 1 }}>{'\u2713'}</span>
            </motion.div>
            <p
              style={{
                fontFamily: 'var(--font-inter)',
                fontSize: 18,
                fontWeight: 300,
                color: '#666',
                margin: 0,
              }}
            >
              All clear. No threats detected.
            </p>
            <p
              style={{
                fontFamily: 'var(--font-inter)',
                fontSize: 11,
                color: '#444',
                margin: 0,
                letterSpacing: '0.12em',
                textTransform: 'uppercase',
              }}
            >
              Last scan: 3 seconds ago
            </p>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// TREASURER
// ═══════════════════════════════════════════════════════════════════

function TreasurerSection({ progress }) {
  const [total, setTotal] = useState(0);
  const triggered = useRef(false);

  useMotionValueEvent(progress, 'change', (v) => {
    if (v > 0.12 && !triggered.current) {
      triggered.current = true;
      animate(0, 1247832, {
        duration: 1.8,
        ease: 'easeOut',
        onUpdate: (n) => setTotal(Math.round(n)),
      });
    }
  });

  const p0Op = useTransform(progress, [0.0, 0.2], [0, 1]);
  const p0Y = useTransform(progress, [0.0, 0.2], [40, 0]);
  const p1Op = useTransform(progress, [0.15, 0.35], [0, 1]);
  const p1Y = useTransform(progress, [0.15, 0.35], [40, 0]);
  const p2Op = useTransform(progress, [0.3, 0.5], [0, 1]);
  const p2Y = useTransform(progress, [0.3, 0.5], [40, 0]);
  const totOp = useTransform(progress, [0.4, 0.6], [0, 1]);

  const anims = [
    { opacity: p0Op, y: p0Y },
    { opacity: p1Op, y: p1Y },
    { opacity: p2Op, y: p2Y },
  ];

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        position: 'relative',
        background: '#0F0F12',
        overflow: 'hidden',
      }}
    >
      <h2
        style={{
          position: 'absolute',
          top: 'clamp(2rem, 5vh, 3.5rem)',
          left: '50%',
          transform: 'translateX(-50%)',
          fontFamily: 'var(--font-playfair)',
          fontSize: 'clamp(2.4rem, 4vw, 5rem)',
          fontWeight: 400,
          color: '#E8E4DE',
          margin: 0,
          whiteSpace: 'nowrap',
        }}
      >
        The Treasurer
      </h2>

      {POSITIONS.map((pos, i) => (
        <motion.div
          key={i}
          style={{
            position: 'absolute',
            top: pos.top,
            left: pos.left,
            width: pos.cardW,
            opacity: anims[i].opacity,
            y: anims[i].y,
          }}
        >
          <div
            style={{
              background: '#141418',
              border: '1px solid #222228',
              borderRadius: 20,
              padding: 'clamp(22px, 3vw, 38px)',
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
            }}
          >
            <p
              style={{
                margin: 0,
                fontFamily: 'var(--font-inter)',
                fontSize: 11,
                fontWeight: 300,
                color: '#666',
                letterSpacing: '0.15em',
                textTransform: 'uppercase',
              }}
            >
              {pos.label}
            </p>
            <p
              style={{
                margin: 0,
                fontFamily: 'var(--font-playfair)',
                fontSize: pos.amountFs,
                fontWeight: 400,
                color: '#E8E4DE',
                lineHeight: 1,
                letterSpacing: '-0.02em',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {pos.amount}
            </p>
            <p
              style={{
                margin: 0,
                fontFamily: 'var(--font-inter)',
                fontSize: 12,
                fontWeight: 300,
                color: pos.positive ? '#10B981' : '#EF4444',
              }}
            >
              {pos.change}
            </p>
          </div>
        </motion.div>
      ))}

      <motion.div
        style={{
          position: 'absolute',
          bottom: 'clamp(2rem, 5vh, 3.5rem)',
          left: '50%',
          x: '-50%',
          textAlign: 'center',
          opacity: totOp,
        }}
      >
        <p
          style={{
            margin: '0 0 6px',
            fontFamily: 'var(--font-inter)',
            fontSize: 10,
            fontWeight: 300,
            color: '#444',
            letterSpacing: '0.22em',
            textTransform: 'uppercase',
          }}
        >
          Total portfolio
        </p>
        <p
          style={{
            margin: 0,
            fontFamily: 'var(--font-playfair)',
            fontSize: 'clamp(1.8rem, 3vw, 3.5rem)',
            fontWeight: 400,
            color: '#E8E4DE',
            letterSpacing: '-0.02em',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          ${total.toLocaleString('en-US')}
        </p>
      </motion.div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// WHOOSH TRAILS
// ═══════════════════════════════════════════════════════════════════

const TRAIL_DATA = Array.from({ length: 12 }, (_, i) => ({
  y: 10 + (i / 12) * 80,
  w: 10 + Math.random() * 15,
  delay: i * 0.06,
  dur: 0.7 + Math.random() * 0.4,
  color: i % 3 === 0 ? '#C084FC' : '#333',
}));

function WhooshTrails({ opacity }) {
  return (
    <motion.div
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        zIndex: 5,
        opacity,
        overflow: 'hidden',
      }}
    >
      {TRAIL_DATA.map((t, i) => (
        <motion.div
          key={i}
          animate={{ x: ['-20vw', '120vw'] }}
          transition={{ duration: t.dur, repeat: Infinity, delay: t.delay, ease: 'linear' }}
          style={{
            position: 'absolute',
            top: `${t.y}%`,
            left: 0,
            width: `${t.w}vw`,
            height: 1,
            background: `linear-gradient(90deg, transparent, ${t.color} 50%, transparent)`,
            opacity: 0.5,
          }}
        />
      ))}
    </motion.div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// SCORE LINES (SVG staff connectors)
// ═══════════════════════════════════════════════════════════════════

function ScoreLines({ l1Draw, l1Op, l2Draw, l2Op }) {
  return (
    <svg
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      aria-hidden="true"
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
        zIndex: 15,
      }}
    >
      {[42, 46, 50, 54, 58].map((y, i) => (
        <motion.path
          key={`a-${i}`}
          d={`M -5 ${y} C 25 ${y - 8}, 75 ${y + 8}, 105 ${y}`}
          stroke="#222228"
          strokeWidth="0.3"
          fill="none"
          style={{ pathLength: l1Draw, opacity: l1Op }}
        />
      ))}
      {[42, 46, 50, 54, 58].map((y, i) => (
        <motion.path
          key={`b-${i}`}
          d={`M -5 ${y} C 25 ${y + 8}, 75 ${y - 8}, 105 ${y}`}
          stroke="#222228"
          strokeWidth="0.3"
          fill="none"
          style={{ pathLength: l2Draw, opacity: l2Op }}
        />
      ))}
    </svg>
  );
}

// ═══════════════════════════════════════════════════════════════════
// ROOT
// ═══════════════════════════════════════════════════════════════════

export default function SmoothScrollContainer() {
  const containerRef = useRef(null);

  const { scrollYProgress: raw } = useScroll({
    target: containerRef,
    offset: ['start start', 'end end'],
  });
  const scrollYProgress = useSpring(raw, {
    stiffness: 120,
    damping: 38,
    restDelta: 0.0001,
  });

  // ── Hero 3D transforms ───────────────────────────────────────
  const heroRotateY = useTransform(scrollYProgress, [0, 0.18, 0.28], [0, 0, 180]);
  const heroZ = useTransform(scrollYProgress, [0, 0.18, 0.23, 0.28], [0, 0, -800, -1200]);
  const heroOpacity = useTransform(scrollYProgress, [0.18, 0.23], [1, 0]);

  // ── Agents 3D transforms ─────────────────────────────────────
  const agentsZ = useTransform(scrollYProgress, [0.20, 0.50], [-800, 0]);
  const agentsOpacity = useTransform(scrollYProgress, [0.22, 0.30], [0, 1]);
  const agentsRotateY = useTransform(
    scrollYProgress,
    [0.28, 0.50, 0.55, 0.75, 0.80, 1.0],
    [0, 0, 15, 15, 0, 0],
  );
  const agentsX = useTransform(
    scrollYProgress,
    [0.28, 0.50, 0.55, 0.75, 0.80, 1.0],
    ['0vw', '10vw', '-10vw', '-10vw', '0vw', '0vw'],
  );

  // ── Section crossfades ───────────────────────────────────────
  const scholarOp = useTransform(scrollYProgress, [0.26, 0.32, 0.48, 0.53], [0, 1, 1, 0]);
  const guardianOp = useTransform(scrollYProgress, [0.52, 0.57, 0.73, 0.78], [0, 1, 1, 0]);
  const treasurerOp = useTransform(scrollYProgress, [0.77, 0.82, 1.0], [0, 1, 1]);

  // ── Effects ──────────────────────────────────────────────────
  const whooshOp = useTransform(scrollYProgress, [0.17, 0.19, 0.26, 0.29], [0, 1, 1, 0]);
  const hintOp = useTransform(scrollYProgress, [0, 0.04, 0.12], [1, 1, 0]);

  // ── Score lines ──────────────────────────────────────────────
  const l1Draw = useTransform(scrollYProgress, [0.50, 0.55], [0, 1]);
  const l1Op = useTransform(scrollYProgress, [0.49, 0.51, 0.54, 0.56], [0, 0.5, 0.5, 0]);
  const l2Draw = useTransform(scrollYProgress, [0.75, 0.80], [0, 1]);
  const l2Op = useTransform(scrollYProgress, [0.74, 0.76, 0.79, 0.81], [0, 0.5, 0.5, 0]);

  // ── Section-local progress ───────────────────────────────────
  const scholarProgress = useTransform(scrollYProgress, [0.28, 0.50], [0, 1]);
  const treasurerProgress = useTransform(scrollYProgress, [0.80, 1.0], [0, 1]);

  // ── Final CTA ────────────────────────────────────────────────
  const ctaOp = useTransform(scrollYProgress, [0.93, 0.97], [0, 1]);
  const ctaY = useTransform(scrollYProgress, [0.93, 0.97], [20, 0]);

  // ── Music notes parallax (3 speeds) ──────────────────────────
  const slowPY = useTransform(scrollYProgress, [0, 1], [0, -40]);
  const medPY = useTransform(scrollYProgress, [0, 1], [0, -80]);
  const fastPY = useTransform(scrollYProgress, [0, 1], [0, -120]);
  const pYs = [slowPY, medPY, fastPY];

  const openChat = () => window.dispatchEvent(new CustomEvent('open-maestro-chat'));

  return (
    <div ref={containerRef} style={{ height: '500vh', position: 'relative' }}>
      {/* ── Sticky viewport ── */}
      <div
        style={{
          position: 'sticky',
          top: 0,
          height: '100vh',
          overflow: 'hidden',
          zIndex: 10,
        }}
      >
        {/* Background music notes */}
        <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 0 }}>
          {MUSIC_NOTES.map((n, i) => (
            <motion.span
              key={i}
              style={{
                position: 'absolute',
                left: n.x,
                top: n.y,
                fontSize: n.sz,
                color: '#222228',
                y: pYs[i % 3],
                userSelect: 'none',
              }}
            >
              {n.ch}
            </motion.span>
          ))}
        </div>

        {/* ── Perspective wrapper ── */}
        <div
          style={{
            width: '100%',
            height: '100%',
            perspective: 1500,
            perspectiveOrigin: '50% 50%',
            position: 'relative',
            zIndex: 1,
          }}
        >
          {/* Hero stage — zooms out + rotates 180° */}
          <motion.div
            style={{
              position: 'absolute',
              inset: 0,
              transformStyle: 'preserve-3d',
              rotateY: heroRotateY,
              translateZ: heroZ,
              opacity: heroOpacity,
              backfaceVisibility: 'hidden',
            }}
          >
            <HeroSection hintOpacity={hintOp} />
          </motion.div>

          {/* Agents stage — zooms in from behind */}
          <motion.div
            style={{
              position: 'absolute',
              inset: 0,
              transformStyle: 'preserve-3d',
              rotateY: agentsRotateY,
              translateZ: agentsZ,
              translateX: agentsX,
              opacity: agentsOpacity,
            }}
          >
            {/* Scholar */}
            <motion.div style={{ position: 'absolute', inset: 0, opacity: scholarOp }}>
              <ScholarSection progress={scholarProgress} />
            </motion.div>
            {/* Guardian */}
            <motion.div style={{ position: 'absolute', inset: 0, opacity: guardianOp }}>
              <GuardianSection />
            </motion.div>
            {/* Treasurer */}
            <motion.div style={{ position: 'absolute', inset: 0, opacity: treasurerOp }}>
              <TreasurerSection progress={treasurerProgress} />
            </motion.div>
          </motion.div>
        </div>

        {/* ── Whoosh trails (rotation transition) ── */}
        <WhooshTrails opacity={whooshOp} />

        {/* ── Score lines (section transitions) ── */}
        <ScoreLines l1Draw={l1Draw} l1Op={l1Op} l2Draw={l2Draw} l2Op={l2Op} />

        {/* ── Final CTA ── */}
        <motion.div
          style={{
            position: 'absolute',
            bottom: 'clamp(3rem, 8vh, 5rem)',
            left: '50%',
            x: '-50%',
            opacity: ctaOp,
            y: ctaY,
            zIndex: 20,
            textAlign: 'center',
          }}
        >
          <motion.button
            onClick={openChat}
            whileHover={{
              background: '#C084FC',
              color: '#000',
              boxShadow: '0 0 30px rgba(192,132,252,0.3)',
            }}
            whileTap={{ scale: 0.96 }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '20px 48px',
              borderRadius: 4,
              background: 'transparent',
              color: '#E8E4DE',
              fontSize: 13,
              fontFamily: 'var(--font-inter)',
              fontWeight: 400,
              letterSpacing: '0.15em',
              textTransform: 'uppercase',
              border: '1px solid #333',
              cursor: 'none',
            }}
          >
            <Wand2 size={16} />
            Ask the Maestro
          </motion.button>
        </motion.div>

        {/* ── Progress bar ── */}
        <motion.div
          style={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            height: 2,
            width: '100%',
            background: '#C084FC',
            scaleX: scrollYProgress,
            transformOrigin: 'left center',
            zIndex: 20,
          }}
        />
      </div>
    </div>
  );
}
