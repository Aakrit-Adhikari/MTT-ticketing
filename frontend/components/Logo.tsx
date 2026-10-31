/** Company logo (transparent PNG). `on` picks the ink colour for the surface it sits on. */
const NAVY = '/img/logo-transparent.png';
const WHITE = '/img/logo-white.png';
const ALT = 'Mountain Tours and Travels Ticketing';

export default function Logo({ on, className }: { on: 'light' | 'dark' | 'auto'; className?: string }) {
  if (on === 'auto') {
    // Follows the visitor's light/dark setting, like the rest of the page.
    return (
      <picture>
        <source media="(prefers-color-scheme: dark)" srcSet={WHITE} />
        <img src={NAVY} alt={ALT} className={className} />
      </picture>
    );
  }
  return <img src={on === 'dark' ? WHITE : NAVY} alt={ALT} className={className} />;
}
