'use client';

import { useState, useEffect } from 'react';

const FONTS = [
  'var(--font-playfair), Playfair Display, serif',
  'var(--font-inter), Inter, sans-serif',
  'Georgia, serif',
  'Courier New, monospace',
  'Times New Roman, serif',
  'system-ui, Futura, sans-serif',
  'Garamond, serif',
  'Impact, sans-serif',
  'Trebuchet MS, sans-serif',
  'Palatino, serif',
];

export default function FontMorph({ text, style = {} }) {
  const [idx, setIdx] = useState(0);

  useEffect(() => {
    const iv = setInterval(() => setIdx(p => (p + 1) % FONTS.length), 100);
    return () => clearInterval(iv);
  }, []);

  return (
    <span style={{ ...style, fontFamily: FONTS[idx] }}>
      {text}
    </span>
  );
}
