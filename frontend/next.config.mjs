import { readFileSync } from 'fs';

// The phone opens approval pages on PUBLIC_APP_URL (e.g. a cloudflared tunnel in
// dev); the dev server must accept that host. It's configured once, in the
// backend's .env at the repo root — read from there unless set for the frontend.
function publicAppUrl() {
  if (process.env.PUBLIC_APP_URL) return process.env.PUBLIC_APP_URL;
  try {
    const env = readFileSync(new URL('../.env', import.meta.url), 'utf8');
    return env.match(/^PUBLIC_APP_URL=(.*)$/m)?.[1].trim().replace(/^["']|["']$/g, '') || undefined;
  } catch {
    return undefined;
  }
}

const publicHost = (() => {
  try { return new URL(publicAppUrl()).hostname; } catch { return null; }
})();

/** @type {import('next').NextConfig} */
const nextConfig = {
  allowedDevOrigins: publicHost ? [publicHost] : [],
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
