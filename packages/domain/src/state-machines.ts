/**
 * Allowed state transitions. This module is the single source of truth: the database migrator
 * copies these tables into `state_transitions`, and a Postgres trigger rejects any state change
 * not listed here, so a bug in application code cannot skip a step (e.g. RECEIVED -> SIMULATED_PAID).
 */

export const EXPENSE_STATES = [
  'RECEIVED',
  'EXTRACTING',
  'NEEDS_MATCH',
  'NEEDS_INFO',
  'POLICY_CHECK',
  'AUTO_CLEARED',
  'REVIEW_REQUIRED',
  'APPROVED',
  'REJECTED',
  'EXPORTED',
  /** A receipt-led record absorbed into the card-led expense for the same transaction (no duplicate). */
  'MERGED',
] as const;
export type ExpenseState = (typeof EXPENSE_STATES)[number];

export const REIMBURSEMENT_STATES = [
  'DRAFT',
  'ELIGIBILITY_CHECK',
  'AUTHORIZED',
  'PAYOUT_QUEUED',
  'SIMULATED_PAID',
  'FAILED',
  'CANCELED',
] as const;
export type ReimbursementState = (typeof REIMBURSEMENT_STATES)[number];

export interface StateMachine<S extends string> {
  readonly name: string;
  readonly states: readonly S[];
  readonly initial: S;
  readonly terminal: readonly S[];
  readonly transitions: readonly (readonly [from: S, to: S])[];
}

export const EXPENSE_MACHINE: StateMachine<ExpenseState> = {
  name: 'expense',
  states: EXPENSE_STATES,
  initial: 'RECEIVED',
  terminal: ['EXPORTED', 'MERGED'],
  transitions: [
    ['RECEIVED', 'EXTRACTING'],
    // Card-led expense: created from a card transaction, waiting for its receipt.
    ['RECEIVED', 'NEEDS_MATCH'],
    // Extraction outcomes. Every failure goes to review; there is no failure edge into AUTO_CLEARED.
    ['EXTRACTING', 'NEEDS_MATCH'],
    ['EXTRACTING', 'NEEDS_INFO'],
    ['EXTRACTING', 'POLICY_CHECK'],
    ['EXTRACTING', 'REVIEW_REQUIRED'],
    // Waiting states resume only through new evidence.
    ['NEEDS_MATCH', 'POLICY_CHECK'],
    ['NEEDS_MATCH', 'NEEDS_INFO'],
    ['NEEDS_MATCH', 'REVIEW_REQUIRED'],
    ['NEEDS_INFO', 'POLICY_CHECK'],
    ['NEEDS_INFO', 'NEEDS_MATCH'],
    ['NEEDS_INFO', 'EXTRACTING'],
    ['NEEDS_INFO', 'REVIEW_REQUIRED'],
    // Policy outcomes: CLEAR / REQUEST_INFO / HUMAN_REVIEW / REJECT_FOR_CORRECTION.
    ['POLICY_CHECK', 'AUTO_CLEARED'],
    ['POLICY_CHECK', 'NEEDS_INFO'],
    ['POLICY_CHECK', 'NEEDS_MATCH'],
    ['POLICY_CHECK', 'REVIEW_REQUIRED'],
    ['POLICY_CHECK', 'REJECTED'],
    // Reviewer actions: APPROVE / DECLINE / REQUEST_INFO / CORRECT (re-evaluate).
    ['REVIEW_REQUIRED', 'APPROVED'],
    ['REVIEW_REQUIRED', 'REJECTED'],
    ['REVIEW_REQUIRED', 'NEEDS_INFO'],
    ['REVIEW_REQUIRED', 'POLICY_CHECK'],
    // Late conflicts (e.g. duplicate discovered, card match on a cleared expense) reopen review.
    ['AUTO_CLEARED', 'EXPORTED'],
    ['AUTO_CLEARED', 'REVIEW_REQUIRED'],
    ['APPROVED', 'EXPORTED'],
    ['APPROVED', 'REVIEW_REQUIRED'],
    // Correction (new receipt) or appeal.
    ['REJECTED', 'EXTRACTING'],
    ['REJECTED', 'REVIEW_REQUIRED'],
    // A separately emailed receipt that belongs to a waiting card-led expense is merged into it.
    ['EXTRACTING', 'MERGED'],
    ['POLICY_CHECK', 'MERGED'],
    ['NEEDS_MATCH', 'MERGED'],
    ['NEEDS_INFO', 'MERGED'],
  ],
};

export const REIMBURSEMENT_MACHINE: StateMachine<ReimbursementState> = {
  name: 'reimbursement',
  states: REIMBURSEMENT_STATES,
  initial: 'DRAFT',
  terminal: ['SIMULATED_PAID', 'CANCELED'],
  transitions: [
    ['DRAFT', 'ELIGIBILITY_CHECK'],
    ['DRAFT', 'CANCELED'],
    // Stays in ELIGIBILITY_CHECK while awaiting a human payment authorisation.
    ['ELIGIBILITY_CHECK', 'AUTHORIZED'],
    ['ELIGIBILITY_CHECK', 'CANCELED'],
    ['AUTHORIZED', 'PAYOUT_QUEUED'],
    ['AUTHORIZED', 'CANCELED'],
    ['PAYOUT_QUEUED', 'SIMULATED_PAID'],
    ['PAYOUT_QUEUED', 'FAILED'],
    // Safe retry keeps the same idempotency key.
    ['FAILED', 'PAYOUT_QUEUED'],
    ['FAILED', 'CANCELED'],
  ],
};

export const STATE_MACHINES = [EXPENSE_MACHINE, REIMBURSEMENT_MACHINE] as const;

export function canTransition<S extends string>(machine: StateMachine<S>, from: S, to: S): boolean {
  return machine.transitions.some(([f, t]) => f === from && t === to);
}

export class IllegalTransitionError extends Error {
  override readonly name = 'IllegalTransitionError';
  constructor(
    readonly machine: string,
    readonly from: string,
    readonly to: string,
  ) {
    super(`Illegal ${machine} transition ${from} -> ${to}`);
  }
}

export function assertTransition<S extends string>(machine: StateMachine<S>, from: S, to: S): void {
  if (!canTransition(machine, from, to)) throw new IllegalTransitionError(machine.name, from, to);
}
