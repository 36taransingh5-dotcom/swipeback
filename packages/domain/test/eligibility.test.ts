import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  canHumanAuthorisePayment,
  CATEGORIES,
  decideExpense,
  DECISION_FIELDS,
  evaluateReimbursementEligibility,
  INTEGRITY_FLAGS,
  money,
  parsePolicyDocument,
  resolvePaymentType,
  type EligibilityInput,
  type MatchResult,
  type PolicyDocument,
  type PolicyEvaluationInput,
} from '@swipeback/domain';
import { DEMO_POLICY } from '@swipeback/cli/demo-policy';
import { AS_OF, cleanEligibility } from './fixtures.ts';

const elig = (o: Parameters<typeof cleanEligibility>[0] = {}) => evaluateReimbursementEligibility(DEMO_POLICY, cleanEligibility(o));

describe('reimbursement eligibility (AC-04, AC-05, AC-06 at unit level)', () => {
  it('a clean auto-cleared personal expense under auto-pay limits is auto-authorised', () => {
    expect(elig()).toMatchObject({ payable: true, autoAuthorise: true, blockers: [], humanRequired: [] });
  });

  it.each<[string, Parameters<typeof cleanEligibility>[0], string]>([
    ['company-card spend', { expense: { paymentType: 'CORPORATE' } }, 'NOT_PERSONAL_PAYMENT'],
    ['card-matched expense', { expense: { matchedTransactionId: 'txn-1' } }, 'CARD_TRANSACTION_LINKED'],
    ['expense still in review', { expense: { state: 'REVIEW_REQUIRED' } }, 'EXPENSE_NOT_CLEARED'],
    ['payee not enrolled', { member: { payoutEnrolment: 'PENDING' } }, 'PAYEE_NOT_ENROLLED'],
    ['no payout destination', { destination: null }, 'PAYOUT_DESTINATION_UNVERIFIED'],
    ['unverified destination', { destination: { memberId: 'member-sam', active: true, verified: false } }, 'PAYOUT_DESTINATION_UNVERIFIED'],
    ["someone else's destination", { destination: { memberId: 'member-alex', active: true, verified: true } }, 'PAYOUT_DESTINATION_NOT_CLAIMANT'],
    ['unverified sender', { senderVerified: false }, 'SENDER_UNVERIFIED'],
    ['duplicate claim', { duplicates: { exact: [], possible: ['e2'] } }, 'DUPLICATE_CLAIM'],
    ['integrity flag', { expense: { flags: ['ARITHMETIC_MISMATCH'] } }, 'EVIDENCE_INTEGRITY'],
    ['uncertain amount', { expense: { uncertainFields: ['amount'] } }, 'UNCERTAIN_DECISION_FIELD'],
    ['already reimbursed', { hasLiveReimbursement: true }, 'EXISTING_REIMBURSEMENT'],
  ])('%s is never payable, even by a human', (_label, o, blocker) => {
    const r = elig(o);
    expect(r.payable).toBe(false);
    expect(r.autoAuthorise).toBe(false);
    expect(r.blockers).toContain(blocker);
    expect(canHumanAuthorisePayment(r, { memberId: 'controller', roles: ['payment_approver'], active: true }, 'member-sam', 'ok').allowed).toBe(false);
  });

  it.each<[string, Parameters<typeof cleanEligibility>[0], string]>([
    ['above £150 per expense', { expense: { amount: money(15001, 'GBP') } }, 'ABOVE_AUTO_PAY_PER_EXPENSE'],
    ['over the daily auto-pay total', { reimbursedBefore: { memberDay: 26000 } }, 'ABOVE_AUTO_PAY_MEMBER_DAILY'],
    ['over the weekly auto-pay total', { reimbursedBefore: { memberWeek: 56000 } }, 'ABOVE_AUTO_PAY_MEMBER_WEEKLY'],
    ['over the monthly budget', { reimbursedBefore: { organisationMonth: 499000 } }, 'ABOVE_MONTHLY_BUDGET'],
    ['cleared by a reviewer', { expense: { state: 'APPROVED' } }, 'CLEARED_BY_HUMAN_REVIEW'],
    ['foreign currency', { expense: { amount: money(4210, 'EUR') } }, 'FOREIGN_CURRENCY'],
  ])('%s needs an explicit payment approver', (_label, o, reason) => {
    const r = elig(o);
    expect(r).toMatchObject({ payable: true, autoAuthorise: false });
    expect(r.humanRequired).toContain(reason);
  });

  it('a human authorisation needs the payment_approver role, a different person and a reason', () => {
    const r = elig({ expense: { amount: money(20000, 'GBP') } });
    const approver = { memberId: 'controller', roles: ['reviewer', 'payment_approver'], active: true };
    expect(canHumanAuthorisePayment(r, approver, 'member-sam', 'Verified with site manager')).toEqual({ allowed: true });
    expect(canHumanAuthorisePayment(r, { ...approver, roles: ['reviewer'] }, 'member-sam', 'x').allowed).toBe(false);
    expect(canHumanAuthorisePayment(r, { ...approver, memberId: 'member-sam' }, 'member-sam', 'x').allowed).toBe(false);
    expect(canHumanAuthorisePayment(r, approver, 'member-sam', '  ').allowed).toBe(false);
  });

  it('auto reimbursement can be switched off per organisation', () => {
    const off = parsePolicyDocument({ ...DEMO_POLICY, autoReimbursement: { ...DEMO_POLICY.autoReimbursement, enabled: false } });
    expect(evaluateReimbursementEligibility(off, cleanEligibility()).humanRequired).toEqual(['AUTO_REIMBURSEMENT_DISABLED']);
  });
});

