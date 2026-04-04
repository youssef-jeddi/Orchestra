'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { motion } from 'framer-motion';
import { X, Send, Feather } from 'lucide-react';

const DEFAULT_MESSAGES = [
  {
    id: 1,
    role: 'scholar',
    text: "Welcome to the Notebook. I monitor 2,400+ DeFi protocols across 12 chains. What would you like to know?",
  },
  {
    id: 2,
    role: 'user',
    text: "What's the safest yield right now?",
  },
  {
    id: 3,
    role: 'scholar',
    text: "Lido stETH at 3.8% — minimal smart contract risk. For more, USDC/ETH on Uni V3 yields 4.7% with manageable IL at current vol.",
  },
];

const HISTORY_ENTRIES = [
  { id: 'h1', label: 'Yield strategies', preview: 'Lido stETH 3.8%, Uni V3...' },
  { id: 'h2', label: 'Risk analysis', preview: 'AAVE HF 1.42, collateral...' },
  { id: 'h3', label: 'Gas optimization', preview: '18 gwei window, bridge USDC...' },
  { id: 'h4', label: 'Whale movements', preview: '$LINK accumulation detected...' },
  { id: 'h5', label: 'LP performance', preview: '24h vol $2,840, fees $6.20' },
];

const FALLBACK = "Scanning the protocol database...";

function TypewriterText({ text, onComplete }) {
  const [displayed, setDisplayed] = useState('');
  const idxRef = useRef(0);

  useEffect(() => {
    idxRef.current = 0;
    setDisplayed('');
    const iv = setInterval(() => {
      idxRef.current++;
      if (idxRef.current <= text.length) {
        setDisplayed(text.slice(0, idxRef.current));
      } else {
        clearInterval(iv);
        onComplete?.();
      }
    }, 30);
    return () => clearInterval(iv);
  }, [text, onComplete]);

  return (
    <span>
      {displayed}
      {displayed.length < text.length && (
        <motion.span
          animate={{ opacity: [1, 0] }}
          transition={{ duration: 0.5, repeat: Infinity }}
          style={{ color: '#666' }}
        >
          |
        </motion.span>
      )}
    </span>
  );
}

