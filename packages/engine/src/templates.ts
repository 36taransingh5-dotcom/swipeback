import { formatMoney, money, SAFETY_CLAUSES, type PolicyDocument, type QuestionKind, type ReasonCode } from '@swipeback/domain';

/**
 * Outbound wording. Messages carry the minimum: expense reference, merchant, amount, status and
 * the policy clause applied. Receipts and payee details stay behind authenticated access.
 */

export const FOOTER = '—\nSwipeback · SYNTHETIC DEMO — simulated payouts only, no real money moves.';

export interface ExpenseSummary {
  ref: string;
  merchant: string | null;
  amountMinor: number | null;
  currency: string | null;
  date: string | null;
}

export function describe(e: ExpenseSummary): string {
  const amount = e.amountMinor !== null && e.currency ? formatMoney(money(e.amountMinor, e.currency)) : 'amount unknown';
  return `${e.ref} — ${e.merchant ?? 'unknown merchant'}, ${amount}${e.date ? ` on ${e.date}` : ''}`;
}

const REASON_TEXT: Partial<Record<ReasonCode, string>> = {
  EXTRACTION_FAILED: 'we could not read the receipt reliably',
  UNCERTAIN_DECISION_FIELD: 'some receipt details (amount, date or merchant) are unclear',
  ARITHMETIC_MISMATCH: 'the receipt figures do not add up',
  EVIDENCE_INCONSISTENCY: 'the evidence is inconsistent',
  INJECTION_SUSPECTED: 'the message contains instructions that Swipeback does not act on',
  MALFORMED_ATTACHMENT: 'an attachment could not be opened safely',
  SENDER_UNVERIFIED: 'the sender could not be verified',
  MEMBER_INACTIVE: 'the employee account is not active',
  DUPLICATE_EXACT: 'this receipt was already submitted',
  DUPLICATE_POSSIBLE: 'it looks similar to another claim',
  MATCH_CONFLICT: 'the card transaction is already linked to another expense',
  PAYMENT_SOURCE_CONFLICT: 'the payment details disagree with the card records',
  CARD_TRANSACTION_MISSING: 'no matching company-card transaction has arrived',
  FUTURE_DATED: 'the receipt date is in the future',
  NON_POSITIVE_AMOUNT: 'the total is zero or negative',
  QUESTION_UNRESOLVED: 'an earlier question is still unresolved',
  CATEGORY_NOT_ALLOWED: 'this type of expense is not claimable',
  MERCHANT_BLOCKED: 'this merchant is not claimable',
  EXPENSE_TOO_OLD: 'it is outside the claim window',
  CURRENCY_NOT_ALLOWED: 'the currency is not accepted',
  CATEGORY_UNCLASSIFIED: 'the expense type could not be determined',
  FOREIGN_CURRENCY: 'it is in a foreign currency',
  CATEGORY_CAP_EXCEEDED: 'it is above the limit for this type of expense',
  CATEGORY_MONTHLY_CAP_EXCEEDED: 'it exceeds the monthly limit for this type of expense',
  ABOVE_REVIEW_THRESHOLD: 'it is above the amount that needs finance approval',
  MEMBER_DAILY_CAP_EXCEEDED: 'it exceeds the daily spending limit',
  MEMBER_WEEKLY_CAP_EXCEEDED: 'it exceeds the weekly spending limit',
};

export function reasonText(code: string): string {
  return REASON_TEXT[code as ReasonCode] ?? code.toLowerCase().replace(/_/g, ' ');
}

export function clauseText(policy: PolicyDocument, clauseId: string): string {
  const c = policy.clauses[clauseId];
  if (c) return `Policy ${clauseId} (${c.title}): ${c.text}`;
  const s = SAFETY_CLAUSES[clauseId as keyof typeof SAFETY_CLAUSES];
  return s ? `Swipeback control ${clauseId}: ${s}` : clauseId;
}

export interface Rendered {
  subject: string;
  text: string;
}

const subjectFor = (e: ExpenseSummary, status: string) => `[${e.ref}] ${status}`;

export function clearedCardMessage(e: ExpenseSummary, transaction: { descriptor: string; date: string }): Rendered {
  return {
    subject: subjectFor(e, 'Matched and cleared'),
    text: `${describe(e)}\n\nMatched to your company-card transaction "${transaction.descriptor}" (${transaction.date}) and cleared under policy. Nothing else is needed from you. Company-card spend is never reimbursed.\n\n${FOOTER}`,
  };
}