// -----------------------------------------------------------------------------------------------
// Property: whatever happens upstream, an automatically authorised payout satisfies every control.
// -----------------------------------------------------------------------------------------------

/** Mostly the clean value, sometimes anything: keeps the property non-vacuous while still adversarial. */
function mostly<T>(clean: T, dirty: fc.Arbitrary<T>, weight = 6): fc.Arbitrary<T> {
  return fc.oneof({ weight, arbitrary: fc.constant(clean) }, { weight: 1, arbitrary: dirty });
}

const arbPolicy: fc.Arbitrary<PolicyDocument> = fc
  .record({
    cap: mostly(25000, fc.integer({ min: 0, max: 60000 }), 3),
    review: mostly(50000, fc.integer({ min: 0, max: 80000 }), 3),
    daily: mostly(30000, fc.integer({ min: 0, max: 60000 }), 3),
    weekly: mostly(80000, fc.integer({ min: 0, max: 120000 }), 3),
    autoPer: mostly(15000, fc.integer({ min: 0, max: 30000 }), 3),
    autoDay: mostly(30000, fc.integer({ min: 0, max: 60000 }), 3),
    autoWeek: mostly(60000, fc.integer({ min: 0, max: 120000 }), 3),
    budget: mostly(500000, fc.integer({ min: 0, max: 600000 }), 3),
    enabled: mostly(true, fc.boolean()),
  })
  .map((p) =>
    parsePolicyDocument({
      ...DEMO_POLICY,
      categories: Object.fromEntries(
        Object.entries(DEMO_POLICY.categories).map(([k, v]) => [k, { ...v, perExpenseCapMinor: p.cap }]),
      ),
      reviewAboveMinor: { amountMinor: p.review, clause: 'NW-13' },
      memberLimits: { dailyCapMinor: p.daily, weeklyCapMinor: p.weekly, clause: 'NW-9' },
      autoReimbursement: {
        enabled: p.enabled,
        perExpenseMaxMinor: p.autoPer,
        memberDailyMaxMinor: p.autoDay,
        memberWeeklyMaxMinor: p.autoWeek,
        monthlyBudgetMinor: p.budget,
        clause: 'NW-16',
      },
    }),
  );

const arbMatch: fc.Arbitrary<MatchResult | null> = fc.oneof(
  { weight: 3, arbitrary: fc.constant<MatchResult | null>({ status: 'NONE' }) },
  { weight: 1, arbitrary: fc.constant<MatchResult | null>(null) },
  {
    weight: 1,
    arbitrary: fc.constant<MatchResult | null>({
      status: 'MATCHED',
      transactionId: 'txn-1',
      assessment: { transactionId: 'txn-1', strength: 'STRONG', merchantSimilarity: 1, dayOffset: 0, amountBasis: 'SETTLED' },
    }),
  },
  { weight: 1, arbitrary: fc.constant<MatchResult | null>({ status: 'AMBIGUOUS', candidates: [] }) },
  { weight: 1, arbitrary: fc.constant<MatchResult | null>({ status: 'CONFLICT', transactionId: 'txn-1', otherExpenseId: 'e-other' }) },
);

