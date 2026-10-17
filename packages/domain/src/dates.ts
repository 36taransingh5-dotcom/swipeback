/** Calendar dates as 'YYYY-MM-DD' strings; arithmetic in whole UTC days (no implicit timezones). */
export type IsoDate = string;

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

export function isIsoDate(s: string): boolean {
  if (!ISO_DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function toUtcDay(d: IsoDate): number {
  if (!isIsoDate(d)) throw new RangeError(`Not an ISO date: ${d}`);
  return Date.parse(`${d}T00:00:00Z`) / DAY_MS;
}

function fromUtcDay(day: number): IsoDate {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

/** Whole days from `a` to `b` (positive when b is later). */
export function daysBetween(a: IsoDate, b: IsoDate): number {
  return toUtcDay(b) - toUtcDay(a);
}

export function addDays(d: IsoDate, n: number): IsoDate {
  return fromUtcDay(toUtcDay(d) + n);
}

/** Monday of the ISO week containing `d`. */
export function startOfIsoWeek(d: IsoDate): IsoDate {
  const day = toUtcDay(d);
  const weekday = (new Date(day * DAY_MS).getUTCDay() + 6) % 7; // Monday = 0
  return fromUtcDay(day - weekday);
}

export function startOfMonth(d: IsoDate): IsoDate {
  toUtcDay(d);
  return `${d.slice(0, 8)}01`;
}

/** The instant (ISO, UTC) of a wall-clock date and 'HH:MM' time in an IANA timezone. */
export function instantFromZoned(date: IsoDate, time: string, timeZone: string): string {
  if (!isIsoDate(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new RangeError(`Not a local date/time: ${date} ${time}`);
  const wall = Date.parse(`${date}T${time}:00Z`);
  // Offset of the zone at a given instant, from its formatted wall-clock parts.
  const offsetAt = (t: number) => {
    const p = Object.fromEntries(
      new Intl.DateTimeFormat('en-GB', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
        .formatToParts(t)
        .map((x) => [x.type, x.value]),
    );
    return Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:00Z`) - t;
  };
  let t = wall - offsetAt(wall);
  t = wall - offsetAt(t); // second pass settles DST boundaries
  return new Date(t).toISOString();
}

/** The calendar date of an instant in a given IANA timezone. */
export function dateInZone(instantIso: string, timeZone: string): IsoDate {
  const t = Date.parse(instantIso);
  if (Number.isNaN(t)) throw new RangeError(`Not an ISO instant: ${instantIso}`);
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(t);
}