export function paidMessage(e: ExpenseSummary, payoutRef: string): Rendered {
  return {
    subject: subjectFor(e, 'Reimbursed (simulated)'),
    text: `${describe(e)}\n\nCleared under policy and reimbursed to your enrolled account.\nSimulated payout reference: ${payoutRef}\n\n${FOOTER}`,
  };
}

export function awaitingPaymentAuthorisationMessage(e: ExpenseSummary): Rendered {
  return {
    subject: subjectFor(e, 'Cleared — payment awaiting finance'),
    text: `${describe(e)}\n\nYour expense is cleared. The reimbursement is above the automatic payment limits, so a payment approver will authorise it. You don't need to do anything.\n\n${FOOTER}`,
  };
}

export function underReviewMessage(e: ExpenseSummary, reasons: readonly string[]): Rendered {
  return {
    subject: subjectFor(e, 'With finance for review'),
    text: `${describe(e)}\n\nWe've passed this to finance because ${listReasons(reasons)}. You don't need to do anything unless finance contacts you.\n\n${FOOTER}`,
  };
}

export function rejectedMessage(e: ExpenseSummary, reasons: readonly string[], clauses: readonly string[]): Rendered {
  return {
    subject: subjectFor(e, 'Not claimable as submitted'),
    text: `${describe(e)}\n\nThis can't be claimed as submitted because ${listReasons(reasons)}.\n${clauses.map((c) => `• ${c}`).join('\n')}\n\nIf this is wrong, reply with a corrected receipt or an explanation and finance will look at it.\n\n${FOOTER}`,
  };
}

export function duplicateReceivedMessage(e: ExpenseSummary, state: string): Rendered {
  return {
    subject: subjectFor(e, 'Already received'),
    text: `We already have this receipt as ${describe(e)} (status: ${state.toLowerCase().replace(/_/g, ' ')}). No new claim was created.\n\n${FOOTER}`,
  };
}

export function questionMessage(
  e: ExpenseSummary,
  kind: QuestionKind,
  clause: string,
  options: readonly { label: string }[] = [],
): Rendered {
  const ask: Record<QuestionKind, string> = {
    PAYMENT_SOURCE: 'How did you pay for this?\nReply 1 — company card\nReply 2 — my own card or cash',
    MATCH_CONFIRMATION: `Which company-card transaction is this?\n${options.map((o, i) => `Reply ${i + 1} — ${o.label}`).join('\n')}\nReply "none" if it is none of these.`,
    RECEIPT: 'Please reply with the receipt attached.',
    BUSINESS_PURPOSE: 'What was the business purpose? Reply with one line, e.g. "Lunch with the Acme site team during the boiler install".',
    VAT_INVOICE: "Please reply with the full VAT invoice attached (it must show the supplier's VAT number).",
  };
  return {
    subject: subjectFor(e, 'One question'),
    text: `${describe(e)}\n\n${ask[kind]}\n\nWhy we ask: ${clause}\n\nThis is the only question we'll ask about this expense.\n\n${FOOTER}`,
  };
}

export function reviewerNotice(e: ExpenseSummary, employeeName: string, reasons: readonly string[], clauses: readonly string[]): Rendered {
  return {
    subject: subjectFor(e, `Review needed — ${employeeName}`),
    text: `${describe(e)} from ${employeeName} needs a decision because ${listReasons(reasons)}.\n${clauses.map((c) => `• ${c}`).join('\n')}\n\nThe receipt, evidence and audit trail are on the review page (sign-in required).\n\n${FOOTER}`,
  };
}

export function enrolmentMessage(): Rendered {
  return {
    subject: 'Swipeback — please ask finance to enrol you',
    text: `We received your message, but this address isn't enrolled with your company's Swipeback workspace, so we haven't processed it. Ask your finance team to add you, then resend.\n\n${FOOTER}`,
  };
}

export function helpMessage(): Rendered {
  return {
    subject: 'How to use Swipeback',
    text: `Email a receipt (PDF, photo or e-receipt) to this address and Swipeback does the rest. If something is missing we'll ask one question. Reply "status" for an update on your recent expenses.\n\n${FOOTER}`,
  };
}

export function statusMessage(lines: readonly string[]): Rendered {
  return {
    subject: 'Your recent expenses',
    text: `${lines.length ? lines.join('\n') : 'No expenses yet.'}\n\n${FOOTER}`,
  };
}

function listReasons(reasons: readonly string[]): string {
  const r = [...new Set(reasons)];
  if (r.length <= 1) return r[0] ?? 'it needs a person to check it';
  return `${r.slice(0, -1).join(', ')} and ${r.at(-1)}`;
}
