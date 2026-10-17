import type { QuestionKind } from './types.ts';

/**
 * Channel-neutral intent resolution (PRD §17.2). Deterministic precedence:
 *   1. A signed interactive action with a valid challenge  -> REVIEW_*
 *   2. A reply correlated to an open question              -> answer intent
 *   3. A receipt-like attachment or body                   -> SUBMIT_RECEIPT
 *   4. Status / help keywords                              -> EXPENSE_STATUS / HELP
 *
 * Free text can never produce a review decision, a payout, a payee change or a policy change:
 * no intent for those exists, and review intents only come from a verified signed action.
 */

export const INTENTS = [
  'SUBMIT_RECEIPT',
  'CONFIRM_PAYMENT_SOURCE',
  'PROVIDE_BUSINESS_PURPOSE',
  'EXPENSE_STATUS',
  'REVIEW_APPROVE',
  'REVIEW_DECLINE',
  'REVIEW_REQUEST_INFO',
  'HELP',
] as const;
export type Intent = (typeof INTENTS)[number];

export interface IntentInput {
  /** Present only when the channel adapter verified a signed action AND the challenge is valid. */
  verifiedAction: { verb: 'APPROVE' | 'DECLINE' | 'REQUEST_INFO' } | null;
  /** Open question this message replies to (correlated by thread / token, sender already verified). */
  openQuestion: { kind: QuestionKind; options?: readonly string[] } | null;
  hasReceiptAttachment: boolean;
  /** The body itself looks like a receipt (e.g. an e-receipt email with a total). */
  bodyLooksLikeReceipt: boolean;
  /** New text written by the sender, quoted history already removed by the adapter. */
  text: string;
}

export type ParsedAnswer =
  | { kind: 'PAYMENT_SOURCE'; value: 'CORPORATE' | 'PERSONAL' }
  | { kind: 'BUSINESS_PURPOSE'; value: string }
  | { kind: 'MATCH_CONFIRMATION'; value: string | 'NONE' }
  | { kind: 'RECEIPT' }
  | { kind: 'VAT_INVOICE' };

export interface IntentResolution {
  intent: Intent;
  /** Parsed answer when the message answers the open question; null if the reply did not answer it. */
  answer: ParsedAnswer | null;
}

const REVIEW_INTENT = { APPROVE: 'REVIEW_APPROVE', DECLINE: 'REVIEW_DECLINE', REQUEST_INFO: 'REVIEW_REQUEST_INFO' } as const;

export function resolveIntent(input: IntentInput): IntentResolution {
  if (input.verifiedAction) return { intent: REVIEW_INTENT[input.verifiedAction.verb], answer: null };

  const text = input.text.trim();
  if (input.openQuestion) {
    const q = input.openQuestion;
    switch (q.kind) {
      case 'PAYMENT_SOURCE': {
        const value = parsePaymentSource(text);
        return { intent: 'CONFIRM_PAYMENT_SOURCE', answer: value ? { kind: 'PAYMENT_SOURCE', value } : null };
      }
      case 'BUSINESS_PURPOSE': {
        const value = parseBusinessPurpose(text);
        return { intent: 'PROVIDE_BUSINESS_PURPOSE', answer: value ? { kind: 'BUSINESS_PURPOSE', value } : null };
      }
      case 'MATCH_CONFIRMATION': {
        // Picking which card transaction it was confirms the payment source.
        const value = parseOptionChoice(text, q.options ?? []);
        return { intent: 'CONFIRM_PAYMENT_SOURCE', answer: value ? { kind: 'MATCH_CONFIRMATION', value } : null };
      }
      case 'RECEIPT':
      case 'VAT_INVOICE':
        return {
          intent: 'SUBMIT_RECEIPT',
          answer: input.hasReceiptAttachment || input.bodyLooksLikeReceipt ? { kind: q.kind } : null,
        };
    }
  }

  if (input.hasReceiptAttachment || input.bodyLooksLikeReceipt) return { intent: 'SUBMIT_RECEIPT', answer: null };
  if (/\b(status|update|progress|where(?:'s| is) my|been paid|reimbursed yet)\b/i.test(text)) {
    return { intent: 'EXPENSE_STATUS', answer: null };
  }
  return { intent: 'HELP', answer: null };
}

const CORPORATE_RE = /^(?:1|one|company(?: card)?|corporate(?: card)?|work card|business card|the company card)\b/i;
const PERSONAL_RE = /^(?:2|two|personal(?: card)?|my own(?: card| money)?|own card|own money|cash|paid personally|i paid)\b/i;

const CORPORATE_ANY_RE = /\b(?:company|corporate|work card|business card)\b/i;
const PERSONAL_ANY_RE = /\b(?:personal|my own|own card|own money|cash|paid personally)\b/i;

/** Only a clear, uncontradicted answer counts; anything hedged or mixed is not guessed. */
export function parsePaymentSource(text: string): 'CORPORATE' | 'PERSONAL' | null {
  const first = firstLine(text).replace(/^[\s"'(\-–—*]+/, '');
  if (first.includes('?') || /\b(?:not sure|unsure|don't know|dont know|maybe|think)\b/i.test(first)) return null;
  const corporate = CORPORATE_RE.test(first) && !PERSONAL_ANY_RE.test(first);
  const personal = PERSONAL_RE.test(first) && !CORPORATE_ANY_RE.test(first);
  if (corporate === personal) return null; // neither, or contradictory
  return corporate ? 'CORPORATE' : 'PERSONAL';
}

/**
 * The employee's stated purpose, kept verbatim (never paraphrased or invented). Too short or
 * too long to be a purpose -> null, and the case goes to finance rather than re-asking.
 */
export function parseBusinessPurpose(text: string): string | null {
  const s = text.replace(/\s+/g, ' ').trim();
  if (s.length < 4 || s.length > 500) return null;
  if (!/[a-z]{3,}/i.test(s)) return null;
  return s;
}

export function parseOptionChoice(text: string, options: readonly string[]): string | 'NONE' | null {
  const first = firstLine(text).trim().toLowerCase();
  if (/^(none|neither|no match|not (?:any|one) of (?:these|them))\b/.test(first)) return 'NONE';
  const m = /^(?:option\s*)?#?(\d{1,2})\b/.exec(first);
  if (!m) return null;
  const index = Number(m[1]) - 1;
  return index >= 0 && index < options.length ? options[index]! : null;
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).find((l) => l.trim().length > 0)?.trim() ?? '';
}
