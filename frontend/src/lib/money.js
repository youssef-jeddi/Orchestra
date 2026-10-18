// ── Dollar amounts in the UI ──
// Same rules as src/policy/money.ts (a test keeps them in step): cents, whole dollars without
// ".00", thousands separators, and "less than $0.01" for a tiny non-zero amount.

export function formatUsd(n) {
  if (!Number.isFinite(n)) return '$0';
  const cents = Math.round(Math.abs(n) * 100) / 100;
  if (cents === 0) return n === 0 ? '$0' : 'less than $0.01';
  const text = cents.toLocaleString('en-US', { minimumFractionDigits: Number.isInteger(cents) ? 0 : 2, maximumFractionDigits: 2 });
  return `${n < 0 ? '-' : ''}$${text}`;
}
