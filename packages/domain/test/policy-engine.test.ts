import { describe, expect, it } from 'vitest';
import {
  decideExpense,
  evaluatePolicy,
  money,
  parsePolicyDocument,
  PolicyValidationError,
  resolvePaymentType,
  SAFETY_CLAUSES,
  type PolicyEvaluationInput,
} from '@swipeback/domain';
import { DEMO_POLICY } from '@swipeback/cli/demo-policy';
import { cleanInput } from './fixtures.ts';

const decide = (input: PolicyEvaluationInput) => evaluatePolicy(DEMO_POLICY, input);

describe('policy engine — outcomes on the demo policy', () => {
  it('clears a clean in-policy expense and cites the clauses it applied', () => {
    const d = decide(cleanInput());
    expect(d.outcome).toBe('CLEAR');
    expect(d.reasonCodes).toEqual(['WITHIN_POLICY']);
    expect(d.clauseIds).toEqual(expect.arrayContaining(['NW-1', 'NW-4', 'NW-9', 'NW-13']));
    expect(d.question).toBeNull();
  });

  it.each<[string, Parameters<typeof cleanInput>[0], string, string]>([
    ['meal without a business purpose', { expense: { category: 'MEALS', amount: money(1850, 'GBP') } }, 'REQUEST_INFO', 'BUSINESS_PURPOSE_MISSING'],
    ['meal above the £35 cap', { expense: { category: 'MEALS', amount: money(3501, 'GBP'), businessPurpose: 'Site visit lunch' } }, 'HUMAN_REVIEW', 'CATEGORY_CAP_EXCEEDED'],
    ['£120.01 travel without VAT invoice', { expense: { amount: money(12001, 'GBP') } }, 'REQUEST_INFO', 'VAT_INVOICE_MISSING'],
    ['software (not claimable)', { expense: { category: 'SOFTWARE', amount: money(999, 'GBP') } }, 'REJECT_FOR_CORRECTION', 'CATEGORY_NOT_ALLOWED'],
    ['betting merchant', { expense: { category: 'OTHER', merchant: 'Lucky Bet Ltd', businessPurpose: 'x team' } }, 'REJECT_FOR_CORRECTION', 'MERCHANT_BLOCKED'],
    ['61 days old', { expense: { date: '2026-08-17' } }, 'REJECT_FOR_CORRECTION', 'EXPENSE_TOO_OLD'],
    ['EUR claim', { expense: { amount: money(4210, 'EUR') } }, 'HUMAN_REVIEW', 'FOREIGN_CURRENCY'],
    ['CHF claim', { expense: { amount: money(4210, 'CHF') } }, 'REJECT_FOR_CORRECTION', 'CURRENCY_NOT_ALLOWED'],
    ['over the daily limit', { spendBefore: { memberDay: 26000 } }, 'HUMAN_REVIEW', 'MEMBER_DAILY_CAP_EXCEEDED'],
    ['over the weekly limit', { spendBefore: { memberWeek: 76000 } }, 'HUMAN_REVIEW', 'MEMBER_WEEKLY_CAP_EXCEEDED'],
    ['uncertain amount', { expense: { uncertainFields: ['amount'] } }, 'HUMAN_REVIEW', 'UNCERTAIN_DECISION_FIELD'],
    ['missing date', { expense: { date: null } }, 'HUMAN_REVIEW', 'UNCERTAIN_DECISION_FIELD'],
    ['arithmetic mismatch', { expense: { flags: ['ARITHMETIC_MISMATCH'] } }, 'HUMAN_REVIEW', 'ARITHMETIC_MISMATCH'],
    ['prompt injection in receipt', { expense: { flags: ['INJECTION_SUSPECTED'] } }, 'HUMAN_REVIEW', 'INJECTION_SUSPECTED'],
    ['extraction failed (model outage)', { expense: { flags: ['EXTRACTION_FAILED'] } }, 'HUMAN_REVIEW', 'EXTRACTION_FAILED'],
    ['unverified sender', { senderVerified: false }, 'HUMAN_REVIEW', 'SENDER_UNVERIFIED'],
    ['exact duplicate', { duplicates: { exact: ['e1'], possible: [] } }, 'HUMAN_REVIEW', 'DUPLICATE_EXACT'],
    ['possible duplicate', { duplicates: { exact: [], possible: ['e1'] } }, 'HUMAN_REVIEW', 'DUPLICATE_POSSIBLE'],
    ['future-dated receipt', { expense: { date: '2026-10-20' } }, 'HUMAN_REVIEW', 'FUTURE_DATED'],
    ['refund / negative total', { expense: { amount: money(-500, 'GBP') } }, 'HUMAN_REVIEW', 'NON_POSITIVE_AMOUNT'],
    ['unclassified category', { expense: { category: null } }, 'HUMAN_REVIEW', 'CATEGORY_UNCLASSIFIED'],
    ['over £500', { expense: { category: 'ACCOMMODATION', amount: money(50001, 'GBP'), hasVatInvoice: true } }, 'HUMAN_REVIEW', 'ABOVE_REVIEW_THRESHOLD'],
  ])('%s -> %s (%s)', (_label, overrides, outcome, code) => {
    const d = decide(cleanInput(overrides));
    expect(d.outcome).toBe(outcome);
    expect(d.reasonCodes).toContain(code);
  });

  it('integrity beats everything: a duplicate missing its purpose goes to review, not a question', () => {
    const d = decide(cleanInput({ expense: { category: 'MEALS', amount: money(1200, 'GBP') }, duplicates: { exact: ['e9'], possible: [] } }));
    expect(d.outcome).toBe('HUMAN_REVIEW');
    expect(d.question).toBeNull();
    expect(d.reasonCodes).toEqual(['DUPLICATE_EXACT']);
  });

  it('asks exactly one question, choosing the highest-priority gap', () => {
    const d = decide(
      cleanInput({ expense: { category: 'MEALS', amount: money(1200, 'GBP'), hasReceipt: false } }),
    );
    expect(d.outcome).toBe('REQUEST_INFO');
    expect(d.question).toEqual({ kind: 'RECEIPT', reasonCode: 'RECEIPT_MISSING', clauseId: 'NW-1' });
    expect(d.findings.filter((f) => f.class === 'INFO').map((f) => f.code)).toEqual(['RECEIPT_MISSING', 'BUSINESS_PURPOSE_MISSING']);
  });

  it('never asks the same question twice: an unresolved question escalates to finance', () => {
    const d = decide(cleanInput({ expense: { category: 'MEALS', amount: money(1200, 'GBP') }, questionsAsked: ['BUSINESS_PURPOSE'] }));
    expect(d.outcome).toBe('HUMAN_REVIEW');
    expect(d.reasonCodes).toEqual(['BUSINESS_PURPOSE_MISSING', 'QUESTION_UNRESOLVED']);
    expect(d.clauseIds).toContain('SB-SAFETY-FOLLOWUP');
  });

  it('a stated purpose resolves the question under the same policy version', () => {
    const before = decide(cleanInput({ expense: { category: 'MEALS', amount: money(1200, 'GBP') } }));
    const after = decide(
      cleanInput({
        expense: { category: 'MEALS', amount: money(1200, 'GBP'), businessPurpose: 'Lunch with Acme site team during install' },
        questionsAsked: ['BUSINESS_PURPOSE'],
      }),
    );
    expect(before.outcome).toBe('REQUEST_INFO');
    expect(after.outcome).toBe('CLEAR');
    expect(after.policyContentHash).toBe(before.policyContentHash);
  });

  it('ambiguous card match asks the employee to pick, listing only the candidates', () => {
    const match = {
      status: 'AMBIGUOUS' as const,
      candidates: [
        { transactionId: 't1', strength: 'STRONG' as const, merchantSimilarity: 1, dayOffset: 0, amountBasis: 'SETTLED' as const },
        { transactionId: 't2', strength: 'STRONG' as const, merchantSimilarity: 1, dayOffset: 1, amountBasis: 'SETTLED' as const },
      ],
    };
    const d = decideExpense(DEMO_POLICY, cleanInput({ match }));
    expect(d.kind).toBe('POLICY');
    if (d.kind !== 'POLICY') return;
    expect(d.decision.question).toMatchObject({ kind: 'MATCH_CONFIRMATION', options: ['t1', 't2'] });
    expect(d.nextState).toBe('NEEDS_MATCH');
  });

  it('every cited clause exists in the policy or the built-in safety clauses', () => {
    const inputs = [
      cleanInput(),
      cleanInput({ expense: { flags: ['INJECTION_SUSPECTED', 'ARITHMETIC_MISMATCH'] } }),
      cleanInput({ senderVerified: false, duplicates: { exact: ['x'], possible: ['y'] } }),
      cleanInput({ expense: { category: 'SOFTWARE' } }),
      cleanInput({ spendBefore: { memberDay: 99999, memberWeek: 99999 } }),
    ];
    for (const input of inputs) {
      for (const f of decide(input).findings) {
        expect(f.clauseId in DEMO_POLICY.clauses || f.clauseId in SAFETY_CLAUSES, f.clauseId).toBe(true);
      }
    }
  });
});

