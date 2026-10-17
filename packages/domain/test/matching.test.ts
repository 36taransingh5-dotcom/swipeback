import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  detectDuplicates,
  matchReceipt,
  merchantSimilarity,
  money,
  normaliseMerchant,
  MERCHANT_MATCH_THRESHOLD,
  resolvePaymentType,
  type CardTransactionCandidate,
  type ReceiptForMatching,
} from '@swipeback/domain';

const WINDOW = { windowBeforeDays: 1, windowAfterDays: 5 };

const receipt = (o: Partial<ReceiptForMatching> = {}): ReceiptForMatching => ({
  memberId: 'sam',
  total: money(4210, 'GBP'),
  date: '2026-10-16',
  merchant: 'Pret A Manger (Europe) Ltd',
  cardLast4: null,
  ...o,
});

const txn = (o: Partial<CardTransactionCandidate> = {}): CardTransactionCandidate => ({
  id: 't1',
  memberId: 'sam',
  cardLast4: '4242',
  amount: money(4210, 'GBP'),
  original: null,
  merchantDescriptor: 'PRET A MANGER LONDON GB',
  date: '2026-10-17',
  matchedExpenseId: null,
  ...o,
});

describe('merchant normalisation', () => {
  it.each([
    ['PRET A MANGER LONDON GB', 'Pret A Manger (Europe) Ltd'],
    ['TRAINLINE.COM', 'Trainline'],
    ['SQ *JOES COFFEE 1234', "Joe's Coffee"],
    ['AMZN Mktp UK', 'Amazon Marketplace'],
    ['SHELL WATFORD 123', 'Shell UK Oil Products'],
    ['TFL TRAVEL CH', 'TfL Travel'],
  ])('%s ~ %s', (a, b) => {
    expect(merchantSimilarity(a, b)).toBeGreaterThanOrEqual(MERCHANT_MATCH_THRESHOLD);
  });

  it.each([
    ['PRET A MANGER LONDON GB', 'Costa Coffee'],
    ['TRAINLINE.COM', 'Uber'],
    ['SCREWFIX DIRECT', 'Toolstation'],
  ])('%s !~ %s', (a, b) => {
    expect(merchantSimilarity(a, b)).toBeLessThan(MERCHANT_MATCH_THRESHOLD);
  });

  it('is symmetric and bounded', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (a, b) => {
        const s = merchantSimilarity(a, b);
        expect(s).toBeGreaterThanOrEqual(0);
        expect(s).toBeLessThanOrEqual(1);
        expect(merchantSimilarity(b, a)).toBe(s);
      }),
    );
  });

  it('normalises noise, prefixes and punctuation', () => {
    expect(normaliseMerchant('SQ *Joe’s Coffee & Bakery Ltd 0042')).toBe('joes coffee bakery');
  });
});

describe('card matching (AC-03)', () => {
  it('matches the single strong candidate', () => {
    const r = matchReceipt(receipt(), [txn()], WINDOW);
    expect(r).toMatchObject({ status: 'MATCHED', transactionId: 't1', assessment: { strength: 'STRONG', dayOffset: 1, amountBasis: 'SETTLED' } });
  });

  it('never matches when the amount differs by a single penny', () => {
    expect(matchReceipt(receipt(), [txn({ amount: money(4211, 'GBP') })], WINDOW)).toEqual({ status: 'NONE' });
    expect(matchReceipt(receipt(), [txn({ amount: money(4209, 'GBP') })], WINDOW)).toEqual({ status: 'NONE' });
  });

  it('two equally good candidates are AMBIGUOUS, never auto-picked', () => {
    const r = matchReceipt(receipt(), [txn({ id: 't1' }), txn({ id: 't2', date: '2026-10-16' })], WINDOW);
    expect(r.status).toBe('AMBIGUOUS');
    expect(r.status === 'AMBIGUOUS' && r.candidates.map((c) => c.transactionId)).toEqual(['t1', 't2']);
  });

  it('same amount and date but an unrelated merchant is AMBIGUOUS (ask), not MATCHED', () => {
    const r = matchReceipt(receipt(), [txn({ merchantDescriptor: 'COSTA COFFEE' })], WINDOW);
    expect(r.status).toBe('AMBIGUOUS');
  });

  it('respects the date window, member and printed card last4', () => {
    expect(matchReceipt(receipt(), [txn({ date: '2026-10-22' })], WINDOW)).toEqual({ status: 'NONE' }); // +6 days
    expect(matchReceipt(receipt(), [txn({ date: '2026-10-14' })], WINDOW)).toEqual({ status: 'NONE' }); // -2 days
    expect(matchReceipt(receipt(), [txn({ memberId: 'alex' })], WINDOW)).toEqual({ status: 'NONE' });
    expect(matchReceipt(receipt({ cardLast4: '9999' }), [txn()], WINDOW)).toEqual({ status: 'NONE' });
    expect(matchReceipt(receipt({ cardLast4: '4242' }), [txn()], WINDOW).status).toBe('MATCHED');
  });

  it('matches a foreign purchase on the original-currency amount', () => {
    const r = matchReceipt(
      receipt({ total: money(5000, 'EUR'), merchant: 'Café de Flore' }),
      [txn({ amount: money(4372, 'GBP'), original: money(5000, 'EUR'), merchantDescriptor: 'CAFE DE FLORE PARIS FR' })],
      WINDOW,
    );
    expect(r).toMatchObject({ status: 'MATCHED', assessment: { amountBasis: 'ORIGINAL' } });
  });

  it('reports a CONFLICT when the only match already backs another expense', () => {
    expect(matchReceipt(receipt(), [txn({ matchedExpenseId: 'exp-other' })], WINDOW)).toEqual({
      status: 'CONFLICT',
      transactionId: 't1',
      otherExpenseId: 'exp-other',
    });
  });

  it('property: at most one transaction is ever selected, and only an exact amount + window match', () => {
    const arbTxn = fc.record({
      id: fc.uuid(),
      memberId: fc.constantFrom('sam', 'alex'),
      cardLast4: fc.constantFrom('4242', '1881'),
      amount: fc.constantFrom(4210, 4211, 999).map((n) => money(n, 'GBP')),
      original: fc.constant(null),
      merchantDescriptor: fc.constantFrom('PRET A MANGER LONDON', 'COSTA COFFEE', 'TRAINLINE'),
      date: fc.constantFrom('2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-21', '2026-10-23'),
      matchedExpenseId: fc.option(fc.constant('other'), { nil: null }),
    });
    fc.assert(
      fc.property(fc.array(arbTxn, { maxLength: 6 }), (txns) => {
        const r = matchReceipt(receipt(), txns, WINDOW);
        if (r.status === 'MATCHED') {
          const chosen = txns.filter((t) => t.id === r.transactionId);
          expect(chosen).toHaveLength(1);
          const t = chosen[0]!;
          expect(t.amount.amountMinor).toBe(4210);
          expect(t.memberId).toBe('sam');
          expect(t.matchedExpenseId).toBeNull();
          // no other strong candidate existed
          const others = txns.filter(
            (o) => o.id !== t.id && o.amount.amountMinor === 4210 && o.memberId === 'sam' && o.merchantDescriptor.startsWith('PRET') &&
              ['2026-10-15', '2026-10-16', '2026-10-17', '2026-10-21'].includes(o.date),
          );
          expect(others).toEqual([]);
        }
      }),
      { numRuns: 2000 },
    );
  });
});

