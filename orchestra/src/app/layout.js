import { Playfair_Display, Inter } from 'next/font/google';
import "./globals.css";

const playfair = Playfair_Display({
  variable: '--font-playfair',
  subsets: ['latin'],
});

const inter = Inter({
  variable: '--font-inter',
  subsets: ['latin'],
});

export const metadata = {
  title: "Orchestra — Join the Waitlist",
  description: "Your AI-Powered DeFi Conductor. Join the waitlist for early access.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" className={`${playfair.variable} ${inter.variable}`}>
      <body>{children}</body>
    </html>
  );
}
