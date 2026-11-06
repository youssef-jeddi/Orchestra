// ─── Waitlist (/waitlist) — fonts and page title for the public waitlist page (ORC-50) ───
// The fonts are loaded here, not in the root layout, so the app pages keep their own and don't
// download these.
//
// The title uses Redaction 35 and Redaction 20, the worn-down cuts of Redaction. They're on Google
// Fonts but not yet in this Next version's next/font list, so they come from Google's stylesheet;
// React hoists the <link> into <head>. Self-host them with next/font/local if that changes.
//
// The subtitle uses Glacial Indifference, which isn't on Google Fonts: it's bundled from ./fonts
// (SIL Open Font License, see fonts/OFL.txt).

import { Geist, Geist_Mono } from 'next/font/google';
import localFont from 'next/font/local';

const sans = Geist({ variable: '--font-geist', subsets: ['latin'] });
const mono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'] });
const glacial = localFont({
  variable: '--font-glacial',
  src: [
    { path: './fonts/GlacialIndifference-Regular.otf', weight: '400', style: 'normal' },
    { path: './fonts/GlacialIndifference-Italic.otf', weight: '400', style: 'italic' },
    { path: './fonts/GlacialIndifference-Bold.otf', weight: '700', style: 'normal' },
  ],
});

const REDACTION_CSS =
  'https://fonts.googleapis.com/css2?family=Redaction+20:ital,wght@0,400;1,400&family=Redaction+35:wght@400&display=swap';

export const metadata = {
  title: 'Orchestra — Join the waitlist',
  description: 'Crypto kept most people out. Orchestra is the way in: say what you want, routine moves run on their own, and anything that matters waits for your approval.',
};

export default function WaitlistLayout({ children }) {
  return (
    <div className={`${sans.variable} ${mono.variable} ${glacial.variable}`}>
      <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
      <link rel="stylesheet" href={REDACTION_CSS} precedence="default" />
      {children}
    </div>
  );
}