const arbCase = fc.record({
  category: mostly<(typeof CATEGORIES)[number] | null>('TRAVEL', fc.option(fc.constantFrom(...CATEGORIES), { nil: null }), 2),
  amount: fc.option(
    fc.record({
      minor: fc.oneof({ weight: 4, arbitrary: fc.integer({ min: 1, max: 15000 }) }, { weight: 1, arbitrary: fc.integer({ min: -1000, max: 90000 }) }),
      currency: mostly('GBP', fc.constantFrom('GBP', 'EUR', 'CHF')),
    }),
    { nil: null, freq: 10 },
  ),
  dateOffset: mostly<number | null>(0, fc.option(fc.integer({ min: -90, max: 3 }), { nil: null })),
  merchant: mostly<string | null>('Trainline', fc.option(fc.constantFrom('Pret A Manger', 'Lucky Bet Casino', 'Screwfix'), { nil: null })),
  purpose: mostly<string | null>('Client site visit', fc.constantFrom(null, '')),
  hasReceipt: mostly(true, fc.boolean()),
  hasVat: mostly(true, fc.boolean()),
  uncertain: mostly<(typeof DECISION_FIELDS)[number][]>([], fc.subarray([...DECISION_FIELDS])),
  flags: mostly<(typeof INTEGRITY_FLAGS)[number][]>([], fc.subarray([...INTEGRITY_FLAGS])),
  senderVerified: mostly(true, fc.boolean()),
  memberActive: mostly(true, fc.boolean()),
  match: arbMatch,
  receiptCard: mostly<string | null>('9911', fc.constantFrom(null, '4242')),
  tender: mostly<'CARD' | 'CASH' | 'UNKNOWN'>('CARD', fc.constantFrom('CASH' as const, 'UNKNOWN' as const)),
  stated: mostly<'CORPORATE' | 'PERSONAL' | null>(null, fc.constantFrom('CORPORATE' as const, 'PERSONAL' as const)),
  minutes: fc.integer({ min: 0, max: 10000 }),
  dupExact: mostly(false, fc.boolean()),
  dupPossible: mostly(false, fc.boolean()),
  spendDay: mostly(0, fc.integer({ min: 0, max: 60000 }), 3),
  spendWeek: mostly(0, fc.integer({ min: 0, max: 120000 }), 3),
  enrolment: mostly<'NOT_ENROLLED' | 'PENDING' | 'VERIFIED' | 'SUSPENDED'>(
    'VERIFIED',
    fc.constantFrom('NOT_ENROLLED' as const, 'PENDING' as const, 'SUSPENDED' as const),
  ),
  destination: mostly('own-verified', fc.constantFrom('own-unverified', 'other', 'none')),
  liveReimbursement: mostly(false, fc.boolean()),
  paidDay: mostly(0, fc.integer({ min: 0, max: 60000 }), 3),
  paidWeek: mostly(0, fc.integer({ min: 0, max: 120000 }), 3),
  paidMonth: mostly(0, fc.integer({ min: 0, max: 600000 }), 3),
});

