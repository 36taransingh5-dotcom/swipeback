import type { IsoDate } from './dates.ts';
import { merchantSimilarity } from './merchant.ts';
import type { Money } from './money.ts';

/**
 * Duplicate detection across all channels and members.
 * - EXACT: the same file (sha256) was already submitted.
 * - POSSIBLE: same merchant, date and total, unless both receipts carry different receipt numbers.
 * Both route to human review; Swipeback reports an evidence inconsistency, never "fraud".
 */

export interface DuplicateSubject {
  expenseId: string;
  fileHash: string | null;
  merchant: string | null;
  date: IsoDate | null;
  total: Money | null;
  receiptNumber: string | null;
}

export interface DuplicateResult {
  exact: string[];
  possible: string[];
}

const SAME_MERCHANT_THRESHOLD = 0.75;

function normaliseReceiptNumber(n: string | null): string | null {
  const s = n?.replace(/[^a-z0-9]/gi, '').toUpperCase();
  return s ? s : null;
}

export function detectDuplicates(subject: DuplicateSubject, others: readonly DuplicateSubject[]): DuplicateResult {
  const exact = new Set<string>();
  const possible = new Set<string>();
  const subjectNo = normaliseReceiptNumber(subject.receiptNumber);

  for (const o of others) {
    if (o.expenseId === subject.expenseId) continue;
    if (subject.fileHash && o.fileHash === subject.fileHash) {
      exact.add(o.expenseId);
      continue;
    }
    if (!subject.total || !o.total || !subject.date || !o.date || !subject.merchant || !o.merchant) continue;
    if (subject.total.currency !== o.total.currency || subject.total.amountMinor !== o.total.amountMinor) continue;
    if (subject.date !== o.date) continue;
    if (merchantSimilarity(subject.merchant, o.merchant) < SAME_MERCHANT_THRESHOLD) continue;
    const otherNo = normaliseReceiptNumber(o.receiptNumber);
    if (subjectNo && otherNo && subjectNo !== otherNo) continue;
    possible.add(o.expenseId);
  }
  return { exact: [...exact].sort(), possible: [...possible].sort() };
}

export const NO_DUPLICATES: DuplicateResult = { exact: [], possible: [] };
