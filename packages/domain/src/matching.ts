import { daysBetween, type IsoDate } from './dates.ts';
import { MERCHANT_MATCH_THRESHOLD, merchantSimilarity } from './merchant.ts';
import type { Money } from './money.ts';

/**
 * Receipt <-> card transaction reconciliation. Deterministic: amount must match exactly in minor
 * units (on the settled amount, or on the card feed's original-currency amount), the date must be
 * inside the policy window, and a card last4 printed on the receipt must agree.
 *
 * At most one transaction is ever selected. Anything short of exactly one strong candidate is
 * AMBIGUOUS (ask the employee) or NONE — never a silent guess (AC-03).
 */

export interface ReceiptForMatching {
  memberId: string;
  total: Money;
  date: IsoDate;
  merchant: string | null;
  cardLast4: string | null;
}

export interface CardTransactionCandidate {
  id: string;
  memberId: string | null;
  cardLast4: string;
  amount: Money;
  original: Money | null;
  merchantDescriptor: string;
  /** Calendar date of the transaction in the organisation's timezone. */
  date: IsoDate;
  /** Expense already linked to this transaction, if any (other than the one being matched). */
  matchedExpenseId: string | null;
}

export interface MatchWindow {
  windowBeforeDays: number;
  windowAfterDays: number;
}

export interface CandidateAssessment {
  transactionId: string;
  strength: 'STRONG' | 'WEAK';
  merchantSimilarity: number;
  dayOffset: number;
  amountBasis: 'SETTLED' | 'ORIGINAL';
}

export type MatchResult =
  | { status: 'MATCHED'; transactionId: string; assessment: CandidateAssessment }
  | { status: 'NONE' }
  | { status: 'AMBIGUOUS'; candidates: CandidateAssessment[] }
  | { status: 'CONFLICT'; transactionId: string; otherExpenseId: string };

function amountBasis(receipt: Money, txn: CardTransactionCandidate): 'SETTLED' | 'ORIGINAL' | null {
  if (txn.amount.currency === receipt.currency && txn.amount.amountMinor === receipt.amountMinor) return 'SETTLED';
  if (txn.original && txn.original.currency === receipt.currency && txn.original.amountMinor === receipt.amountMinor) {
    return 'ORIGINAL';
  }
  return null;
}

export function assessCandidate(
  receipt: ReceiptForMatching,
  txn: CardTransactionCandidate,
  window: MatchWindow,
): CandidateAssessment | null {
  if (txn.memberId !== receipt.memberId) return null;
  const basis = amountBasis(receipt.total, txn);
  if (!basis) return null;
  // Card feeds post on or after the purchase; allow a small "before" margin for timezone/receipt-date skew.
  const dayOffset = daysBetween(receipt.date, txn.date);
  if (dayOffset < -window.windowBeforeDays || dayOffset > window.windowAfterDays) return null;
  if (receipt.cardLast4 && receipt.cardLast4 !== txn.cardLast4) return null;
  const similarity = receipt.merchant ? merchantSimilarity(receipt.merchant, txn.merchantDescriptor) : 0;
  return {
    transactionId: txn.id,
    strength: similarity >= MERCHANT_MATCH_THRESHOLD ? 'STRONG' : 'WEAK',
    merchantSimilarity: Math.round(similarity * 1000) / 1000,
    dayOffset,
    amountBasis: basis,
  };
}

export function matchReceipt(
  receipt: ReceiptForMatching,
  candidates: readonly CardTransactionCandidate[],
  window: MatchWindow,
): MatchResult {
  const ordered = [...candidates].sort((a, b) => a.id.localeCompare(b.id));
  const assessed = ordered
    .map((t) => ({ t, a: assessCandidate(receipt, t, window) }))
    .filter((x): x is { t: CardTransactionCandidate; a: CandidateAssessment } => x.a !== null);

  const strong = assessed.filter((x) => x.a.strength === 'STRONG');
  if (strong.length === 1) {
    const { t, a } = strong[0]!;
    if (t.matchedExpenseId) return { status: 'CONFLICT', transactionId: t.id, otherExpenseId: t.matchedExpenseId };
    return { status: 'MATCHED', transactionId: t.id, assessment: a };
  }
  if (strong.length > 1) return { status: 'AMBIGUOUS', candidates: strong.map((x) => x.a) };
  // Same amount and date window but the merchant does not clearly agree: ask, don't guess.
  const weak = assessed.filter((x) => !x.t.matchedExpenseId);
  if (weak.length > 0) return { status: 'AMBIGUOUS', candidates: weak.map((x) => x.a) };
  return { status: 'NONE' };
}
