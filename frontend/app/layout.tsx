import type { Metadata } from 'next';
import './globals.css';
import './public.css';
import './calendar.css';

export const metadata: Metadata = {
  title: { default: 'Mountain Tours and Travels Ticketing', template: '%s · Mountain Tours and Travels Ticketing' },
  icons: { icon: '/img/logo-512.png', apple: '/img/logo-512.png' },
  description: 'Search available departures and send a booking inquiry. Bookings are confirmed manually by our staff.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
