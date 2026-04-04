'use client';

import { useRef, useState } from 'react';
import { motion, useInView } from 'framer-motion';
import { Database, ArrowLeftRight, Shield } from 'lucide-react';
import MagicText from './MagicText';

// ─── Data ─────────────────────────────────────────────────────────

const PROTOCOLS = [
  { id: 'zerog',   name: '0G',      tagline: 'The AI Layer',    Icon: Database       },
  { id: 'uniswap', name: 'Uniswap', tagline: 'The Swap Engine', Icon: ArrowLeftRight },
  { id: 'ledger',  name: 'Ledger',  tagline: 'The Vault',       Icon: Shield         },
];

// ─── Keyword highlight — underline reveal ─────────────────────────

function Highlight({ children, delay = '0.3s', textInView }) {
  return (
    <span
      style={{
        borderBottom: `1px solid ${textInView ? '#444' : 'transparent'}`,
        paddingBottom: 1,
        color: '#E8E4DE',
        transition: `border-color 0.5s ease ${delay}`,
      }}
    >
      {children}
    </span>
  );
}

// ─── ProtocolCard ─────────────────────────────────────────────────

function ProtocolCard({ protocol, index, inView }) {
  const [hovered, setHovered] = useState(false);
  const { Icon } = protocol;

  return (
    <motion.div
      initial={{ opacity: 0, y: 40 }}
      animate={inView ? { opacity: 1, y: 0 } : {}}
      transition={{ delay: index * 0.15, duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
      style={{ flex: '1 1 240px', minWidth: 0 }}
    >
      <div
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          height: '100%',
          background: '#111111',
          borderRadius: 16,
          padding: 'clamp(24px, 3.5vw, 36px) clamp(20px, 3vw, 32px)',
          border: `1px solid ${hovered ? '#333' : '#1A1A1A'}`,
          transform: hovered ? 'translateY(-4px)' : 'translateY(0)',
          transition: 'transform 0.35s cubic-bezier(0.16,1,0.3,1), border-color 0.35s ease',
          cursor: 'none',
          display: 'flex',
          flexDirection: 'column',
          gap: 24,
        }}
      >
        <Icon size={20} color="#444" />

        <p
          style={{
            margin: 0,
            fontSize: 'clamp(1.6rem, 3vw, 2rem)',
            fontFamily: 'var(--font-playfair)',
            fontWeight: 400,
            color: '#E8E4DE',
            lineHeight: 1.1,
          }}
        >
          {protocol.name}
        </p>

        <p
          style={{
            margin: 0,
            fontSize: 11,
            fontFamily: 'var(--font-inter)',
            fontWeight: 300,
            color: '#666',
            letterSpacing: '0.2em',
            textTransform: 'uppercase',
          }}
        >
          {protocol.tagline}
        </p>
      </div>
    </motion.div>
  );
}

// ─── ScrollOrchestra ──────────────────────────────────────────────

export default function ScrollOrchestra() {
  const cardsRef   = useRef(null);
  const textRef    = useRef(null);
  const inView     = useInView(cardsRef, { once: true, margin: '-60px 0px' });
  const textInView = useInView(textRef,  { once: true, margin: '-60px 0px' });

  return (
    <section
      style={{
        minHeight: '100vh',
        padding: 'clamp(80px, 12vh, 140px) clamp(20px, 6vw, 80px)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '3.5rem',
        position: 'relative',
        zIndex: 10,
        background: 'rgba(10,10,10,0.92)',
        backdropFilter: 'blur(2px)',
      }}
    >
      {/* ── Heading ── */}
      <div style={{ textAlign: 'center' }}>
        <MagicText
          text="The Magic Orchestra"
          tag="h2"
          style={{
            fontSize: 'clamp(2rem, 5vw, 4.5rem)',
            fontFamily: 'var(--font-playfair)',
            fontWeight: 400,
            color: '#E8E4DE',
            letterSpacing: '-0.02em',
            lineHeight: 1.1,
            display: 'block',
          }}
        />
        <MagicText
          text="Three protocols, one symphony"
          tag="p"
          delay={0.3}
          style={{
            margin: '14px 0 0',
            fontSize: 11,
            fontFamily: 'var(--font-inter)',
            fontWeight: 300,
            color: '#666',
            letterSpacing: '0.2em',
            textTransform: 'uppercase',
            display: 'block',
          }}
        />
      </div>

      {/* ── Protocol cards ── */}
      <div
        ref={cardsRef}
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '1.5rem',
          width: '100%',
          maxWidth: 920,
          alignItems: 'stretch',
        }}
      >
        {PROTOCOLS.map((protocol, i) => (
          <ProtocolCard key={protocol.id} protocol={protocol} index={i} inView={inView} />
        ))}
      </div>

      {/* ── Body text ── */}
      <motion.div
        ref={textRef}
        initial={{ opacity: 0, y: 24 }}
        animate={textInView ? { opacity: 1, y: 0 } : {}}
        transition={{ duration: 0.7, ease: 'easeOut' }}
        style={{ maxWidth: 600, textAlign: 'center' }}
      >
        <p
          style={{
            margin: 0,
            fontSize: '0.95rem',
            lineHeight: 1.9,
            color: '#666',
            fontFamily: 'var(--font-inter)',
            fontWeight: 300,
          }}
        >
          Orchestra conducts your DeFi portfolio like a true maestro — leveraging{' '}
          <Highlight delay="0.25s" textInView={textInView}>
            0G&apos;s AI infrastructure
          </Highlight>{' '}
          for intelligent decisions,{' '}
          <Highlight delay="0.45s" textInView={textInView}>
            Uniswap&apos;s deep liquidity
          </Highlight>{' '}
          for seamless swaps, and{' '}
          <Highlight delay="0.65s" textInView={textInView}>
            Ledger&apos;s hardware security
          </Highlight>{' '}
          to keep your assets safe. One agent. Infinite harmony.
        </p>
      </motion.div>
    </section>
  );
}
