'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { motion } from 'framer-motion';

// ─── Constants ────────────────────────────────────────────────────

const WORD    = 'ORCHESTRA';
const LETTERS = WORD.split('');
const W1      = [0, 1, 2, 3];    // O R C H — baguette gauche
const W2      = [4, 5, 6, 7, 8]; // E S T R A — baguette droite

const SPARK_CL = ['#C084FC', '#FFD700', '#E8E4DE', '#C084FC', '#FFD700', '#C084FC'];

const CENTER_T = (_, gen) => `translate(-50%,-50%) ${gen}`;

// ─── Position helpers ─────────────────────────────────────────────

function mkScatter(vw, vh) {
  return LETTERS.map(() => ({
    x:       (Math.random() - 0.5) * vw * 0.74,
    y:       (Math.random() - 0.5) * vh * 0.64,
    rotate:  (Math.random() - 0.5) * 360,
    opacity: 1,
    scale:   1,
  }));
}

function mkWand(vw, vh) {
  const A1 = -15 * Math.PI / 180;
  const A2 = +15 * Math.PI / 180;
  const sp = Math.min(vw * 0.088, 110);

  const W1CX = -vw * 0.04, W1CY = -vh * 0.09;
  const W2CX =  vw * 0.04, W2CY =  vh * 0.09;

  return LETTERS.map((_, i) => {
    if (W1.includes(i)) {
      const t = W1.indexOf(i) - 1.5;
      return {
        x: W1CX + t * sp * Math.cos(A1),
        y: W1CY + t * sp * Math.sin(A1),
        rotate: -15, opacity: 1, scale: 1,
      };
    }
    const t = W2.indexOf(i) - 2;
    return {
      x: W2CX + t * sp * Math.cos(A2),
      y: W2CY + t * sp * Math.sin(A2),
      rotate: 15, opacity: 1, scale: 1,
    };
  });
}

function mkOrch(vw) {
  const sp = Math.min(vw * 0.078, 88);
  return LETTERS.map((_, i) => ({
    x: (i - 4) * sp, y: 0, rotate: 0, opacity: 1, scale: 1,
  }));
}

// ─── LoadingIntro ─────────────────────────────────────────────────

