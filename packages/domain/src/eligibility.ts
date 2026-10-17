import type { DuplicateResult } from './duplicates.ts';
import type { Money } from './money.ts';
import type { PolicyDocument } from './policy-schema.ts';
import type { ExpenseState } from './state-machines.ts';
import type { DecisionField, IntegrityFlag, PaymentType } from './types.ts';

/**
 * Reimbursement authorisation — the second, separate authorisation (PRD §5): clearing an expense
 * says the spend is acceptable; this decides whether money may be paid to the employee.
 *
 * BLOCKERS make a payout impossible, even for a human approver (e.g. company-card spend, duplicate,
 * unverified payee). HUMAN_REQUIRED conditions forbid *automatic* payout but allow a payment
 * approver to authorise explicitly. Auto-authorisation requires zero of both.
 */

export type EligibilityBlocker =
  | 'NOT_PERSONAL_PAYMENT'
  | 'CARD_TRANSACTION_LINKED'
  | 'EXPENSE_NOT_CLEARED'
  | 'MEMBER_INACTIVE'
  | 'PAYEE_NOT_ENROLLED'
  | 'PAYOUT_DESTINATION_UNVERIFIED'
  | 'PAYOUT_DESTINATION_NOT_CLAIMANT'
  | 'SENDER_UNVERIFIED'
  | 'DUPLICATE_CLAIM'
  | 'EVIDENCE_INTEGRITY'
  | 'UNCERTAIN_DECISION_FIELD'
  | 'INVALID_AMOUNT'
  | 'EXISTING_REIMBURSEMENT';

export type HumanRequiredReason =
  | 'AUTO_REIMBURSEMENT_DISABLED'
  | 'CLEARED_BY_HUMAN_REVIEW'
  | 'FOREIGN_CURRENCY'
  | 'ABOVE_AUTO_PAY_PER_EXPENSE'
  | 'ABOVE_AUTO_PAY_MEMBER_DAILY'
  | 'ABOVE_AUTO_PAY_MEMBER_WEEKLY'
  | 'ABOVE_MONTHLY_BUDGET';

export interface EligibilityInput {
  expense: {
    state: ExpenseState;
    paymentType: PaymentType;
    matchedTransactionId: string | null;
    amount: Money | null;
    memberId: string;
    flags: readonly IntegrityFlag[];
    uncertainFields: readonly DecisionField[];
  };
  member: { active: boolean; payoutEnrolment: 'NOT_ENROLLED' | 'PENDING' | 'VERIFIED' | 'SUSPENDED' };
  destination: { memberId: string; active: boolean; verified: boolean } | null;
  senderVerified: boolean;
  duplicates: DuplicateResult;
  hasLiveReimbursement: boolean;
  /** Reimbursements already authorised or paid (policy currency, minor units), excluding this one. */
  reimbursedBefore: { memberDay: number; memberWeek: number; organisationMonth: number };
}

export interface EligibilityResult {
  /** A payout is possible at all (possibly needing a human payment authorisation). */
  payable: boolean;
  /** Every deterministic check passed within auto-pay limits: may be authorised without a person. */
  autoAuthorise: boolean;
  blockers: EligibilityBlocker[];
  humanRequired: HumanRequiredReason[];
  limitsSnapshot: {
    currency: string;
    amountMinor: number | null;
    perExpenseMaxMinor: number;
    memberDailyMaxMinor: number;
    memberWeeklyMaxMinor: number;
    monthlyBudgetMinor: number;
    reimbursedBefore: EligibilityInput['reimbursedBefore'];
  };
}

