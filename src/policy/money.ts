// ─── Policy — how dollar amounts are written in reasons and notices ───
// One helper for every "$" the user reads in a policy reason, approval text or limits notice, so
// float noise (0.23848400000000003) never reaches the screen. frontend/src/lib/money.js is the same
// function for the UI; a test keeps the two in step.

/**
 * "$4.82", "$100" (whole dollars without ".00"), "$1,000", or "less than $0.01" for a tiny
 * non-zero amount (never a misleading "$0.00"). Rounded to cents.
 */
export function formatUsd(n: number): string {
  if (!Number.isFinite(n)) return "$0";
  const cents = Math.round(Math.abs(n) * 100) / 100;
  if (cents === 0) return n === 0 ? "$0" : "less than $0.01";
  const text = cents.toLocaleString("en-US", { minimumFractionDigits: Number.isInteger(cents) ? 0 : 2, maximumFractionDigits: 2 });
  return `${n < 0 ? "-" : ""}$${text}`;
}
