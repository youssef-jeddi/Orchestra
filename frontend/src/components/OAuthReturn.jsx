'use client';

// Always mounted under PrivyProvider: Privy finishes a sign-in that started on a provider's page
// (Google, Apple, …) only while the OAuth hook is mounted on the page it returns to. Renders nothing.

import { useLoginWithOAuth } from '@privy-io/react-auth';

export default function OAuthReturn() {
  useLoginWithOAuth();
  return null;
}
