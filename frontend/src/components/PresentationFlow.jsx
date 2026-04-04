'use client';

import { useEffect, useRef, useState } from 'react';
import {
  motion,
  useScroll,
  useTransform,
  useSpring,
  useMotionValueEvent,
  animate,
} from 'framer-motion';
import FontMorph from '@/components/FontMorph';
import { ChevronDown, Send } from 'lucide-react';

// ─── Slide images ────────────────────────────────────────────────

const IMAGES = [
  '/images/maestro-hero.png',
  '/images/notebook-bg.png',
  '/images/guardian.jpg',
  '/images/treasurer.jpg',
];

// ─── iMessage content (short, human, SMS-style) ─────────────────

const NOTEBOOK_MSGS = [
  { role: 'bot', text: 'Monitoring 2,400+ protocols across 12 chains.' },
  { role: 'user', text: 'What are you tracking?' },
  { role: 'bot', text: 'TVL shifts, governance votes, liquidity moves, audits. All chains.' },
  { role: 'user', text: 'How fast?' },
  { role: 'bot', text: 'Flagged the Curve exploit 47s before on-chain alerts.' },
  { role: 'user', text: 'Good. Keep watching.' },
];

const GUARDIAN_MSGS = [
  { role: 'bot', text: 'All positions nominal. One flag.' },
  { role: 'user', text: 'What flag?' },
  { role: 'bot', text: 'AAVE health factor at 1.42. Add collateral soon.', alert: true },
  { role: 'user', text: 'Auto-protect at 1.2.' },
  { role: 'bot', text: 'Done. 0.5 ETH queued if HF hits 1.2.' },
  { role: 'user', text: 'Rug detection?' },
];

const TREASURER_MSGS = [
  { role: 'bot', text: '7 active positions, 4 chains.' },
  { role: 'user', text: 'Total value?' },
  { role: 'bot', text: 'Calculating NAV...' },
  { role: 'user', text: 'Breakdown?' },
  { role: 'bot', text: 'ETH 42% | Stables 31% | LP 19% | Gov 8%. +12.4% 30d.' },
  { role: 'user', text: 'Optimize for yield.' },
];

// ─── Hover CSS ───────────────────────────────────────────────────

const HOVER_CSS = `
  .hv { transition: transform 0.25s cubic-bezier(0.16,1,0.3,1), box-shadow 0.25s cubic-bezier(0.16,1,0.3,1), color 0.25s, opacity 0.25s; }
  .hv:hover { transform: scale(1.04); }

  .hv-bubble { transition: transform 0.25s cubic-bezier(0.16,1,0.3,1), box-shadow 0.25s cubic-bezier(0.16,1,0.3,1); }
  .hv-left .hv-bubble:hover { transform: scale(1.04) translateX(8px); box-shadow: 0 8px 30px rgba(0,0,0,0.3); }
  .hv-right .hv-bubble:hover { transform: scale(1.04) translateX(-8px); box-shadow: 0 8px 30px rgba(0,0,0,0.3); }

  .hv-alert:hover { transform: scale(1.04) translateX(8px) !important; border-left: 5px solid rgba(220,38,38,0.5) !important; box-shadow: 0 0 20px rgba(220,38,38,0.15) !important; }

  .hv-counter { display: inline-block; transition: transform 0.25s cubic-bezier(0.16,1,0.3,1); }
  .hv-counter:hover { transform: scale(1.04); }
  .hv-counter:hover span { text-shadow: 0 0 20px rgba(48,209,88,0.3); }

  .hero-search {
    transition: border-color 0.25s cubic-bezier(0.16,1,0.3,1), box-shadow 0.25s cubic-bezier(0.16,1,0.3,1);
  }
  .hero-search:hover, .hero-search:focus-within {
    border-color: rgba(192,132,252,0.4) !important;
    box-shadow: 0 0 20px rgba(192,132,252,0.15) !important;
  }

  .book-link {
    position: relative; cursor: none; background: none; border: none; padding: 0;
    font-family: var(--font-inter); font-size: 13px; text-transform: uppercase;
    letter-spacing: 0.15em; color: #007AFF; margin-top: 20px; display: inline-block;
  }
  .book-link::after {
    content: ''; position: absolute; bottom: -2px; left: 0; width: 0; height: 1px;
    background: #007AFF; transition: width 0.3s cubic-bezier(0.16,1,0.3,1);
  }
  .book-link:hover::after { width: 100%; }

  .book-zone {
    transition: box-shadow 0.3s, outline 0.3s, border-color 0.3s;
    outline: 2px solid transparent;
  }
  .book-zone:hover {
    outline: 1px solid rgba(192,132,252,0.2);
    box-shadow: 0 0 50px rgba(192,132,252,0.2);
  }
  .book-zone .book-zone-label {
    opacity: 0; transition: opacity 0.3s;
  }
  .book-zone:hover .book-zone-label {
    opacity: 1;
  }
`;