export default function LoadingIntro({ onComplete }) {
  const [ready,  setReady]  = useState(false);
  const [phase,  setPhase]  = useState(0);
  const [pos,    setPos]    = useState(() =>
    LETTERS.map(() => ({ x: 0, y: 0, rotate: 0, opacity: 0, scale: 0 }))
  );
  const [sparks, setSparks]  = useState([]);
  const [cAnim,  setCont]    = useState({ scale: 1, opacity: 1, filter: 'blur(0px)' });
  const [fs,     setFs]      = useState('6vw');
  const [shake,  setShake]   = useState({ x: 0, y: 0 });

  const sid            = useRef(0);
  const videoRef       = useRef(null);
  const exitTriggered  = useRef(false);

  // ─── Exit transition (blur + zoom + fade, 0.8s) ───────────────
  const triggerExit = useCallback(() => {
    if (exitTriggered.current) return;
    exitTriggered.current = true;
    setCont({ scale: 1.1, opacity: 0, filter: 'blur(15px)' });
    setTimeout(() => {
      window.scrollTo(0, 0);
      onComplete?.();
    }, 800);
  }, [onComplete]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setReady(true);
  }, []);

  // ─── Spawn sparks ──────────────────────────────────────────────
  const spawn = useCallback((pts, n = 8) => {
    const next = pts.flatMap(({ x: ox, y: oy }) =>
      Array.from({ length: n }, (_, k) => {
        const a = (k / n) * 2 * Math.PI + (Math.random() - 0.5) * 0.9;
        return {
          id: sid.current++,
          ox, oy,
          dx:   Math.cos(a),
          dy:   Math.sin(a),
          cl:   SPARK_CL[k % SPARK_CL.length],
          dist: 55 + Math.random() * 65,
        };
      })
    );
    setSparks(p => [...p, ...next]);
    const ids = new Set(next.map(s => s.id));
    setTimeout(() => setSparks(p => p.filter(s => !ids.has(s.id))), 1000);
  }, []);

  // ─── Shake helper ──────────────────────────────────────────────
  const doShake = useCallback(() => {
    const seq = [
      { x: -2, y: 1 },
      { x: 3, y: -1 },
      { x: -3, y: 0 },
      { x: 2, y: 1 },
      { x: -1, y: -1 },
      { x: 0, y: 0 },
    ];
    seq.forEach((s, i) => {
      setTimeout(() => setShake(s), i * 35);
    });
  }, []);

  // ─── Phase sequence ────────────────────────────────────────────
  useEffect(() => {
    if (!ready) return;

    const vw = window.innerWidth;
    const vh = window.innerHeight;

    const sc = mkScatter(vw, vh);
    const p2 = mkWand(vw, vh);
    const p4 = mkOrch(vw);

    const A1 = -15 * Math.PI / 180, A2 = +15 * Math.PI / 180;
    const sp = Math.min(vw * 0.088, 110);
    const tipW1 = {
      x: vw / 2 + (-vw * 0.04) + 1.5 * sp * Math.cos(A1),
      y: vh / 2 + (-vh * 0.09) + 1.5 * sp * Math.sin(A1),
    };
    const tipW2 = {
      x: vw / 2 + (vw * 0.04) + 2.0 * sp * Math.cos(A2),
      y: vh / 2 + (vh * 0.09) + 2.0 * sp * Math.sin(A2),
    };

    // Phase 1 - Chaos (0s)
    setPhase(1);
    setFs('6vw');
    setPos(sc);

    // Phase 2 - Wand formation (2s)
    const t2 = setTimeout(() => {
      setPhase(2);
      setFs('3.5vw');
      setPos(p2);
    }, 2000);

    // Phase 3 - Conductor beats (3.5s)
    const t3 = setTimeout(() => {
      setPhase(3);

      const BEATS = [
        { d: 0,    r1: -8, dy1: -13, r2:  8, dy2:  13 },
        { d: 370,  r1:  7, dy1:  11, r2: -7, dy2: -11 },
        { d: 790,  r1: -6, dy1:  -9, r2:  6, dy2:   9 },
        { d: 1240, r1:  5, dy1:   7, r2: -5, dy2:  -7 },
      ];

      BEATS.forEach(({ d, r1, dy1, r2, dy2 }) => {
        setTimeout(() => {
          setPos(p2.map((base, i) => ({
            ...base,
            rotate: base.rotate + (W1.includes(i) ? r1 : r2),
            y:      base.y      + (W1.includes(i) ? dy1 : dy2),
          })));
          spawn([tipW1, tipW2], 7);
          doShake();
          setTimeout(() => setPos(p2), 180);
        }, d);
      });
    }, 3500);

    // Phase 4 - Revelation (5s)
    const t4 = setTimeout(() => {
      setPhase(4);
      setFs('5vw');
      setPos(p4);

      // Sparks explosion
      setTimeout(() => {
        spawn(
          [
            { x: vw / 2 - 100, y: vh / 2 },
            { x: vw / 2 - 35,  y: vh / 2 },
            { x: vw / 2 + 35,  y: vh / 2 },
            { x: vw / 2 + 100, y: vh / 2 },
          ],
          12
        );
        try { new Audio('/sounds/wand-reveal.mp3').play(); } catch {}
      }, 460);

      // Trigger exit after reveal completes
      setTimeout(() => triggerExit(), 1060);
    }, 5000);

    return () => { clearTimeout(t2); clearTimeout(t3); clearTimeout(t4); };
  }, [ready, onComplete, spawn, doShake, triggerExit]);

  // ── Transitions ──────────────────────────────────────────────────
  const SPRING = { type: 'spring', stiffness: 80, damping: 18 };
  const FAST   = { type: 'spring', stiffness: 260, damping: 20 };

  const getTrans = (i) => {
    if (phase === 1) return { duration: 0.65, delay: i * 0.1, ease: [0.16, 1, 0.3, 1] };
    if (phase === 3) return FAST;
    return { ...SPRING, delay: i * 0.03 };
  };

  if (!ready) {
    return <div style={{ position: 'fixed', inset: 0, background: '#0A0A0E', zIndex: 9999 }} />;
  }

  return (
    <motion.div
      aria-hidden="true"
      style={{
        position: 'fixed',
        inset: 0,
        background: '#0A0A0E',
        zIndex: 9999,
        overflow: 'hidden',
      }}
      animate={cAnim}
      transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
    >
      {/* Video background */}
      <video
        ref={videoRef}
        src="/videos/hero-intro.mov"
        autoPlay
        muted
        playsInline
        onEnded={triggerExit}
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          opacity: 0.6,
          zIndex: 1,
          pointerEvents: 'none',
        }}
      />

      {/* Shake wrapper + letters + sparks */}
      <motion.div
        animate={shake}
        transition={{ duration: 0.04 }}
        style={{ width: '100%', height: '100%', position: 'relative', zIndex: 10 }}
      >
        {/* Letters — anchored to screen center */}
        <div style={{ position: 'absolute', left: '50%', top: '50%' }}>
          {LETTERS.map((char, i) => (
            <motion.span
              key={i}
              transformTemplate={CENTER_T}
              style={{
                position:   'absolute',
                fontFamily: 'var(--font-playfair)',
                fontSize:   fs,
                fontWeight: 400,
                color:      '#E8E4DE',
                lineHeight: 1,
                userSelect: 'none',
                whiteSpace: 'nowrap',
                willChange: 'transform',
                transition: 'font-size 0.55s cubic-bezier(0.16,1,0.3,1)',
              }}
              animate={pos[i]}
              transition={getTrans(i)}
            >
              {char}
            </motion.span>
          ))}
        </div>

        {/* Sparks (CSS circles) */}
        {sparks.map(s => (
          <motion.div
            key={s.id}
            style={{
              position:      'fixed',
              left:          s.ox,
              top:           s.oy,
              pointerEvents: 'none',
              zIndex:        10001,
            }}
            initial={{ x: 0, y: 0, opacity: 1, scale: 1.5 }}
            animate={{ x: s.dx * s.dist, y: s.dy * s.dist, opacity: 0, scale: 0 }}
            transition={{ duration: 0.7, ease: 'easeOut' }}
          >
            <div
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: s.cl,
                boxShadow: `0 0 8px 2px ${s.cl}66`,
              }}
            />
          </motion.div>
        ))}
      </motion.div>
    </motion.div>
  );
}