describe('policy engine — determinism', () => {
  it('identical inputs produce byte-identical decisions', () => {
    const input = cleanInput({ expense: { category: 'MEALS', amount: money(3600, 'GBP') }, spendBefore: { memberDay: 29000 } });
    const a = JSON.stringify(decide(input));
    const b = JSON.stringify(decide(structuredClone(input)));
    expect(a).toBe(b);
  });

  it('inputs hash changes with any decision-relevant input and with the policy', () => {
    const base = decide(cleanInput());
    expect(decide(cleanInput({ expense: { amount: money(4211, 'GBP') } })).inputsHash).not.toBe(base.inputsHash);
    const stricter = parsePolicyDocument({ ...DEMO_POLICY, reviewAboveMinor: { amountMinor: 1000, clause: 'NW-13' } });
    const d = evaluatePolicy(stricter, cleanInput());
    expect(d.policyContentHash).not.toBe(base.policyContentHash);
    expect(d.inputsHash).not.toBe(base.inputsHash);
    expect(d.outcome).toBe('HUMAN_REVIEW');
  });
});

describe('decideExpense — waiting for the card feed', () => {
  const unknownPayment = (minutesSinceReceived: number) =>
    resolvePaymentType({
      receiptCardLast4: null,
      receiptTender: 'UNKNOWN',
      companyCardLast4s: ['4242'],
      match: { status: 'NONE' },
      statedByEmployee: null,
      minutesSinceReceived,
      awaitCardFeedMinutes: 4320,
    });

  it('waits in NEEDS_MATCH while the card record may still arrive', () => {
    const d = decideExpense(DEMO_POLICY, cleanInput({ payment: unknownPayment(10) }));
    expect(d).toEqual({ kind: 'AWAIT_CARD_FEED', waitMinutes: 4310, nextState: 'NEEDS_MATCH' });
  });

  it('after the wait, asks one payment-source question', () => {
    const d = decideExpense(DEMO_POLICY, cleanInput({ payment: unknownPayment(4320) }));
    expect(d.kind === 'POLICY' && d.decision.question?.kind).toBe('PAYMENT_SOURCE');
    expect(d.nextState).toBe('NEEDS_INFO');
  });

  it('never waits when evidence already requires review', () => {
    const d = decideExpense(DEMO_POLICY, cleanInput({ payment: unknownPayment(10), duplicates: { exact: ['e1'], possible: [] } }));
    expect(d.kind).toBe('POLICY');
    expect(d.nextState).toBe('REVIEW_REQUIRED');
  });

  it('company card on receipt with no card record after the wait goes to review', () => {
    const payment = resolvePaymentType({
      receiptCardLast4: '4242',
      receiptTender: 'CARD',
      companyCardLast4s: ['4242'],
      match: { status: 'NONE' },
      statedByEmployee: null,
      minutesSinceReceived: 5000,
      awaitCardFeedMinutes: 4320,
    });
    const d = decideExpense(DEMO_POLICY, cleanInput({ payment }));
    expect(d.kind === 'POLICY' && d.decision.reasonCodes).toEqual(['CARD_TRANSACTION_MISSING']);
  });
});

describe('policy document validation', () => {
  it('rejects rules that cite clauses not in the written policy', () => {
    expect(() => parsePolicyDocument({ ...DEMO_POLICY, memberLimits: { ...DEMO_POLICY.memberLimits, clause: 'NW-99' } })).toThrow(
      PolicyValidationError,
    );
  });

  it('rejects a policy missing a category rule or with negative/fractional amounts', () => {
    const { MEALS: _meals, ...rest } = DEMO_POLICY.categories;
    expect(() => parsePolicyDocument({ ...DEMO_POLICY, categories: rest })).toThrow(/categories\.MEALS/);
    expect(() => parsePolicyDocument({ ...DEMO_POLICY, reviewAboveMinor: { amountMinor: 10.5, clause: 'NW-13' } })).toThrow();
    expect(() => parsePolicyDocument({ ...DEMO_POLICY, reviewAboveMinor: { amountMinor: -1, clause: 'NW-13' } })).toThrow();
  });

  it('cannot switch off foreign-currency review', () => {
    expect(() => parsePolicyDocument({ ...DEMO_POLICY, currencies: { ...DEMO_POLICY.currencies, foreignRequiresReview: false } })).toThrow();
  });
});
