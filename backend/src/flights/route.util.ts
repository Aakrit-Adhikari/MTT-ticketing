/** A flight is either a route (origin to destination) or a sector (one name, e.g. a mountain flight). These describe either. */
interface RouteBits {
  origin?: { iata?: string; city?: string } | null;
  destination?: { iata?: string; city?: string } | null;
  sector?: { name: string } | null;
}

/** Short code used in tables and CSV: "KTM-PKR", or the sector name. */
export const routeCode = (f: RouteBits): string => (f.origin && f.destination ? `${f.origin.iata ?? "?"}-${f.destination.iata ?? "?"}` : (f.sector?.name ?? 'Sector flight'));

/** Plain words for emails: "Kathmandu to Pokhara", or the sector name. */
export const routeWords = (f: RouteBits): string =>
  f.origin && f.destination ? `${f.origin.city ?? f.origin.iata ?? "?"} to ${f.destination.city ?? f.destination.iata ?? "?"}` : (f.sector?.name ?? 'Sector flight');
