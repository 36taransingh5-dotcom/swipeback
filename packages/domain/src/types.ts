export const CATEGORIES = [
  'MEALS',
  'CLIENT_ENTERTAINMENT',
  'TRAVEL',
  'ACCOMMODATION',
  'FUEL',
  'TOOLS_EQUIPMENT',
  'OFFICE_SUPPLIES',
  'SOFTWARE',
  'OTHER',
] as const;
export type Category = (typeof CATEGORIES)[number];

export type PaymentType = 'UNKNOWN' | 'CORPORATE' | 'PERSONAL';

/** Fields whose uncertainty blocks automatic clearance and payout. */
export const DECISION_FIELDS = ['amount', 'currency', 'date', 'merchant'] as const;
export type DecisionField = (typeof DECISION_FIELDS)[number];

/**
 * Evidence-integrity flags raised by extraction and evidence checks. Any of these fails closed
 * into human review. Labelled as inconsistencies, never as fraud.
 */
export const INTEGRITY_FLAGS = [
  'EXTRACTION_FAILED',
  'ARITHMETIC_MISMATCH',
  'EVIDENCE_INCONSISTENCY',
  'INJECTION_SUSPECTED',
  'MALFORMED_ATTACHMENT',
  /** The receipt sent for a card transaction does not match it (amount, date, merchant or card). */
  'RECEIPT_TRANSACTION_MISMATCH',
] as const;
export type IntegrityFlag = (typeof INTEGRITY_FLAGS)[number];

/** REVIEWER_QUESTION is asked by a finance reviewer (free text); the others are chosen by the policy engine. */
export const QUESTION_KINDS = ['PAYMENT_SOURCE', 'MATCH_CONFIRMATION', 'RECEIPT', 'BUSINESS_PURPOSE', 'VAT_INVOICE', 'REVIEWER_QUESTION'] as const;
export type QuestionKind = (typeof QUESTION_KINDS)[number];

export const ENGINE_VERSION = 'swipeback-engine/1.0.0';
