'use client';

import { useState } from 'react';
import { motion } from 'framer-motion';
import { Send } from 'lucide-react';

export default function SearchBar({ onSubmit }) {
  const [value, setValue] = useState('');

  const handleSubmit = () => {
    const text = value.trim();
    if (!text) return;
    onSubmit?.(text);
    setValue('');
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <>
      <style>{`
        .sb-wrap {
          position: fixed; bottom: 32px; left: 50%; transform: translateX(-50%);
          z-index: 50; width: 520px; max-width: 90vw;
        }
        .sb-pill {
          transition: border-color 0.25s cubic-bezier(0.16,1,0.3,1), box-shadow 0.25s cubic-bezier(0.16,1,0.3,1);
        }
        .sb-pill:hover, .sb-pill:focus-within {
          border-color: #C084FC !important;
          box-shadow: 0 0 20px rgba(192,132,252,0.15) !important;
        }
      `}</style>

      <motion.div
        className="sb-wrap"
        animate={{ y: [0, -4, 0] }}
        transition={{ repeat: Infinity, duration: 2, ease: 'easeInOut' }}
      >
        <div
          className="sb-pill"
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
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Where do you want to invest today?"
            style={{
              flex: 1, background: 'transparent', border: 'none',
              fontFamily: 'var(--font-inter)', fontSize: 15, fontWeight: 300,
              color: '#E8E4DE', outline: 'none', cursor: 'none',
            }}
          />
          <motion.button
            onClick={handleSubmit}
            aria-label="Search"
            whileHover={value.trim() ? { scale: 1.1 } : {}}
            whileTap={value.trim() ? { scale: 0.9 } : {}}
            style={{ background: 'transparent', border: 'none', cursor: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, padding: 0 }}
          >
            <Send size={18} color={value.trim() ? '#C084FC' : '#555'} />
          </motion.button>
        </div>
      </motion.div>
    </>
  );
}