export function evaluateReimbursementEligibility(policy: PolicyDocument, input: EligibilityInput): EligibilityResult {
  const e = input.expense;
  const autoPolicy = policy.autoReimbursement;
  const blockers: EligibilityBlocker[] = [];
  const humanRequired: HumanRequiredReason[] = [];

  if (e.paymentType !== 'PERSONAL') blockers.push('NOT_PERSONAL_PAYMENT');
  if (e.matchedTransactionId !== null) blockers.push('CARD_TRANSACTION_LINKED');
  if (e.state !== 'AUTO_CLEARED' && e.state !== 'APPROVED') blockers.push('EXPENSE_NOT_CLEARED');
  if (!input.member.active) blockers.push('MEMBER_INACTIVE');
  if (input.member.payoutEnrolment !== 'VERIFIED') blockers.push('PAYEE_NOT_ENROLLED');
  if (!input.destination || !input.destination.active || !input.destination.verified) {
    blockers.push('PAYOUT_DESTINATION_UNVERIFIED');
  } else if (input.destination.memberId !== e.memberId) {
    blockers.push('PAYOUT_DESTINATION_NOT_CLAIMANT');
  }
  if (!input.senderVerified) blockers.push('SENDER_UNVERIFIED');
  if (input.duplicates.exact.length || input.duplicates.possible.length) blockers.push('DUPLICATE_CLAIM');
  if (e.flags.length) blockers.push('EVIDENCE_INTEGRITY');
  if (e.uncertainFields.length) blockers.push('UNCERTAIN_DECISION_FIELD');
  if (!e.amount || e.amount.amountMinor <= 0) blockers.push('INVALID_AMOUNT');
  if (input.hasLiveReimbursement) blockers.push('EXISTING_REIMBURSEMENT');

  if (!autoPolicy.enabled) humanRequired.push('AUTO_REIMBURSEMENT_DISABLED');
  if (e.state === 'APPROVED') humanRequired.push('CLEARED_BY_HUMAN_REVIEW');
  if (e.amount && e.amount.currency !== policy.currency) {
    humanRequired.push('FOREIGN_CURRENCY');
  } else if (e.amount) {
    const amt = e.amount.amountMinor;
    const before = input.reimbursedBefore;
    if (amt > autoPolicy.perExpenseMaxMinor) humanRequired.push('ABOVE_AUTO_PAY_PER_EXPENSE');
    if (before.memberDay + amt > autoPolicy.memberDailyMaxMinor) humanRequired.push('ABOVE_AUTO_PAY_MEMBER_DAILY');
    if (before.memberWeek + amt > autoPolicy.memberWeeklyMaxMinor) humanRequired.push('ABOVE_AUTO_PAY_MEMBER_WEEKLY');
    if (before.organisationMonth + amt > autoPolicy.monthlyBudgetMinor) humanRequired.push('ABOVE_MONTHLY_BUDGET');
  }

  const payable = blockers.length === 0;
  return {
    payable,
    autoAuthorise: payable && humanRequired.length === 0,
    blockers,
    humanRequired,
    limitsSnapshot: {
      currency: policy.currency,
      amountMinor: e.amount?.amountMinor ?? null,
      perExpenseMaxMinor: autoPolicy.perExpenseMaxMinor,
      memberDailyMaxMinor: autoPolicy.memberDailyMaxMinor,
      memberWeeklyMaxMinor: autoPolicy.memberWeeklyMaxMinor,
      monthlyBudgetMinor: autoPolicy.monthlyBudgetMinor,
      reimbursedBefore: input.reimbursedBefore,
    },
  };
}

/** A human payment authorisation is allowed only for a payable claim, by a payment approver who is not the claimant. */
export function canHumanAuthorisePayment(
  eligibility: EligibilityResult,
  authoriser: { memberId: string; roles: readonly string[]; active: boolean },
  claimantId: string,
  reason: string,
): { allowed: true } | { allowed: false; why: string } {
  if (!eligibility.payable) return { allowed: false, why: `Not payable: ${eligibility.blockers.join(', ')}` };
  if (!authoriser.active) return { allowed: false, why: 'Authoriser account is not active' };
  if (!authoriser.roles.includes('payment_approver')) return { allowed: false, why: 'Requires the payment_approver role' };
  if (authoriser.memberId === claimantId) return { allowed: false, why: 'Claimants cannot authorise their own payment' };
  if (!reason.trim()) return { allowed: false, why: 'A reason is required' };
  return { allowed: true };
}
