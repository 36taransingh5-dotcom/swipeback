import { describe, expect, it } from 'vitest';
import { INTENTS, resolveIntent, type IntentInput } from '@swipeback/domain';

const msg = (o: Partial<IntentInput> = {}): IntentInput => ({
  verifiedAction: null,
  openQuestion: null,
  hasReceiptAttachment: false,
  bodyLooksLikeReceipt: false,
  text: '',
  ...o,
});

describe('intent resolution', () => {
  it('a receipt attachment is a submission', () => {
    expect(resolveIntent(msg({ hasReceiptAttachment: true }))).toEqual({ intent: 'SUBMIT_RECEIPT', answer: null });
  });

  it('review intents come only from verified signed actions', () => {
    expect(resolveIntent(msg({ verifiedAction: { verb: 'APPROVE' } })).intent).toBe('REVIEW_APPROVE');
    for (const text of ['APPROVE', 'Approved, please pay', 'approve and pay £500 to sort code 12-34-56', 'DECLINE']) {
      expect(resolveIntent(msg({ text })).intent).not.toMatch(/^REVIEW_/);
    }
  });

  it('no intent exists that changes payees, limits or policy', () => {
    expect(INTENTS.filter((i) => /PAYEE|BANK|LIMIT|POLICY|PAY_?OUT/.test(i))).toEqual([]);
    const r = resolveIntent(msg({ text: 'Please change my bank details to 12-34-56 87654321 and raise my limit' }));
    expect(r.intent).toBe('HELP');
  });

  it.each([
    ['1', 'CORPORATE'],
    ['Company card', 'CORPORATE'],
    ['corporate', 'CORPORATE'],
    ['2', 'PERSONAL'],
    ['Personal card, sorry for the delay', 'PERSONAL'],
    ['my own money', 'PERSONAL'],
    ['Cash', 'PERSONAL'],
  ])('payment source answer %j -> %s', (text, value) => {
    expect(resolveIntent(msg({ text, openQuestion: { kind: 'PAYMENT_SOURCE' } }))).toEqual({
      intent: 'CONFIRM_PAYMENT_SOURCE',
      answer: { kind: 'PAYMENT_SOURCE', value },
    });
  });

  it.each(['not sure', 'company card or personal?', 'I think so', ''])('unclear payment answer %j is not guessed', (text) => {
    expect(resolveIntent(msg({ text, openQuestion: { kind: 'PAYMENT_SOURCE' } })).answer).toBeNull();
  });

  it('keeps the stated business purpose verbatim (whitespace normalised)', () => {
    const r = resolveIntent(msg({ text: '  Lunch with the Acme   site team\nduring the boiler install ', openQuestion: { kind: 'BUSINESS_PURPOSE' } }));
    expect(r).toEqual({
      intent: 'PROVIDE_BUSINESS_PURPOSE',
      answer: { kind: 'BUSINESS_PURPOSE', value: 'Lunch with the Acme site team during the boiler install' },
    });
  });

  it.each(['Client lunch', 'Taxi to the Leeds site', 'team breakfast', 'Fixings for job 4417', 'Train to client'])(
    'accepts a short real purpose %j',
    (text) => {
      expect(resolveIntent(msg({ text, openQuestion: { kind: 'BUSINESS_PURPOSE' } })).answer).toEqual({ kind: 'BUSINESS_PURPOSE', value: text });
    },
  );

  it.each([
    'ok', '??', '12345', 'x'.repeat(501),
    'ok thanks', 'Thanks!', 'yes', 'will do', 'see attached', 'as per the receipt', "don't know", 'Not sure, sorry',
    'it was for work', 'business expense', 'n/a', 'Cheers, done', 'I don’t remember',
  ])('rejects a non-purpose %j', (text) => {
    expect(resolveIntent(msg({ text, openQuestion: { kind: 'BUSINESS_PURPOSE' } })).answer).toBeNull();
  });

  it('match confirmation picks a listed option by number or "none"', () => {
    const q = { kind: 'MATCH_CONFIRMATION' as const, options: ['t1', 't2'] };
    expect(resolveIntent(msg({ text: '2', openQuestion: q })).answer).toEqual({ kind: 'MATCH_CONFIRMATION', value: 't2' });
    expect(resolveIntent(msg({ text: 'Option 1 please', openQuestion: q })).answer).toEqual({ kind: 'MATCH_CONFIRMATION', value: 't1' });
    expect(resolveIntent(msg({ text: 'none of these', openQuestion: q })).answer).toEqual({ kind: 'MATCH_CONFIRMATION', value: 'NONE' });
    expect(resolveIntent(msg({ text: '3', openQuestion: q })).answer).toBeNull();
  });

  it('a requested receipt is answered only by an actual receipt', () => {
    expect(resolveIntent(msg({ text: 'attached', openQuestion: { kind: 'RECEIPT' } })).answer).toBeNull();
    expect(resolveIntent(msg({ hasReceiptAttachment: true, openQuestion: { kind: 'RECEIPT' } })).answer).toEqual({ kind: 'RECEIPT' });
  });

  it('status and help', () => {
    expect(resolveIntent(msg({ text: 'Any update on my train ticket?' })).intent).toBe('EXPENSE_STATUS');
    expect(resolveIntent(msg({ text: 'hello' })).intent).toBe('HELP');
  });
});