describe('duplicate detection', () => {
  const subj = { expenseId: 'e1', fileHash: 'h1', merchant: 'Pret A Manger', date: '2026-10-16', total: money(4210, 'GBP'), receiptNumber: 'R-001' };

  it('flags the identical file as an exact duplicate across members and channels', () => {
    expect(detectDuplicates(subj, [{ ...subj, expenseId: 'e2', merchant: null, total: null }])).toEqual({ exact: ['e2'], possible: [] });
  });

  it('flags same merchant/date/total as a possible duplicate (re-photographed receipt)', () => {
    expect(detectDuplicates(subj, [{ ...subj, expenseId: 'e3', fileHash: 'h-other', merchant: 'PRET A MANGER LONDON' }])).toEqual({
      exact: [],
      possible: ['e3'],
    });
  });

  it('does not flag when both receipts carry different receipt numbers, or totals differ', () => {
    expect(detectDuplicates(subj, [{ ...subj, expenseId: 'e4', fileHash: 'x', receiptNumber: 'R-002' }])).toEqual({ exact: [], possible: [] });
    expect(detectDuplicates(subj, [{ ...subj, expenseId: 'e5', fileHash: 'x', total: money(4211, 'GBP') }])).toEqual({ exact: [], possible: [] });
  });

  it('ignores itself', () => {
    expect(detectDuplicates(subj, [subj])).toEqual({ exact: [], possible: [] });
  });
});

describe('payment-type resolution', () => {
  const base = {
    receiptCardLast4: null,
    receiptTender: 'UNKNOWN' as const,
    companyCardLast4s: ['4242'],
    match: null,
    statedByEmployee: null,
    minutesSinceReceived: 0,
    awaitCardFeedMinutes: 60,
  };

  it('a card match means company spend', () => {
    const r = resolvePaymentType({ ...base, match: { status: 'MATCHED', transactionId: 't', assessment: {} as never } });
    expect(r).toMatchObject({ paymentType: 'CORPORATE', basis: 'CARD_MATCH', action: 'RESOLVED', conflict: false });
  });

  it('a non-company card or cash on the receipt means personal spend', () => {
    expect(resolvePaymentType({ ...base, receiptCardLast4: '9911' })).toMatchObject({ paymentType: 'PERSONAL', action: 'RESOLVED' });
    expect(resolvePaymentType({ ...base, receiptTender: 'CASH' })).toMatchObject({ paymentType: 'PERSONAL', basis: 'CASH_ON_RECEIPT' });
  });

  it('company card on the receipt waits for the feed, then flags the missing transaction', () => {
    expect(resolvePaymentType({ ...base, receiptCardLast4: '4242', minutesSinceReceived: 10 })).toMatchObject({ action: 'WAIT', waitMinutes: 50 });
    expect(resolvePaymentType({ ...base, receiptCardLast4: '4242', minutesSinceReceived: 60 })).toMatchObject({ action: 'MISSING_TRANSACTION' });
  });

  it('no evidence: wait, then ask', () => {
    expect(resolvePaymentType({ ...base, minutesSinceReceived: 59 })).toMatchObject({ action: 'WAIT', paymentType: 'UNKNOWN' });
    expect(resolvePaymentType({ ...base, minutesSinceReceived: 60 })).toMatchObject({ action: 'ASK', paymentType: 'UNKNOWN' });
  });

  it('employee saying "personal" when a company-card transaction matches is a conflict', () => {
    const r = resolvePaymentType({ ...base, statedByEmployee: 'PERSONAL', match: { status: 'MATCHED', transactionId: 't', assessment: {} as never } });
    expect(r).toMatchObject({ paymentType: 'CORPORATE', conflict: true });
  });
});
