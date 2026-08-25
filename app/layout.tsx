import type { Metadata } from 'next';
import { IBM_Plex_Mono, Manrope, Newsreader } from 'next/font/google';
import './globals.css';

const sans = Manrope({ variable: '--font-sans', subsets: ['latin'] });
const serif = Newsreader({ variable: '--font-serif', subsets: ['latin'], style: ['normal', 'italic'] });
const mono = IBM_Plex_Mono({ variable: '--font-mono', subsets: ['latin'], weight: ['400', '500', '600'] });
const siteOrigin = process.env.NEXT_PUBLIC_SITE_ORIGIN ?? 'http://localhost:3000';

export const metadata: Metadata = {
  metadataBase: new URL(siteOrigin),
  title: { default: 'SQL Mastery — PostgreSQL, from schema to scale', template: '%s | SQL Mastery' },
  description: 'An interactive PostgreSQL curriculum covering schema design, production architecture, advanced systems, and Node.js interviews.',
  openGraph: { title: 'SQL Mastery', description: 'PostgreSQL, from schema to scale.', type: 'website' },
  twitter: { card: 'summary_large_image', title: 'SQL Mastery', description: 'PostgreSQL, from schema to scale.' },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body className={`${sans.variable} ${serif.variable} ${mono.variable}`}><a className="skip-link" href="#main-content">Skip to content</a>{children}</body></html>;
}