// ─── Mouse parallax via CSS vars ─────────────────────────────────

function useMouseParallax() {
  useEffect(() => {
    let mx = 0, my = 0, cx = 0, cy = 0, raf;
    const lerp = (a, b, t) => a + (b - a) * t;
    const onMove = (e) => {
      const hw = window.innerWidth / 2, hh = window.innerHeight / 2;
      mx = ((e.clientX - hw) / hw) * 15;
      my = ((e.clientY - hh) / hh) * 10;
    };
    const tick = () => {
      cx = lerp(cx, mx, 0.08);
      cy = lerp(cy, my, 0.08);
      document.documentElement.style.setProperty('--px', `${cx}px`);
      document.documentElement.style.setProperty('--py', `${cy}px`);
      raf = requestAnimationFrame(tick);
    };
    window.addEventListener('mousemove', onMove);
    raf = requestAnimationFrame(tick);
    return () => { window.removeEventListener('mousemove', onMove); cancelAnimationFrame(raf); };
  }, []);
}

// ─── IMsgBubble ──────────────────────────────────────────────────

function IMsgBubble({ progress, threshold, role, text, variant, alert }) {
  const opacity = useTransform(progress, [threshold - 0.008, threshold + 0.015], [0, 1]);
  const yOff    = useTransform(progress, [threshold - 0.008, threshold + 0.015], [20, 0]);
  const isUser = role === 'user';

  const styles = {
    light: {
      user: { background: '#007AFF', color: '#fff', borderRadius: '18px 18px 4px 18px' },
      bot:  { background: '#FFFFFF', color: '#1c1c1e', borderRadius: '4px 18px 18px 18px' },
    },
    dark: {
      user: { background: '#1C1C1E', color: '#E8E4DE', borderRadius: '18px 18px 4px 18px' },
      bot:  {
        background: alert ? '#2A1A1A' : '#1C1C1E',
        color: alert ? '#ef4444' : '#E8E4DE',
        borderRadius: '4px 18px 18px 18px',
        border: alert ? '1px solid rgba(220,38,38,0.5)' : '1px solid rgba(255,255,255,0.15)',
        borderLeft: alert ? '3px solid rgba(220,38,38,0.6)' : undefined,
      },
    },
    treasury: {
      user: { background: '#1E1630', color: '#C084FC', borderRadius: '18px 18px 4px 18px', border: '1px solid rgba(192,132,252,0.35)' },
      bot:  { background: '#1C1C1E', color: '#E8E4DE', borderRadius: '4px 18px 18px 18px', border: '1px solid rgba(255,255,255,0.15)' },
    },
  };

  const bStyle = styles[variant]?.[role] || styles.light[role];

  return (
    <motion.div
      className={isUser ? 'hv-right' : 'hv-left'}
      style={{ opacity, y: yOff, display: 'flex', justifyContent: isUser ? 'flex-end' : 'flex-start', willChange: 'transform, opacity' }}
    >
      <div className={`hv-bubble${alert ? ' hv-alert' : ''}`} style={{ maxWidth: '82%', padding: '10px 16px', fontSize: 13.5, lineHeight: 1.65, fontFamily: 'var(--font-inter)', fontWeight: 300, ...bStyle }}>
        {text}
      </div>
    </motion.div>
  );
}

// ─── TotalCounter — replays on re-entry ──────────────────────────

function TotalCounter({ progress }) {
  const ref = useRef(null);
  const wasIn = useRef(false);
  const ctrl = useRef(null);
  const timer = useRef(null);

  useMotionValueEvent(progress, 'change', (v) => {
    if (v > 0.85 && !wasIn.current) {
      wasIn.current = true;
      timer.current = setTimeout(() => {
        if (ref.current) ref.current.textContent = '$0';
        ctrl.current = animate(0, 1247832, {
          duration: 2.2,
          ease: [0.16, 1, 0.3, 1],
          onUpdate: (val) => {
            if (ref.current) ref.current.textContent = `$${Math.floor(val).toLocaleString('en-US')}`;
          },
        });
      }, 500);
    }
    if (v < 0.80 && wasIn.current) {
      wasIn.current = false;
      clearTimeout(timer.current);
      ctrl.current?.stop();
      if (ref.current) ref.current.textContent = '$0';
    }
  });

  return (
    <div className="hv-counter">
      <span ref={ref} style={{ fontFamily: 'var(--font-playfair)', fontSize: 'clamp(32px, 5vw, 56px)', fontWeight: 400, color: '#E8E4DE', transition: 'text-shadow 0.3s' }}>
        $0
      </span>
    </div>
  );
}

