// ── Pausing automatic actions on /simple (ORC-39): wording and what the banner offers ──
// The server decides what is paused (GET /pause) and whether resuming needs proof (the same rule as
// raising a limit); this file only turns its answer into the banner and the Limits-sheet switch, in
// everyday words. Pure, so it's tested without a browser (src/policy/killSwitch.test.ts).

export const PAUSE_TEXT = {
  toggle: 'Pause automatic actions',
  toggleHint: 'While paused, I ask for your OK before every payment, swap or liquidity change, whatever your limits say.',
  paused: 'Automatic actions are paused.',
  resumed: 'Automatic actions are back on.',
  resume: 'Resume',
  resuming: 'Resuming…',
};

/**
 * The banner above the chat, or null when nothing is paused. `resume` is true only for the wallet's
 * own pause: a pause for everyone is the team's to lift, so it gets no button.
 */
export function pauseBanner(status) {
  if (!status) return null;
  const lines = [];
  if (status.unreadable) lines.push("I can't check right now whether automatic actions are on, so I'll ask for your OK before every payment.");
  else if (status.wallet) lines.push("You paused automatic actions. I'll ask for your OK before every payment, swap or liquidity change.");
  if (status.global && !status.unreadable) lines.push("Orchestra has paused automatic actions for everyone for now. I'll ask for your OK before every payment.");
  if (status.other && !status.unreadable) lines.push("I couldn't save the record of your last automatic payment, so I'll ask before the next one until it's saved.");
  if (lines.length === 0) return null;
  return { text: lines.join(' '), resume: !!status.wallet && !status.unreadable };
}

/** The change the Limits sheet sends for the switch. Resuming may ask for the passkey (server rule). */
export const pauseChange = (paused) => ({ pauseAuto: paused });
