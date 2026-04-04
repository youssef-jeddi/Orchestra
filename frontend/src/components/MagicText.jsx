'use client';

import { useRef } from 'react';
import { motion, useInView } from 'framer-motion';

const TAGS = {
  h1: motion.h1,
  h2: motion.h2,
  h3: motion.h3,
  p:  motion.p,
  span: motion.span,
};

const containerVariants = {
  hidden:  {},
  visible: (delay) => ({
    transition: { staggerChildren: 0.03, delayChildren: delay ?? 0 },
  }),
};

// Lusion style — lent et élégant (blur léger, 0.6s par lettre)
const letterVariant = {
  hidden:  { opacity: 0, filter: 'blur(8px)', y: 8 },
  visible: {
    opacity: 1,
    filter:  'blur(0px)',
    y: 0,
    transition: { duration: 0.6, ease: [0.16, 1, 0.3, 1] },
  },
};

export default function MagicText({
  text,
  tag = 'span',
  delay = 0,
  style,
  className,
}) {
  const ref    = useRef(null);
  const inView = useInView(ref, { once: true, margin: '-60px 0px' });
  const Tag    = TAGS[tag] ?? motion.span;

  return (
    <Tag
      ref={ref}
      variants={containerVariants}
      initial="hidden"
      animate={inView ? 'visible' : 'hidden'}
      custom={delay}
      style={style}
      className={className}
    >
      {text.split('').map((char, i) => (
        <motion.span
          key={i}
          variants={letterVariant}
          style={{
            display: 'inline-block',
            whiteSpace: char === ' ' ? 'pre' : undefined,
          }}
        >
          {char === ' ' ? '\u00A0' : char}
        </motion.span>
      ))}
    </Tag>
  );
}
