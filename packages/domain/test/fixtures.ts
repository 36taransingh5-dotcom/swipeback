import {
  money,
  NO_DUPLICATES,
  resolvePaymentType,
  type EligibilityInput,
  type PolicyEvaluationInput,
} from '@swipeback/domain';

export const AS_OF = '2026-10-17';

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? Partial<T[K]> : T[K] };

/** A clean, in-policy, personally paid £42.10 train ticket bought today. */
export function cleanInput(overrides: DeepPartial<PolicyEvaluationInput> = {}): PolicyEvaluationInput {
  const base: PolicyEvaluationInput = {
    asOf: AS_OF,
    expense: {
      category: 'TRAVEL',
      amount: money(4210, 'GBP'),
      date: AS_OF,
      merchant: 'Trainline',
      businessPurpose: null,
      hasReceipt: true,
      hasVatInvoice: false,
      uncertainFields: [],
      flags: [],
    },
    senderVerified: true,
    memberActive: true,
    match: { status: 'NONE' },
    payment: resolvePaymentType({
      receiptCardLast4: '9911',
      receiptTender: 'CARD',
      companyCardLast4s: ['4242', '1881'],
      match: { status: 'NONE' },
      statedByEmployee: null,
      minutesSinceReceived: 0,
      awaitCardFeedMinutes: 4320,
    }),
    duplicates: NO_DUPLICATES,
    questionsAsked: [],
    spendBefore: { memberDay: 0, memberWeek: 0, categoryMonth: 0 },
  };
  return {
    ...base,
    ...overrides,
    expense: { ...base.expense, ...(overrides.expense ?? {}) },
    spendBefore: { ...base.spendBefore, ...(overrides.spendBefore ?? {}) },
  } as PolicyEvaluationInput;
}

/** An auto-cleared personal expense with a verified payee and nothing paid before. */
export function cleanEligibility(overrides: DeepPartial<EligibilityInput> = {}): EligibilityInput {
  const base: EligibilityInput = {
    expense: {
      state: 'AUTO_CLEARED',
      paymentType: 'PERSONAL',
      matchedTransactionId: null,
      amount: money(4210, 'GBP'),
      memberId: 'member-sam',
      flags: [],
      uncertainFields: [],
    },
    member: { active: true, payoutEnrolment: 'VERIFIED' },
    destination: { memberId: 'member-sam', active: true, verified: true },
    senderVerified: true,
    duplicates: NO_DUPLICATES,
    hasLiveReimbursement: false,
    reimbursedBefore: { memberDay: 0, memberWeek: 0, organisationMonth: 0 },
  };
  return {
    ...base,
    ...overrides,
    expense: { ...base.expense, ...(overrides.expense ?? {}) },
    member: { ...base.member, ...(overrides.member ?? {}) },
    reimbursedBefore: { ...base.reimbursedBefore, ...(overrides.reimbursedBefore ?? {}) },
  } as EligibilityInput;
}
