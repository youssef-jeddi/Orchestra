// ─── Waitlist — form wording and email check for /waitlist (ORC-50) ───
// Pure helpers, shared with the tests in src/policy/waitlistUi.test.ts. The page only renders
// what these return, so the wording and the check can be tested without a browser.
//
// Signups are not saved yet: storage is a follow-up (the bridge's own storage can be 0G, a public
// network, so emails must not go there). `joinWaitlist` is the one place to plug it in.

export const WAITLIST_TEXT = {
  empty: 'Enter your email to join the waitlist.',
  invalid: 'That email doesn’t look complete. Check it and try again, like name@example.com.',
  joinedTag: '[ You’re on the list ]',
  joined: 'We’ll email you when early access opens.',
};

// Deliberately loose: one @, something before it, a dot in the part after it, no spaces.
// The real check is the confirmation email later; this only catches typos before sending.
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 254; // the longest address the email standard allows

/** The address as it will be stored: no surrounding spaces, lower case. */
export function normalizeEmail(raw) {
  return String(raw ?? '').trim().toLowerCase();
}

/** The sentence to show under the field, or null when the address can be sent. */
export function emailProblem(raw) {
  const email = normalizeEmail(raw);
  if (!email) return WAITLIST_TEXT.empty;
  if (email.length > MAX_EMAIL_LENGTH || !EMAIL_SHAPE.test(email)) return WAITLIST_TEXT.invalid;
  return null;
}

/**
 * Add an address to the waitlist. Not wired to storage yet (see the file header): it resolves
 * without saving, so the page can show the joined state.
 */
export async function joinWaitlist(raw) {
  const problem = emailProblem(raw);
  if (problem) throw new Error(problem);
  return { saved: false };
}
