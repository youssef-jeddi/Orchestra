import { readFileSync } from 'fs';

// Some settings are shared with the backend and configured once, in its .env at
// the repo root — read from there unless set for the frontend.
function rootEnv(name) {
  if (process.env[name]) return process.env[name];
  try {
    const env = readFileSync(new URL('../.env', import.meta.url), 'utf8');
    return env.match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1].trim().replace(/^["']|["']$/g, '') || undefined;
  } catch {
    return undefined;
  }
}

// The phone opens approval pages on PUBLIC_APP_URL (e.g. a cloudflared tunnel in
// dev); the dev server must accept that host.
const publicHost = (() => {
  try { return new URL(rootEnv('PUBLIC_APP_URL')).hostname; } catch { return null; }
})();

/** @type {import('next').NextConfig} */
const nextConfig = {
  allowedDevOrigins: publicHost ? [publicHost] : [],
  // Privy's app ID is public; the backend verifies sign-ins against the same app.
  env: {
    NEXT_PUBLIC_PRIVY_APP_ID: process.env.NEXT_PUBLIC_PRIVY_APP_ID || rootEnv('PRIVY_APP_ID') || '',
  },
  transpilePackages: [
    'three',
    '@react-three/fiber',
    '@react-three/drei',
    '@react-three/postprocessing',
    '@ledgerhq/device-management-kit',
    '@ledgerhq/device-signer-kit-ethereum',
    '@ledgerhq/device-transport-kit-web-ble',
    '@ledgerhq/context-module',
    'ethers',
  ],
  // The phone approval pages call the bridge through this same-origin proxy, so
  // only the frontend needs a public https address (passkeys are bound to it).
  async rewrites() {
    const bridge = process.env.BRIDGE_INTERNAL_URL || 'http://localhost:3001';
    return [{ source: '/bridge/:path*', destination: `${bridge}/:path*` }];
  },
};

export default nextConfig;
