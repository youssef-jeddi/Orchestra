'use client';

import { motion } from 'framer-motion';

/**
 * MagicButton — style Lusion : smooth, sans spring/bounce.
 *
 * Props :
 *   hoverBg    — backgroundColor au hover (ex: '#C084FC')
 *   hoverColor — color du texte au hover  (ex: '#000')
 *   hoverGlow  — box-shadow au hover
 */
export default function MagicButton({
  children,
  style,
  className,
  hoverBg,
  hoverColor,
  hoverGlow,
  ...props
}) {
  const hoverState = {
    y: -2,
    ...(hoverBg    ? { backgroundColor: hoverBg }    : {}),
    ...(hoverColor ? { color: hoverColor }            : {}),
    ...(hoverGlow  ? { boxShadow: hoverGlow }         : {}),
    transition: { duration: 0.35, ease: [0.16, 1, 0.3, 1] },
  };

  return (
    <motion.button
      whileHover={hoverState}
      whileTap={{ scale: 0.97, transition: { duration: 0.15, ease: 'easeOut' } }}
      style={{ cursor: 'none', ...style }}
      className={className}
      {...props}
    >
      {children}
    </motion.button>
  );
}
