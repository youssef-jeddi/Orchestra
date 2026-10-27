// ── Backup sign-in: a second way back into the same account (ORC-58) ──
// A passkey-only user who loses their device loses their only way to sign in. Privy keeps one user
// per person: every login method linked to it (passkey, email, Google, a wallet) signs in to that
// same user, and so to the same embedded wallet, which owns the user's account (the Safe). Linking
// an email is the first backup we offer: it works on any device. Pure, so it's tested without a
// browser (src/integrations/passkey/backupSignIn.test.ts).

/** Plain-language names for the login methods Privy can link, in the order we list them. */
const METHOD_NAMES = {
  passkey: 'Passkey',
  email: 'Email',
  phone: 'Phone number',
  google_oauth: 'Google',
  apple_oauth: 'Apple',
  wallet: 'Wallet',
};

// Accounts that let the user sign in again on a new device, apart from a passkey on the lost one.
const isBackupAccount = (a) =>
  a?.type === 'email' || a?.type === 'phone' || a?.type === 'farcaster' || a?.type === 'telegram' ||
  (typeof a?.type === 'string' && a.type.endsWith('_oauth')) ||
  (a?.type === 'wallet' && a.walletClientType !== 'privy'); // an external wallet signs in too; the embedded one doesn't

/** The detail shown next to a method: the address for email, Google, a wallet; nothing for a passkey. */
function detailOf(a) {
  if (a.type === 'email') return a.address || '';
  if (a.type === 'phone') return a.number || a.phoneNumber || '';
  if (a.type === 'wallet') return a.address ? `${a.address.slice(0, 6)}…${a.address.slice(-4)}` : '';
  if (typeof a.type === 'string' && a.type.endsWith('_oauth')) return a.email || a.username || a.name || '';
  return '';
}

/**
 * The sign-in methods linked to the Privy user, for the "Sign-in methods" list: one row per method
 * (passkeys counted together), the embedded wallet left out (it's the account, not a way in).
 */
export function linkedMethods(linkedAccounts = []) {
  const rows = [];
  const passkeys = linkedAccounts.filter((a) => a?.type === 'passkey').length;
  if (passkeys) rows.push({ type: 'passkey', name: METHOD_NAMES.passkey, detail: passkeys > 1 ? `${passkeys} passkeys` : '' });
  for (const a of linkedAccounts) {
    if (!isBackupAccount(a)) continue;
    const name = METHOD_NAMES[a.type] || (a.type.endsWith('_oauth') ? cap(a.type.slice(0, -6)) : cap(a.type));
    rows.push({ type: a.type, name, detail: detailOf(a) });
  }
  return rows;
}
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** True when the user can only sign in with a passkey: losing the device would lock them out. */
export function isPasskeyOnly(linkedAccounts = []) {
  return linkedAccounts.some((a) => a?.type === 'passkey') && !linkedAccounts.some(isBackupAccount);
}

/** May we offer to link an email? Privy allows one email per user. */
export const canLinkEmail = (linkedAccounts = []) => !linkedAccounts.some((a) => a?.type === 'email');

/** Some money is in the account: the first deposit has landed. */
export const hasFunds = (b) => !!b && ((b.eth || 0) > 0 || (b.usdc || 0) > 0 || (b.weth || 0) > 0);

// ── The one-time nudge after the first deposit ──

const NUDGE_KEY = (wallet) => `orchestra:backup-nudge:${String(wallet).toLowerCase()}`;

/**
 * Whether the nudge was already shown for this wallet, kept in this browser. Only that fact is
 * stored, no address book, no tokens. `storage` is injected so it's tested without a browser.
 */
export function nudgeMemory(storage) {
  return {
    seen(wallet) { try { return !!storage.getItem(NUDGE_KEY(wallet)); } catch { return false; } },
    markSeen(wallet, now = Date.now()) { try { storage.setItem(NUDGE_KEY(wallet), String(now)); } catch { /* private mode: it may show again, harmless */ } },
  };
}

/** Show the nudge: a passkey-only user, money in the account, never shown before on this browser. */
export const shouldNudge = ({ passkeyOnly, funded, seen }) => !!passkeyOnly && !!funded && !seen;

export const NUDGE_TITLE = 'Add a backup sign-in';
export const NUDGE_TEXT =
  "You only sign in with a passkey on this device. Add your email too, so you can get back to your account if you lose it.";
export const BACKUP_HELP =
  "If you lose this device, sign in with your email instead and you'll find the same account and money.";
export const LINKED_EMAIL_OK = 'Email added. You can now sign in with it on any device.';

/** A plain sentence for a failed link, or null when the user just closed the window. */
export function linkError(code) {
  if (code === 'exited_link_flow' || code === 'exited_auth_flow') return null;
  if (code === 'linked_to_another_user') return 'That email already belongs to another account, so it can\'t be added here. Use a different email.';
  if (code === 'cannot_link_more_of_type') return 'This account already has an email.';
  if (code === 'disallowed_login_method' || code === 'not_supported') return "Email sign-in isn't turned on for Orchestra yet.";
  if (code === 'invalid_credentials') return "That code didn't work. Try again and ask for a new one.";
  return "We couldn't add your email. Please try again.";
}