export default function FuturisticNotebook({ onClose, initialMessage = '' }) {
  const [messages, setMessages] = useState(DEFAULT_MESSAGES);
  const [inputValue, setInputValue] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [activeHistory, setActiveHistory] = useState('h1');
  const messagesEndRef = useRef(null);
  const queryHandled = useRef(false);

  useEffect(() => {
    console.log('FuturisticNotebook mounted');
    return () => console.log('FuturisticNotebook unmounted');
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isTyping]);

  // Pre-fill from search bar query
  useEffect(() => {
    if (initialMessage && !queryHandled.current) {
      queryHandled.current = true;
      setMessages((prev) => [...prev, { id: Date.now(), role: 'user', text: initialMessage }]);
      setIsTyping(true);
      setTimeout(() => {
        setIsTyping(false);
        setMessages((prev) => [
          ...prev,
          { id: Date.now() + 1, role: 'scholar', text: FALLBACK, isNew: true },
        ]);
      }, 1500);
    }
  }, [initialMessage]);

  const handleSend = () => {
    const text = inputValue.trim();
    if (!text || isTyping) return;
    setMessages((prev) => [...prev, { id: Date.now(), role: 'user', text }]);
    setInputValue('');
    setIsTyping(true);
    setTimeout(() => {
      setIsTyping(false);
      setMessages((prev) => [
        ...prev,
        { id: Date.now() + 1, role: 'scholar', text: FALLBACK, isNew: true },
      ]);
    }, 1500);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const canSend = inputValue.trim() && !isTyping;

  return (
    <motion.div
      initial={{ scale: 0.95, opacity: 0, filter: 'blur(8px)' }}
      animate={{ scale: 1, opacity: 1, filter: 'blur(0px)' }}
      exit={{ scale: 0.95, opacity: 0, filter: 'blur(8px)' }}
      transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'none',
        background: '#1A1510',
      }}
    >
      <style>{`
        .nb-grimoire {
          display: flex;
          width: 100%;
          max-width: 1100px;
          height: 100vh;
          position: relative;
        }
        .nb-sidebar {
          width: 280px;
          flex-shrink: 0;
          border-right: 1px solid #1A1A1A;
          display: flex;
          flex-direction: column;
        }
        .nb-main {
          flex: 1;
          min-width: 0;
          display: flex;
          flex-direction: column;
        }
        @media (max-width: 768px) {
          .nb-sidebar { display: none; }
          .nb-grimoire { max-width: 700px; }
        }
        .nb-hist {
          transition: background 0.2s, transform 0.25s cubic-bezier(0.16,1,0.3,1);
        }
        .nb-hist:hover {
          background: rgba(255,255,255,0.03);
          transform: scale(1.02);
        }
      `}</style>

      {/* Background image texture */}
      <img
        src="/images/notebook-bg.png"
        alt=""
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          opacity: 0.45,
          filter: 'brightness(1.3)',
          pointerEvents: 'none',
        }}
      />

      {/* Grimoire layout */}
      <div className="nb-grimoire" style={{ zIndex: 2 }}>
        {/* Close */}
        <motion.button
          onClick={onClose}
          aria-label="Close notebook"
          whileHover={{ color: '#E8E4DE' }}
          style={{
            position: 'absolute', top: 24, right: 16, zIndex: 10,
            background: 'none', border: 'none', cursor: 'none', color: '#FFFFFF', padding: 8,
          }}
        >
          <X size={28} />
        </motion.button>

        {/* Left: History */}
        <div className="nb-sidebar">
          <div style={{ position: 'absolute', left: 32, top: 0, bottom: 0, width: 1, background: '#1A1A1A', pointerEvents: 'none' }} />
          <div style={{ padding: '48px 24px 16px 48px' }}>
            <p style={{ fontFamily: 'var(--font-playfair)', fontSize: 16, fontWeight: 400, color: '#FFFFFF', margin: 0, marginBottom: 4 }}>
              Research Log
            </p>
            <div style={{ width: 60, height: 1, background: '#222', marginBottom: 20 }} />
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: '0 24px 16px 48px', scrollbarWidth: 'none', display: 'flex', flexDirection: 'column', gap: 2 }}>
            {HISTORY_ENTRIES.map((entry) => (
              <button
                key={entry.id}
                className="nb-hist"
                onClick={() => setActiveHistory(entry.id)}
                style={{
                  display: 'block', width: '100%', textAlign: 'left',
                  background: activeHistory === entry.id ? 'rgba(192,132,252,0.06)' : 'transparent',
                  border: 'none',
                  borderLeft: activeHistory === entry.id ? '2px solid #C084FC' : '2px solid transparent',
                  borderRadius: 6, padding: '10px 12px', cursor: 'none',
                }}
              >
                <p style={{ margin: 0, fontFamily: 'var(--font-inter)', fontSize: 13, fontWeight: activeHistory === entry.id ? 400 : 300, color: '#FFFFFF', lineHeight: 1.3 }}>
                  {entry.label}
                </p>
                <p style={{ margin: '4px 0 0', fontFamily: 'var(--font-inter)', fontSize: 11, fontWeight: 300, color: '#FFFFFF', opacity: 0.5, lineHeight: 1.4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {entry.preview}
                </p>
              </button>
            ))}
          </div>
        </div>

        {/* Right: Conversation */}
        <div className="nb-main">
          <div style={{ position: 'absolute', right: 32, top: 0, bottom: 0, width: 1, background: '#1A1A1A', zIndex: 1, pointerEvents: 'none' }} />

          {/* Header */}
          <div style={{ padding: '48px 48px 20px', textAlign: 'center', flexShrink: 0 }}>
            <div style={{ width: '100%', height: 1, background: '#1A1A1A', marginBottom: 20 }} />
            <h1 style={{ fontFamily: 'var(--font-playfair)', fontSize: 22, fontWeight: 400, color: '#FFFFFF', margin: 0, lineHeight: 1.4 }}>
              The Scholar&apos;s Notebook
            </h1>
            <div style={{ width: 160, height: 1, background: '#444', margin: '12px auto 0' }} />
          </div>

          {/* Messages */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '8px 48px 16px', display: 'flex', flexDirection: 'column', gap: 20, scrollbarWidth: 'none', msOverflowStyle: 'none' }}>
            {messages.map((msg) => (
              <div key={msg.id}>
                {msg.role === 'scholar' ? (
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                    <Feather size={14} style={{ color: '#444', flexShrink: 0, marginTop: 4 }} />
                    <p style={{ margin: 0, fontFamily: 'var(--font-inter)', fontSize: 15, fontWeight: 300, color: '#FFFFFF', lineHeight: 1.75 }}>
                      {msg.isNew ? <TypewriterText text={msg.text} /> : msg.text}
                    </p>
                  </div>
                ) : (
                  <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                    <div style={{ maxWidth: '75%', padding: '12px 18px', background: 'rgba(192,132,252,0.08)', border: '1px solid rgba(192,132,252,0.15)', borderRadius: 12, fontFamily: 'var(--font-inter)', fontSize: 15, fontWeight: 300, color: '#FFFFFF', lineHeight: 1.65 }}>
                      {msg.text}
                    </div>
                  </div>
                )}
              </div>
            ))}

            {isTyping && (
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <Feather size={14} style={{ color: '#444', flexShrink: 0 }} />
                <div style={{ display: 'flex', gap: 5, padding: '4px 0' }}>
                  {[0, 1, 2].map((i) => (
                    <motion.div key={i} style={{ width: 5, height: 5, borderRadius: '50%', background: '#444' }} animate={{ opacity: [0.3, 1, 0.3] }} transition={{ duration: 0.8, repeat: Infinity, delay: i * 0.2 }} />
                  ))}
                </div>
              </motion.div>
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <div style={{ padding: '16px 48px 32px', flexShrink: 0 }}>
            <div style={{ display: 'flex', gap: 12, alignItems: 'center', background: '#111114', border: '1px solid #222', borderRadius: 16, padding: '4px 6px 4px 18px' }}>
              <input
                type="text"
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Write in the notebook..."
                style={{ flex: 1, background: 'transparent', border: 'none', fontSize: 14, fontFamily: 'var(--font-inter)', fontWeight: 300, color: '#E8E4DE', outline: 'none', cursor: 'none', padding: '10px 0' }}
              />
              <motion.button
                onClick={handleSend}
                aria-label="Send"
                whileHover={canSend ? { scale: 1.1 } : {}}
                whileTap={canSend ? { scale: 0.9 } : {}}
                disabled={!canSend}
                style={{ width: 38, height: 38, borderRadius: 12, background: 'transparent', border: 'none', cursor: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}
              >
                <Send size={16} color={canSend ? '#C084FC' : '#333'} />
              </motion.button>
            </div>
          </div>
        </div>
      </div>
    </motion.div>
  );
}