// ─── RedPulse ────────────────────────────────────────────────────

function RedPulse() {
  return (
    <motion.div
      style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
      animate={{ boxShadow: ['inset 0 0 80px 20px rgba(220,38,38,0)', 'inset 0 0 80px 20px rgba(220,38,38,0.06)', 'inset 0 0 80px 20px rgba(220,38,38,0)'] }}
      transition={{ duration: 5, repeat: Infinity, ease: 'easeInOut' }}
    />
  );
}

// ─── Background image (crop watermark via scale + position) ──────

function SlideBg({ src }) {
  return (
    <div style={{ position: 'absolute', inset: '-20px', overflow: 'hidden' }}>
      <div style={{
        width: '100%', height: '100%',
        backgroundImage: `url(${src})`,
        backgroundSize: 'cover',
        backgroundPosition: '50% 40%',
        transform: 'scale(1.05) translate(var(--px, 0), var(--py, 0))',
        transition: 'transform 0.1s linear',
      }} />
    </div>
  );
}

// ─── Slide: Hero ─────────────────────────────────────────────────

function SlideHero({ sp }) {
  const opacity = useTransform(sp, [0, 0.005, 0.18, 0.24], [0, 1, 1, 0]);
  const chevronOpacity = useTransform(sp, [0, 0.04, 0.06], [1, 1, 0]);

  return (
    <motion.div style={{ position: 'fixed', inset: 0, opacity, pointerEvents: 'none', willChange: 'opacity' }}>
      <SlideBg src={IMAGES[0]} />
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(15,15,18,0.55)' }} />
      <div style={{ position: 'relative', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', zIndex: 2 }}>
        <FontMorph
          text="ORCHESTRA"
          style={{ fontSize: 'clamp(36px, 7vw, 96px)', fontWeight: 400, letterSpacing: '0.12em', lineHeight: 1 }}
        />
        <p className="shiny-text hv" style={{ marginTop: 20, fontSize: 'clamp(13px, 1.4vw, 18px)', fontFamily: 'var(--font-inter)', fontWeight: 300, letterSpacing: '0.25em', textTransform: 'uppercase', color: '#E8E4DE' }}>
          AI-Conducted DeFi Symphony
        </p>

        {/* Scroll down indicator — fades at 5% scroll */}
        <motion.div
          style={{ position: 'absolute', bottom: '8vh', display: 'flex', flexDirection: 'column', alignItems: 'center', opacity: chevronOpacity }}
          animate={{ y: [0, 10, 0] }}
          transition={{ duration: 1.5, repeat: Infinity, ease: 'easeInOut' }}
        >
          <ChevronDown size={24} style={{ color: 'rgba(255,255,255,0.5)' }} />
          <p style={{ fontSize: 11, fontFamily: 'var(--font-inter)', letterSpacing: '0.15em', color: 'rgba(255,255,255,0.3)', textTransform: 'uppercase', textAlign: 'center', marginTop: 4 }}>
            scroll
          </p>
        </motion.div>
      </div>
    </motion.div>
  );
}

// ─── Slide: Notebook (formerly Scholar) ──────────────────────────

function SlideNotebook({ sp, onOpenNotebook }) {
  const [bookZoom, setBookZoom] = useState(false);
  const exitingRef = useRef(false);
  const opacity = useTransform(sp, [0.18, 0.24, 0.45, 0.51], [0, 1, 1, 0]);
  const pe = useTransform(opacity, v => v > 0.1 ? 'auto' : 'none');

  useEffect(() => {
    const handler = () => { setBookZoom(false); exitingRef.current = false; };
    window.addEventListener('close-scholar-notebook', handler);
    return () => window.removeEventListener('close-scholar-notebook', handler);
  }, []);

  const handleBookClick = () => {
    if (exitingRef.current) return;
    console.log('Opening notebook');
    exitingRef.current = true;
    setBookZoom(true);
    setTimeout(() => onOpenNotebook(), 800);
  };

  const msgBase = 0.27;

  return (
    <motion.div style={{ position: 'fixed', inset: 0, opacity, pointerEvents: pe, willChange: 'opacity' }}>
      <motion.div
        animate={bookZoom ? { scale: 2.5, opacity: 0.3 } : { scale: 1, opacity: 1 }}
        transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
        style={{ position: 'absolute', inset: '-20px', transformOrigin: '55% 70%', overflow: 'hidden' }}
      >
        <div style={{ width: '100%', height: '100%', backgroundImage: `url(${IMAGES[1]})`, backgroundSize: 'cover', backgroundPosition: '50% 40%', transform: 'scale(1.05) translate(var(--px, 0), var(--py, 0))', transition: 'transform 0.1s linear' }} />
      </motion.div>
      <motion.div animate={{ opacity: bookZoom ? 1 : 0 }} transition={{ duration: 0.8 }} style={{ position: 'absolute', inset: 0, backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)', pointerEvents: 'none', zIndex: 1 }} />
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(15,15,18,0.35)' }} />

      <div style={{ position: 'relative', height: '100%', zIndex: 2, display: 'flex', alignItems: 'center', padding: '0 6vw' }}>
        <div style={{ flex: '0 0 35%' }}>
          <h2 className="hv" style={{ fontFamily: 'var(--font-playfair)', fontSize: 'clamp(28px, 4vw, 52px)', fontWeight: 400, color: '#E8E4DE', margin: 0, lineHeight: 1.1 }}>
            The Notebook
          </h2>
          <p className="hv" style={{ fontFamily: 'var(--font-inter)', fontSize: 13, fontWeight: 300, color: '#E8E4DE', marginTop: 12, lineHeight: 1.7, maxWidth: 320 }}>
            Reads every protocol so you don&apos;t have to.
          </p>
          <button className="book-link" onClick={handleBookClick}>click on the book</button>
        </div>

        <div style={{ flex: 1, maxWidth: 420, marginLeft: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {NOTEBOOK_MSGS.map((msg, i) => (
            <IMsgBubble key={i} progress={sp} threshold={msgBase + i * (0.02 + Math.random() * 0.01)} role={msg.role} text={msg.text} variant="light" />
          ))}
        </div>

        {/* Clickable book zone */}
        <button className="book-zone" onClick={handleBookClick} aria-label="Open the Notebook" style={{
          position: 'absolute', top: '15%', left: '20%', width: '60%', height: '60%',
          background: 'transparent', border: '1px solid transparent', borderRadius: 16,
          cursor: 'none', zIndex: 25, display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <span className="book-zone-label" style={{ fontFamily: 'var(--font-inter)', fontSize: 14, color: '#C084FC', letterSpacing: '0.1em' }}>
            Open the Notebook
          </span>
        </button>
      </div>
    </motion.div>
  );
}

// ─── Slide: Guardian ─────────────────────────────────────────────

function SlideGuardian({ sp }) {
  const opacity = useTransform(sp, [0.45, 0.51, 0.73, 0.79], [0, 1, 1, 0]);
  const pe = useTransform(opacity, v => v > 0.1 ? 'auto' : 'none');
  const msgBase = 0.55;

  return (
    <motion.div style={{ position: 'fixed', inset: 0, opacity, pointerEvents: pe, willChange: 'opacity' }}>
      <SlideBg src={IMAGES[2]} />
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(15,15,18,0.65)' }} />
      <RedPulse />
      <div style={{ position: 'relative', height: '100%', zIndex: 2, display: 'flex', alignItems: 'center', padding: '0 6vw' }}>
        <div style={{ flex: 1, maxWidth: 420, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {GUARDIAN_MSGS.map((msg, i) => (
            <IMsgBubble key={i} progress={sp} threshold={msgBase + i * (0.02 + Math.random() * 0.008)} role={msg.role} text={msg.text} variant="dark" alert={msg.alert} />
          ))}
        </div>
        <div style={{ flex: '0 0 35%', textAlign: 'right', marginLeft: 'auto' }}>
          <h2 className="hv" style={{ fontFamily: 'var(--font-playfair)', fontSize: 'clamp(28px, 4vw, 52px)', fontWeight: 400, color: '#E8E4DE', margin: 0, lineHeight: 1.1 }}>
            The Guardian
          </h2>
          <p className="hv" style={{ fontFamily: 'var(--font-inter)', fontSize: 13, fontWeight: 300, color: '#E8E4DE', marginTop: 12, lineHeight: 1.7, maxWidth: 280, marginLeft: 'auto' }}>
            Watches your back, 24/7.
          </p>
        </div>
      </div>
    </motion.div>
  );
}

// ─── Slide: Treasurer ────────────────────────────────────────────

function SlideTreasurer({ sp }) {
  const opacity = useTransform(sp, [0.73, 0.79, 0.97, 1.0], [0, 1, 1, 1]);
  const pe = useTransform(opacity, v => v > 0.1 ? 'auto' : 'none');
  const msgBase = 0.83;

  return (
    <motion.div style={{ position: 'fixed', inset: 0, opacity, pointerEvents: pe, willChange: 'opacity' }}>
      <SlideBg src={IMAGES[3]} />
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(15,15,18,0.6)' }} />
      <div style={{ position: 'relative', height: '100%', zIndex: 2, display: 'flex', alignItems: 'center', padding: '0 6vw' }}>
        <div style={{ flex: '0 0 38%' }}>
          <h2 className="hv" style={{ fontFamily: 'var(--font-playfair)', fontSize: 'clamp(28px, 4vw, 52px)', fontWeight: 400, color: '#E8E4DE', margin: 0, lineHeight: 1.1 }}>
            The Treasurer
          </h2>
          <p className="hv" style={{ fontFamily: 'var(--font-inter)', fontSize: 13, fontWeight: 300, color: '#E8E4DE', marginTop: 12, lineHeight: 1.7, maxWidth: 280 }}>
            Knows where your money works hardest.
          </p>
          <div style={{ marginTop: 32 }}>
            <p className="hv" style={{ fontFamily: 'var(--font-inter)', fontSize: 9, letterSpacing: '0.2em', textTransform: 'uppercase', color: '#E8E4DE', marginBottom: 6, opacity: 0.5 }}>
              Total Portfolio Value
            </p>
            <TotalCounter progress={sp} />
          </div>
        </div>
        <div style={{ flex: 1, maxWidth: 420, marginLeft: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {TREASURER_MSGS.map((msg, i) => (
            <IMsgBubble key={i} progress={sp} threshold={msgBase + i * (0.018 + Math.random() * 0.008)} role={msg.role} text={msg.text} variant="treasury" />
          ))}
        </div>
      </div>
    </motion.div>
  );
}

// ─── Global Search Bar (hero → fixed bottom on scroll) ──────────

function GlobalSearchBar({ onOpenNotebook }) {
  const [searchValue, setSearchValue] = useState('');

  const handleSearch = () => {
    const text = searchValue.trim();
    if (!text) return;
    onOpenNotebook(text);
    setSearchValue('');
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSearch();
    }
  };

  return (
    <div
      style={{
        position: 'fixed',
        bottom: 32,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 50,
        width: 520,
        maxWidth: '90vw',
      }}
    >
      <div
        className="hero-search"
        style={{
          display: 'flex', alignItems: 'center', gap: 12,
          background: 'rgba(255,255,255,0.08)',
          backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)',
          border: '1px solid rgba(255,255,255,0.12)',
          borderRadius: 100, padding: '14px 24px',
        }}
      >
        <input
          type="text"
          value={searchValue}
          onChange={(e) => setSearchValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Where do you want to invest today?"
          style={{
            flex: 1, background: 'transparent', border: 'none',
            fontFamily: 'var(--font-inter)', fontSize: 15, fontWeight: 300,
            color: '#E8E4DE', outline: 'none', cursor: 'none',
          }}
        />
        <motion.button
          onClick={handleSearch}
          aria-label="Search"
          whileHover={searchValue.trim() ? { scale: 1.1 } : {}}
          whileTap={searchValue.trim() ? { scale: 0.9 } : {}}
          style={{ background: 'transparent', border: 'none', cursor: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, padding: 0 }}
        >
          <Send size={18} color={searchValue.trim() ? '#C084FC' : '#555'} />
        </motion.button>
      </div>
    </div>
  );
}

// ─── PresentationFlow ────────────────────────────────────────────

export default function PresentationFlow({ onOpenNotebook }) {
  useMouseParallax();
  const containerRef = useRef(null);
  const { scrollYProgress } = useScroll({ target: containerRef });
  const sp = useSpring(scrollYProgress, { stiffness: 100, damping: 30, restDelta: 0.0005 });

  return (
    <div ref={containerRef} style={{ height: '500vh', position: 'relative' }}>
      <style>{HOVER_CSS}</style>
      <SlideHero sp={sp} />
      <SlideNotebook sp={sp} onOpenNotebook={onOpenNotebook} />
      <SlideGuardian sp={sp} />
      <SlideTreasurer sp={sp} />
      <GlobalSearchBar onOpenNotebook={onOpenNotebook} />
    </div>
  );
}
