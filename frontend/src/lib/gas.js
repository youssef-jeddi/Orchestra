// ── "Network fees covered by Orchestra today" on /simple (ORC-31) ──
// What the bridge's GET /gas returns (the fees Orchestra's relayer paid today for this account),
// turned into one small line in everyday words. Pure, so it's tested without a browser
// (src/policy/gasBudget.test.ts). Nothing paid yet and nothing over budget: no line at all.

export const GAS_USED_UP = "Today's free network fees are used up, so new actions wait until tomorrow.";

const WEI_PER_ETH = 10n ** 18n;
const SMALLEST = 10n ** 12n; // 0.000001 ETH: below this the exact figure means nothing to a newcomer

/** Wei (decimal string) as ETH for reading: up to 6 decimals, trailing zeros dropped. */
export function formatEthAmount(wei) {
  let v;
  try { v = BigInt(wei); } catch { return null; }
  if (v <= 0n) return '0 ETH';
  if (v < SMALLEST) return 'less than 0.000001 ETH';
  const whole = v / WEI_PER_ETH;
  const frac = ((v % WEI_PER_ETH) / SMALLEST).toString().padStart(6, '0').replace(/0+$/, '');
  return `${whole}${frac ? `.${frac}` : ''} ETH`;
}

/** The line to show, or null. `view` is GET /gas's answer (or null when it couldn't be read). */
export function gasLine(view) {
  if (!view) return null;
  let covered = 0n;
  try { covered = BigInt(view.coveredWei ?? '0'); } catch { return null; }
  const parts = [];
  if (covered > 0n) parts.push(`Network fees covered by Orchestra today: ${formatEthAmount(view.coveredWei)}.`);
  if (view.overBudget) parts.push(GAS_USED_UP);
  return parts.length ? parts.join(' ') : null;
}