function addDaysIso(d: string, n: number): string {
  return new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

describe('property: clearing + payout authorisation never lets an ineligible claim through', () => {
  it('10,000 random cases: auto-authorised => every control holds', () => {
    let autoAuthorised = 0;
    fc.assert(
      fc.property(arbPolicy, arbCase, (policy, c) => {
        const amount = c.amount ? money(c.amount.minor, c.amount.currency) : null;
        const payment = resolvePaymentType({
          receiptCardLast4: c.receiptCard,
          receiptTender: c.tender,
          companyCardLast4s: ['4242'],
          match: c.match,
          statedByEmployee: c.stated,
          minutesSinceReceived: c.minutes,
          awaitCardFeedMinutes: policy.matching.awaitCardFeedMinutes,
        });
        const input: PolicyEvaluationInput = {
          asOf: AS_OF,
          expense: {
            category: c.category,
            amount,
            date: c.dateOffset === null ? null : addDaysIso(AS_OF, c.dateOffset),
            merchant: c.merchant,
            businessPurpose: c.purpose,
            hasReceipt: c.hasReceipt,
            hasVatInvoice: c.hasVat,
            uncertainFields: c.uncertain,
            flags: c.flags,
          },
          senderVerified: c.senderVerified,
          memberActive: c.memberActive,
          match: c.match,
          payment,
          duplicates: { exact: c.dupExact ? ['d1'] : [], possible: c.dupPossible ? ['d2'] : [] },
          questionsAsked: [],
          spendBefore: { memberDay: c.spendDay, memberWeek: c.spendWeek, categoryMonth: 0 },
        };
        const decision = decideExpense(policy, input);
        if (decision.nextState !== 'AUTO_CLEARED') return;

        const eligibilityInput: EligibilityInput = {
          expense: {
            state: 'AUTO_CLEARED',
            paymentType: payment.paymentType,
            matchedTransactionId: c.match?.status === 'MATCHED' ? c.match.transactionId : null,
            amount,
            memberId: 'sam',
            flags: c.flags,
            uncertainFields: c.uncertain,
          },
          member: { active: c.memberActive, payoutEnrolment: c.enrolment },
          destination:
            c.destination === 'none'
              ? null
              : { memberId: c.destination === 'other' ? 'alex' : 'sam', active: true, verified: c.destination !== 'own-unverified' },
          senderVerified: c.senderVerified,
          duplicates: input.duplicates,
          hasLiveReimbursement: c.liveReimbursement,
          reimbursedBefore: { memberDay: c.paidDay, memberWeek: c.paidWeek, organisationMonth: c.paidMonth },
        };
        const e = evaluateReimbursementEligibility(policy, eligibilityInput);
        if (!e.autoAuthorise) return;
        autoAuthorised++;

        // --- every control from PRD §5 must hold ---
        expect(payment.paymentType).toBe('PERSONAL');
        expect(eligibilityInput.expense.matchedTransactionId).toBeNull();
        expect(amount).not.toBeNull();
        expect(amount!.currency).toBe(policy.currency);
        expect(amount!.amountMinor).toBeGreaterThan(0);
        expect(amount!.amountMinor).toBeLessThanOrEqual(policy.autoReimbursement.perExpenseMaxMinor);
        expect(amount!.amountMinor).toBeLessThanOrEqual(policy.reviewAboveMinor.amountMinor);
        expect(amount!.amountMinor).toBeLessThanOrEqual(policy.categories[c.category!].perExpenseCapMinor ?? Infinity);
        expect(c.spendDay + amount!.amountMinor).toBeLessThanOrEqual(policy.memberLimits.dailyCapMinor);
        expect(c.spendWeek + amount!.amountMinor).toBeLessThanOrEqual(policy.memberLimits.weeklyCapMinor);
        expect(c.paidDay + amount!.amountMinor).toBeLessThanOrEqual(policy.autoReimbursement.memberDailyMaxMinor);
        expect(c.paidWeek + amount!.amountMinor).toBeLessThanOrEqual(policy.autoReimbursement.memberWeeklyMaxMinor);
        expect(c.paidMonth + amount!.amountMinor).toBeLessThanOrEqual(policy.autoReimbursement.monthlyBudgetMinor);
        expect(policy.autoReimbursement.enabled).toBe(true);
        expect(c.senderVerified && c.memberActive).toBe(true);
        expect(c.enrolment).toBe('VERIFIED');
        expect(c.destination).toBe('own-verified');
        expect(c.dupExact || c.dupPossible || c.liveReimbursement).toBe(false);
        expect(c.flags).toEqual([]);
        expect(c.uncertain).toEqual([]);
        expect(c.hasReceipt).toBe(true);
        expect(c.merchant).not.toBe('Lucky Bet Casino');
        expect(c.category).not.toBe('SOFTWARE');
      }),
      { numRuns: 10_000, seed: 20261017 },
    );
    // Guard against a vacuous property: the generator must actually reach auto-authorisation.
    expect(autoAuthorised).toBeGreaterThan(200);
  });
});
