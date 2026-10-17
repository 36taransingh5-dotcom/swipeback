import { money, type Category, type DecisionField, type IntegrityFlag, type IsoDate, type Money } from '@swipeback/domain';
import { detectInjection } from './injection.ts';
import { containsQuote } from './text.ts';
import { extractedReceiptSchema, type ExtractedReceipt, type ExtractionContext, type ExtractionResult } from './types.ts';

/**
 * Post-extraction checks applied identically to every extractor. The model (or rule set) proposes
 * values; these deterministic checks decide how far each value can be trusted.
 */

export const CONFIDENCE_THRESHOLD = 0.8;

export interface ReceiptFacts {
  merchant: string | null;
  amount: Money | null;
  date: IsoDate | null;
  category: Category | null;
  cardLast4: string | null;
  tender: 'CARD' | 'CASH' | 'UNKNOWN';
  hasVatInvoice: boolean;
  receiptNumber: string | null;
  uncertainFields: DecisionField[];
  flags: IntegrityFlag[];
  /** Fields marked uncertain, with why — shown to reviewers. */
  notes: string[];
}

export function finaliseExtraction(result: ExtractionResult, ctx: ExtractionContext): ReceiptFacts {
  const flags = new Set<IntegrityFlag>(result.flags);
  const notes: string[] = [];
  const injection = detectInjection(result.sourceText, ctx.senderText, ctx.subject);
  if (injection.suspected) {
    flags.add('INJECTION_SUSPECTED');
    notes.push(`Instruction-like text found: "${injection.matches[0]!.slice(0, 80)}"`);
  }

  if (result.status !== 'SUCCEEDED' || !result.receipt) {
    flags.add('EXTRACTION_FAILED');
    if (result.error) notes.push(`Extraction failed: ${result.error}`);
    return {
      merchant: null, amount: null, date: null, category: null, cardLast4: null, tender: 'UNKNOWN',
      hasVatInvoice: false, receiptNumber: null, uncertainFields: ['amount', 'currency', 'date', 'merchant'],
      flags: [...flags].sort(), notes,
    };
  }

  const parsed = extractedReceiptSchema.safeParse(result.receipt);
  if (!parsed.success) {
    flags.add('EXTRACTION_FAILED');
    notes.push('Extraction output failed schema validation');
    return finaliseExtraction({ ...result, status: 'INVALID', receipt: null, flags: [...flags] }, ctx);
  }
  const r: ExtractedReceipt = parsed.data;

  // Evidence verification: a quote that is not in the source text cannot be trusted.
  const trust = <T>(name: string, f: { value: T | null; confidence: number; evidence: { quote: string } | null }): number => {
    if (f.value === null) return 0;
    if (!f.evidence) return Math.min(f.confidence, 0.5);
    if (result.sourceText !== null && !containsQuote(result.sourceText, f.evidence.quote)) {
      notes.push(`${name}: evidence "${f.evidence.quote.slice(0, 60)}" not found in the source`);
      return Math.min(f.confidence, 0.4);
    }
    return f.confidence;
  };

  const uncertain = new Set<DecisionField>();
  const mark = (field: DecisionField, confidence: number, why: string) => {
    if (confidence < CONFIDENCE_THRESHOLD) {
      uncertain.add(field);
      notes.push(`${field} uncertain: ${why}`);
    }
  };
  const merchantConf = trust('merchant', r.merchant);
  const totalConf = trust('total', r.total);
  const dateConf = trust('date', r.date);
  mark('merchant', merchantConf, r.merchant.value ? `confidence ${merchantConf.toFixed(2)}` : 'not found');
  mark('amount', totalConf, r.total.value ? `confidence ${totalConf.toFixed(2)}` : 'not found');
  if (!r.total.value) uncertain.add('currency');
  mark('date', dateConf, r.date.value ? `confidence ${dateConf.toFixed(2)}` : 'not found');

  // Arithmetic consistency: an inconsistency is labelled as such, never as fraud.
  if (r.total.value) {
    const total = r.total.value.amountMinor;
    if (r.subtotal.value && r.tax.value && Math.abs(r.subtotal.value.amountMinor + r.tax.value.amountMinor - total) > 1) {
      // UK receipts often show subtotal *including* VAT; only flag when neither reading adds up.
      if (Math.abs(r.subtotal.value.amountMinor - total) > 1) {
        flags.add('ARITHMETIC_MISMATCH');
        notes.push('Subtotal + VAT does not equal the total');
      }
    }
    if (r.lineItems.length >= 2) {
      const sum = r.lineItems.reduce((s, li) => s + li.amountMinor, 0);
      const target = r.subtotal.value?.amountMinor ?? total;
      if (Math.abs(sum - target) > 1 && Math.abs(sum - total) > 1) {
        flags.add('ARITHMETIC_MISMATCH');
        notes.push(`Line items sum to ${sum}, receipt says ${target}`);
      }
    }
  }

  const amount = r.total.value ? money(r.total.value.amountMinor, r.total.value.currency) : null;
  return {
    merchant: r.merchant.value,
    amount,
    date: r.date.value,
    category: r.category.value,
    cardLast4: r.cardLast4.value && trust('cardLast4', r.cardLast4) >= CONFIDENCE_THRESHOLD ? r.cardLast4.value : null,
    tender: r.tender.value ?? 'UNKNOWN',
    hasVatInvoice: r.vatNumber.value !== null && trust('vatNumber', r.vatNumber) >= CONFIDENCE_THRESHOLD,
    receiptNumber: r.receiptNumber.value,
    uncertainFields: [...uncertain].sort(),
    flags: [...flags].sort(),
    notes,
  };
}

/**
 * The employee's explicitly stated business purpose from their own message ("Purpose: ...").
 * Never inferred or invented from the receipt.
 */
export function statedPurpose(senderText: string): string | null {
  const m = /^\s*(?:business\s+)?(?:purpose|reason)\s*[:-]\s*(.{4,500})$/im.exec(senderText);
  return m ? m[1]!.replace(/\s+/g, ' ').trim() : null;
}
