import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { add, compare, formatMoney, money, MoneyError, parseDecimalToMinor, subtract } from '@swipeback/domain';

describe('money', () => {
  it('only accepts safe integer minor units and ISO currency codes', () => {
    expect(() => money(42.1, 'GBP')).toThrow(MoneyError);
    expect(() => money(Number.MAX_SAFE_INTEGER + 1, 'GBP')).toThrow(MoneyError);
    expect(() => money(100, 'gbp')).toThrow(MoneyError);
    expect(money(4210, 'GBP')).toEqual({ amountMinor: 4210, currency: 'GBP' });
  });

  it('refuses to combine different currencies', () => {
    expect(() => add(money(1, 'GBP'), money(1, 'EUR'))).toThrow(/Currency mismatch/);
    expect(() => compare(money(1, 'GBP'), money(1, 'USD'))).toThrow(/Currency mismatch/);
  });

  it.each([
    ['42.10', 'GBP', 4210],
    ['42.1', 'GBP', 4210],
    ['1,234.56', 'GBP', 123456],
    ['0.07', 'GBP', 7],
    ['-3', 'GBP', -300],
    ['1500', 'JPY', 1500],
    ['1.234', 'KWD', 1234],
  ])('parses %s %s to %d minor units without floats', (text, cur, minor) => {
    expect(parseDecimalToMinor(text, cur)).toEqual(money(minor, cur));
  });

  it.each(['42.101', '4.2.1', '£42', '42,10', '', 'abc', '1e3', '15.5 JPY'])('rejects ambiguous %j', (text) => {
    expect(parseDecimalToMinor(text, 'GBP')).toBeNull();
  });

  it('format and parse round-trip for any amount', () => {
    fc.assert(
      fc.property(fc.integer({ min: -1e12, max: 1e12 }), (minor) => {
        const formatted = formatMoney(money(minor, 'GBP')).replace('GBP ', '');
        expect(parseDecimalToMinor(formatted, 'GBP')).toEqual(money(minor, 'GBP'));
      }),
    );
  });

  it('add/subtract are exact inverses', () => {
    fc.assert(
      fc.property(fc.integer({ min: -1e12, max: 1e12 }), fc.integer({ min: -1e12, max: 1e12 }), (a, b) => {
        expect(subtract(add(money(a, 'EUR'), money(b, 'EUR')), money(b, 'EUR'))).toEqual(money(a, 'EUR'));
      }),
    );
  });
});
