/**
 * Money is always an integer number of minor units (pence, cents) plus an ISO 4217 currency.
 * Floats never enter the domain: parsing from text happens at the edge and must produce minor units.
 */

export type CurrencyCode = string & { readonly __brand: 'CurrencyCode' };

export interface Money {
  readonly amountMinor: number;
  readonly currency: CurrencyCode;
}

const CURRENCY_RE = /^[A-Z]{3}$/;

/** Minor-unit exponent for currencies we expect in demos; default 2. */
const MINOR_UNIT_EXPONENT: Readonly<Record<string, number>> = {
  JPY: 0,
  KRW: 0,
  BHD: 3,
  KWD: 3,
  OMR: 3,
};

export function currency(code: string): CurrencyCode {
  if (!CURRENCY_RE.test(code)) throw new MoneyError(`Invalid ISO 4217 currency code: ${JSON.stringify(code)}`);
  return code as CurrencyCode;
}

export function minorUnitExponent(c: CurrencyCode): number {
  return MINOR_UNIT_EXPONENT[c] ?? 2;
}

export function money(amountMinor: number, code: string): Money {
  if (!Number.isSafeInteger(amountMinor)) {
    throw new MoneyError(`Money amount must be a safe integer of minor units, got ${amountMinor}`);
  }
  return { amountMinor, currency: currency(code) };
}

export class MoneyError extends Error {
  override readonly name = 'MoneyError';
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) throw new MoneyError(`Currency mismatch: ${a.currency} vs ${b.currency}`);
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amountMinor + b.amountMinor, a.currency);
}

export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amountMinor - b.amountMinor, a.currency);
}

export function compare(a: Money, b: Money): -1 | 0 | 1 {
  assertSameCurrency(a, b);
  return a.amountMinor < b.amountMinor ? -1 : a.amountMinor > b.amountMinor ? 1 : 0;
}

export function equals(a: Money, b: Money): boolean {
  return a.currency === b.currency && a.amountMinor === b.amountMinor;
}

export function zero(code: string): Money {
  return money(0, code);
}

/**
 * Parse a decimal string such as "42.10", "1,234.5" or "-3" into minor units without floating point.
 * Returns null for anything ambiguous (multiple decimal points, too many fraction digits, stray characters).
 */
export function parseDecimalToMinor(text: string, code: string): Money | null {
  const c = currency(code);
  const exp = minorUnitExponent(c);
  const cleaned = text.trim().replace(/,(?=\d{3}(\D|$))/g, '');
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(cleaned);
  if (!m) return null;
  const [, sign, whole = '0', frac = ''] = m;
  if (frac.length > exp) return null;
  const minor = Number(whole) * 10 ** exp + Number(frac.padEnd(exp, '0') || '0');
  if (!Number.isSafeInteger(minor)) return null;
  return money(sign ? -minor : minor, c);
}

export function formatMoney(m: Money): string {
  const exp = minorUnitExponent(m.currency);
  const negative = m.amountMinor < 0;
  const abs = Math.abs(m.amountMinor);
  const whole = Math.floor(abs / 10 ** exp);
  const frac = exp === 0 ? '' : '.' + String(abs % 10 ** exp).padStart(exp, '0');
  return `${negative ? '-' : ''}${m.currency} ${whole.toLocaleString('en-GB')}${frac}`;
}
