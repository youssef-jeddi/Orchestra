// ── Which sign-in buttons Privy shows (ORC-74) ──
// The `loginMethods` list in the Privy config replaces the dashboard's choice of buttons: a method
// listed here is shown even when it is off in the Privy dashboard, and then fails when clicked.
// So Google is opt-in: it's listed only when NEXT_PUBLIC_PRIVY_GOOGLE=1, set on Vercel once Google
// is enabled in the Privy dashboard. Pure, so it's tested without a browser
// (src/auth/loginMethods.test.ts).

/** True for "1" or "true" (any case, spaces ignored); anything else, unset included, is off. */
export const flagOn = (value) => /^(1|true)$/i.test(String(value ?? '').trim());

/** The login methods for the Privy config, given the NEXT_PUBLIC_PRIVY_GOOGLE value. */
export function loginMethodsFor(googleFlag) {
  return flagOn(googleFlag) ? ['passkey', 'email', 'google', 'wallet'] : ['passkey', 'email', 'wallet'];
}

/** The line under "Sign in to Orchestra", naming only the buttons that are there. */
export function loginMessageFor(googleFlag) {
  return flagOn(googleFlag)
    ? 'Use a passkey, your email or Google. Already have a wallet? Connect it.'
    : 'Use a passkey or your email. Already have a wallet? Connect it.';
}
