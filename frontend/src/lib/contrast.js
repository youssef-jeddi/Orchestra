// ── Readable small text on /simple: the hint colour and its contrast check ──
// Hints and helper lines are small, so they must clear WCAG AA (4.5:1) against the dark surfaces
// they sit on. Pure, so the chosen colours are tested (src/policy/simpleUi.test.ts).

/** Colour and size for hint text and card helper lines. */
export const HINT_COLOR = '#A0A0A8';
export const HINT_SIZE = 12;

/** The surfaces hint text sits on: the page and a card. */
export const SURFACES = { page: '#0F0F12', card: '#141418' };

const channel = (v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
function luminance(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

/** WCAG contrast ratio of two #rrggbb colours (1 to 21). */
export function contrastRatio(fg, bg) {
  const [a, b] = [luminance(fg), luminance(bg)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
}
