import type { IsoDate } from './dates.ts';

/**
 * Merchant location as an advisory risk signal. It compares where a card alert says the payment
 * happened with where the cardholder normally is (home and work areas) or has declared a trip.
 * It never rejects, never changes amounts, and anything missing or not comparable is neutral.
 */

export interface StatedLocation {
  /** Exactly as written in the alert. */
  text: string;
  city: string | null;
  /** ISO 3166-1 alpha-2, only when the alert itself names the country. */
  country: string | null;
}

export interface Area {
  city: string | null;
  country: string;
}

export interface LocationProfile {
  home: readonly Area[];
  work: readonly Area[];
  trips: readonly (Area & { startsOn: IsoDate; endsOn: IsoDate })[];
}

export type LocationAssessment =
  | { status: 'NO_LOCATION' }
  | { status: 'NO_BASELINE'; location: StatedLocation }
  | { status: 'NOT_COMPARABLE'; location: StatedLocation }
  | { status: 'CONSISTENT'; location: StatedLocation; matchedBy: 'HOME' | 'WORK' | 'TRIP' }
  | { status: 'MISMATCH'; location: StatedLocation; detail: string };

const COUNTRY_NAMES: Readonly<Record<string, string>> = {
  'united kingdom': 'GB', uk: 'GB', gb: 'GB', gbr: 'GB', 'great britain': 'GB', britain: 'GB', england: 'GB', scotland: 'GB', wales: 'GB', 'northern ireland': 'GB',
  ireland: 'IE', 'republic of ireland': 'IE', ie: 'IE', irl: 'IE',
  france: 'FR', fr: 'FR', fra: 'FR',
  germany: 'DE', deutschland: 'DE', de: 'DE', deu: 'DE',
  spain: 'ES', espana: 'ES', es: 'ES', esp: 'ES',
  portugal: 'PT', pt: 'PT', prt: 'PT',
  italy: 'IT', italia: 'IT', it: 'IT', ita: 'IT',
  netherlands: 'NL', 'the netherlands': 'NL', holland: 'NL', nl: 'NL', nld: 'NL',
  belgium: 'BE', be: 'BE', bel: 'BE',
  switzerland: 'CH', ch: 'CH', che: 'CH',
  austria: 'AT', at: 'AT', aut: 'AT',
  denmark: 'DK', dk: 'DK', dnk: 'DK',
  sweden: 'SE', se: 'SE', swe: 'SE',
  norway: 'NO', no: 'NO', nor: 'NO',
  poland: 'PL', pl: 'PL', pol: 'PL',
  'united states': 'US', 'united states of america': 'US', usa: 'US', us: 'US',
  canada: 'CA', ca: 'CA', can: 'CA',
  'united arab emirates': 'AE', uae: 'AE', ae: 'AE',
  australia: 'AU', au: 'AU', aus: 'AU',
  india: 'IN', ind: 'IN',
  japan: 'JP', jp: 'JP', jpn: 'JP',
  singapore: 'SG', sg: 'SG', sgp: 'SG',
};

const fold = (s: string) => s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** ISO alpha-2 for a country name or code as written; null when not recognised (never guessed). */
export function countryCode(written: string | null | undefined): string | null {
  if (!written) return null;
  return COUNTRY_NAMES[fold(written)] ?? null;
}

/** True when `text` itself names `code` (so a country is only used if the alert states it). */
export function textNamesCountry(text: string, code: string): boolean {
  const words = fold(text).split(' ');
  for (let n = 1; n <= 5; n++) {
    for (let i = 0; i + n <= words.length; i++) {
      const phrase = words.slice(i, i + n).join(' ');
      // Two-letter codes only count in upper case in the original ("GB", not the word "in").
      if (phrase.length <= 3 && !new RegExp(`\\b${phrase.toUpperCase()}\\b`).test(text)) continue;
      if (COUNTRY_NAMES[phrase] === code) return true;
    }
  }
  return false;
}

const sameCity = (a: string | null, b: string | null) => !!a && !!b && fold(a) === fold(b);

function describeArea(a: Area): string {
  return a.city ? `${a.city}, ${a.country}` : a.country;
}

/** Equal countries is the most that can be said when either side has no city. */
function compareArea(location: StatedLocation, a: Area): 'FITS' | 'DIFFERS' | 'UNKNOWN' {
  if (location.country && location.country !== a.country) return 'DIFFERS';
  if (a.city && location.city) return sameCity(a.city, location.city) ? 'FITS' : 'DIFFERS';
  return location.country ? 'FITS' : 'UNKNOWN';
}

export function assessLocation(location: StatedLocation | null, profile: LocationProfile, transactionDate: IsoDate): LocationAssessment {
  if (!location || (!location.city && !location.country)) return { status: 'NO_LOCATION' };
  const trips = profile.trips.filter((t) => t.startsOn <= transactionDate && transactionDate <= t.endsOn);
  const usual: [Area, 'HOME' | 'WORK'][] = [...profile.home.map((a) => [a, 'HOME'] as [Area, 'HOME']), ...profile.work.map((a) => [a, 'WORK'] as [Area, 'WORK'])];
  if (!usual.length && !trips.length) return { status: 'NO_BASELINE', location };

  const tripResults = trips.map((t) => compareArea(location, t));
  if (tripResults.includes('FITS')) return { status: 'CONSISTENT', location, matchedBy: 'TRIP' };
  for (const [a, kind] of usual) if (compareArea(location, a) === 'FITS') return { status: 'CONSISTENT', location, matchedBy: kind };
  // A declared trip that cannot be compared might explain the payment: stay neutral.
  const usualResults = usual.map(([a]) => compareArea(location, a));
  if (tripResults.includes('UNKNOWN') || ![...tripResults, ...usualResults].includes('DIFFERS')) return { status: 'NOT_COMPARABLE', location };

  const parts = [
    profile.home.length ? `home ${profile.home.map(describeArea).join(' / ')}` : null,
    profile.work.length ? `work ${profile.work.map(describeArea).join(' / ')}` : null,
    trips.length ? `trip ${trips.map(describeArea).join(' / ')}` : `no trip declared for ${transactionDate}`,
  ].filter(Boolean);
  return { status: 'MISMATCH', location, detail: `Card alert location "${location.text}" is outside the cardholder's usual areas (${parts.join('; ')})` };
}
