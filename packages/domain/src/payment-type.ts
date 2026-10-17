import type { MatchResult } from './matching.ts';
import type { PaymentType } from './types.ts';

/**
 * Was this purchase made on a company card (already paid: clear, never reimburse) or personally
 * (eligible for reimbursement)? Evidence is weighed deterministically; when it is missing we first
 * wait for the card feed (which lags), then ask the employee one question.
 */

export interface PaymentEvidence {
  /** Card last4 printed on the receipt, if any. */
  receiptCardLast4: string | null;
  /** 'CASH' when the receipt states cash payment. */
  receiptTender: 'CARD' | 'CASH' | 'UNKNOWN';
  /** Active company card last4s for the organisation. */
  companyCardLast4s: readonly string[];
  match: MatchResult | null;
  /** The employee's answer to a PAYMENT_SOURCE question, if given. */
  statedByEmployee: 'CORPORATE' | 'PERSONAL' | null;
  /** Minutes since the receipt arrived, and how long policy waits for the card feed. */
  minutesSinceReceived: number;
  awaitCardFeedMinutes: number;
}

export type PaymentBasis =
  | 'CARD_MATCH'
  | 'COMPANY_CARD_ON_RECEIPT'
  | 'NON_COMPANY_CARD_ON_RECEIPT'
  | 'CASH_ON_RECEIPT'
  | 'EMPLOYEE_STATED'
  | 'NONE';

export interface PaymentResolution {
  paymentType: PaymentType;
  basis: PaymentBasis;
  /** RESOLVED; WAIT for card feed; ASK the employee; MISSING_TRANSACTION = company card but no feed record. */
  action: 'RESOLVED' | 'WAIT' | 'ASK' | 'MISSING_TRANSACTION';
  /** Evidence disagrees (e.g. employee says personal but a company card transaction matches). */
  conflict: boolean;
  /** Minutes left to wait for the card feed when action = WAIT. */
  waitMinutes?: number;
}

export function resolvePaymentType(e: PaymentEvidence): PaymentResolution {
  const onCompanyCard = e.receiptCardLast4 !== null && e.companyCardLast4s.includes(e.receiptCardLast4);
  const remaining = Math.max(0, e.awaitCardFeedMinutes - e.minutesSinceReceived);

  if (e.match?.status === 'MATCHED') {
    return {
      paymentType: 'CORPORATE',
      basis: 'CARD_MATCH',
      action: 'RESOLVED',
      conflict: e.statedByEmployee === 'PERSONAL' || e.receiptTender === 'CASH',
    };
  }
  if (onCompanyCard) {
    const conflict = e.statedByEmployee === 'PERSONAL';
    if (remaining > 0) return { paymentType: 'CORPORATE', basis: 'COMPANY_CARD_ON_RECEIPT', action: 'WAIT', conflict, waitMinutes: remaining };
    return { paymentType: 'CORPORATE', basis: 'COMPANY_CARD_ON_RECEIPT', action: 'MISSING_TRANSACTION', conflict };
  }
  if (e.statedByEmployee) {
    // A stated "company card" with no feed record after the wait is treated like a missing transaction.
    if (e.statedByEmployee === 'CORPORATE') {
      return remaining > 0
        ? { paymentType: 'CORPORATE', basis: 'EMPLOYEE_STATED', action: 'WAIT', conflict: false, waitMinutes: remaining }
        : { paymentType: 'CORPORATE', basis: 'EMPLOYEE_STATED', action: 'MISSING_TRANSACTION', conflict: false };
    }
    return { paymentType: 'PERSONAL', basis: 'EMPLOYEE_STATED', action: 'RESOLVED', conflict: false };
  }
  if (e.receiptCardLast4 !== null) {
    return { paymentType: 'PERSONAL', basis: 'NON_COMPANY_CARD_ON_RECEIPT', action: 'RESOLVED', conflict: false };
  }
  if (e.receiptTender === 'CASH') {
    return { paymentType: 'PERSONAL', basis: 'CASH_ON_RECEIPT', action: 'RESOLVED', conflict: false };
  }
  if (remaining > 0) return { paymentType: 'UNKNOWN', basis: 'NONE', action: 'WAIT', conflict: false, waitMinutes: remaining };
  return { paymentType: 'UNKNOWN', basis: 'NONE', action: 'ASK', conflict: false };
}
