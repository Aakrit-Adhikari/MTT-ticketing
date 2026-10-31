import Link from 'next/link';
import { ReactNode } from 'react';
import Logo from '@/components/Logo';

/** Public site frame. Pass `hero` to place a full-width banner (and search card) above the page content. */
export default function SiteShell({ children, hero }: { children?: ReactNode; hero?: ReactNode }) {
  return (
    <div className="pub">
      <header className="pub-header">
        <div className="in">
          <Link href="/" className="pub-brand" aria-label="Mountain Tours and Travels Ticketing home"><Logo on="auto" className="logo" /></Link>
          <nav className="pub-nav" aria-label="Main">
            <Link href="/">Search flights</Link>
            <Link href="/lookup">Find my booking</Link>
            <Link href="/#how-it-works">How it works</Link>
            <Link href="/policies">Policies</Link>
            <Link href="/contact">Contact</Link>
          </nav>
        </div>
      </header>
      {hero}
      <main className="pub-main">{children}</main>
      <footer className="pub-footer">
        <div className="in">
          <div className="col wide">
            <Logo on="dark" className="flogo" />
            <b className="fb">Mountain Tours and Travels Ticketing</b>
            <p>Search the seats we hold with airlines, send an inquiry, and our staff confirm it with the airline for you. No payment is taken on this website.</p>
          </div>
          <div className="col">
            <b>Book</b>
            <Link href="/">Search flights</Link>
            <Link href="/#how-it-works">How it works</Link>
            <Link href="/lookup">Find my booking</Link>
          </div>
          <div className="col">
            <b>Help</b>
            <Link href="/policies">Policies</Link>
            <Link href="/contact">Contact us</Link>
          </div>
        </div>
        <div className="in legal">Seats are confirmed manually by our staff. An inquiry is not a ticket until we confirm it.</div>
      </footer>
    </div>
  );
}
