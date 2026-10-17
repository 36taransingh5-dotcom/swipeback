import { isIsoDate, parseDecimalToMinor } from '@swipeback/domain';
import { suggestCategory } from './category.ts';
import { textFromSource } from './text.ts';
import type { ExtractedField, ExtractedReceipt, ExtractionContext, ExtractionResult, Extractor, ReceiptSource } from './types.ts';

/**
 * Rule-only extractor over text receipts (e-receipts, text/HTML). It is the evaluation baseline
 * and the fallback when no model is configured. It cannot read images or scanned PDFs; those fail
 * closed into review.
 */

const SYMBOL_CURRENCY: Readonly<Record<string, string>> = { '£': 'GBP', '€': 'EUR', $: 'USD' };
const AMOUNT_RE = /(£|€|\$|GBP|EUR|USD)?\s?(-?\d{1,3}(?:,\d{3})*(?:\.\d{2})|-?\d+\.\d{2})\s?(GBP|EUR|USD)?/;
const MONTHS: Readonly<Record<string, number>> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};
const GENERIC_HEADER_RE = /^(receipt|tax invoice|invoice|vat receipt|order confirmation|thank you|your receipt|e-?receipt|customer copy)\b/i;

const empty = <T>(): ExtractedField<T> => ({ value: null, confidence: 0, evidence: null });
const found = <T>(value: T, confidence: number, quote: string): ExtractedField<T> => ({
  value,
  confidence,
  evidence: { source: 'attachment', quote: quote.trim().slice(0, 500) },
});

export function parseAmountLine(line: string): { amountMinor: number; currency: string | null } | null {
  const m = AMOUNT_RE.exec(line);
  if (!m) return null;
  const symbol = m[1] ?? m[3] ?? null;
  const currency = symbol ? (SYMBOL_CURRENCY[symbol] ?? symbol) : null;
  const parsed = parseDecimalToMinor(m[2]!, currency ?? 'GBP');
  return parsed ? { amountMinor: parsed.amountMinor, currency } : null;
}

export function parseDate(text: string): string | null {
  const iso = /\b(20\d{2})-(\d{2})-(\d{2})(?!\d)/.exec(text);
  if (iso) return valid(`${iso[1]}-${iso[2]}-${iso[3]}`);
  const dmy = /\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})\b/.exec(text); // UK day-first
  if (dmy) return valid(ymd(year(dmy[3]!), Number(dmy[2]), Number(dmy[1])));
  const dMonY = /\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})\b/.exec(text);
  if (dMonY) {
    const mon = MONTHS[dMonY[2]!.slice(0, 3).toLowerCase()];
    if (mon) return valid(ymd(Number(dMonY[3]), mon, Number(dMonY[1])));
  }
  const monDY = /\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/.exec(text);
  if (monDY) {
    const mon = MONTHS[monDY[1]!.slice(0, 3).toLowerCase()];
    if (mon) return valid(ymd(Number(monDY[3]), mon, Number(monDY[2])));
  }
  return null;
}

function year(y: string): number {
  return y.length === 2 ? 2000 + Number(y) : Number(y);
}
function ymd(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
function valid(d: string): string | null {
  return isIsoDate(d) ? d : null;
}

export function extractFromText(text: string): ExtractedReceipt {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const r: ExtractedReceipt = {
    merchant: empty(),
    total: empty(),
    subtotal: empty(),
    tax: empty(),
    date: empty(),
    vatNumber: empty(),
    receiptNumber: empty(),
    cardLast4: empty(),
    tender: empty(),
    category: empty(),
    lineItems: [],
  };
  const docCurrency = /£|GBP/.test(text) ? 'GBP' : /€|EUR/.test(text) ? 'EUR' : /\$|USD/.test(text) ? 'USD' : null;

  // Merchant: explicit label, else the first non-generic header line.
  const merchantLine = lines.find((l) => /^(merchant|supplier|vendor|store|sold by)\s*:/i.test(l));
  if (merchantLine) {
    r.merchant = found(merchantLine.replace(/^[^:]+:\s*/, ''), 0.95, merchantLine);
  } else {
    const header = lines.find((l) => !GENERIC_HEADER_RE.test(l) && /[a-z]{3,}/i.test(l) && !AMOUNT_RE.test(l) && l.length <= 80);
    if (header) r.merchant = found(header.replace(/\s+/g, ' '), 0.85, header);
  }

  // Date: labelled first.
  const dateLine = lines.find((l) => /^(date|transaction date|purchase date|issued|invoice date)\b/i.test(l) && parseDate(l));
  if (dateLine) r.date = found(parseDate(dateLine)!, 0.95, dateLine);
  else {
    const anyDate = lines.find((l) => parseDate(l));
    if (anyDate) r.date = found(parseDate(anyDate)!, 0.8, anyDate);
  }

  // Totals: the last "total" line that is not subtotal/VAT total.
  const totalLines = lines.filter((l) => /\b(total|amount paid|amount due|grand total|balance paid)\b/i.test(l) && !/\b(sub\s?-?total|total vat|vat total|total tax|total savings)\b/i.test(l) && parseAmountLine(l));
  const totalLine = totalLines.at(-1);
  if (totalLine) {
    const a = parseAmountLine(totalLine)!;
    const cur = a.currency ?? docCurrency;
    if (cur) r.total = found({ amountMinor: a.amountMinor, currency: cur }, a.currency ? 0.95 : 0.85, totalLine);
    else r.total = { value: null, confidence: 0, evidence: { source: 'attachment', quote: totalLine } };
  }
  const subLine = lines.find((l) => /\bsub\s?-?total\b/i.test(l) && parseAmountLine(l));
  if (subLine) r.subtotal = found({ amountMinor: parseAmountLine(subLine)!.amountMinor }, 0.9, subLine);
  const vatLine = lines.find((l) => /\b(vat|tax)\b/i.test(l) && !/\b(vat|tax)\s*(no|number|reg)/i.test(l) && parseAmountLine(l));
  if (vatLine) r.tax = found({ amountMinor: parseAmountLine(vatLine)!.amountMinor }, 0.9, vatLine);

  const vatNo = /\bVAT\s*(?:no\.?|number|reg(?:istration)?(?:\s*no\.?)?)?\s*[:#]?\s*(GB\s?\d{3}\s?\d{4}\s?\d{2}(?:\s?\d{3})?)\b/i.exec(text);
  if (vatNo) r.vatNumber = found(vatNo[1]!.replace(/\s+/g, ''), 0.95, vatNo[0]);

  const recNo = /\b(?:receipt|invoice|order|transaction|booking|ref(?:erence)?)[ \t]*(?:no\.?|number|#|ref|id)?[ \t]*[:#][ \t]*([A-Z0-9][A-Z0-9-]{2,40})\b/i.exec(text);
  if (recNo) r.receiptNumber = found(recNo[1]!, 0.9, recNo[0]);

  const last4 = /(?:ending(?:\s+in)?|card\s*(?:no\.?|number)?\s*[:#]?\s*[*x•]{2,}[\s*x•-]*|[*x•]{4,}[\s-]*)\s*(\d{4})\b/i.exec(text);
  if (last4) r.cardLast4 = found(last4[1]!, 0.95, last4[0]);
  const cardWords = /\b(visa|mastercard|amex|american express|maestro|contactless|debit card|credit card|card payment|apple pay|google pay|paid by card)\b/i.exec(text);
  const cashWords = /\b(cash|change due)\b/i.exec(text);
  if (cardWords || last4) r.tender = found('CARD', 0.9, (cardWords ?? last4)![0]);
  else if (cashWords) r.tender = found('CASH', 0.9, cashWords[0]);

  // Line items: "<description> <amount>" lines that are not totals/tax/payment lines.
  for (const l of lines) {
    if (/\b(total|vat|tax|change|cash|card|visa|mastercard|paid|balance|tender|discount)\b/i.test(l)) continue;
    const m = /^(.{2,80}?)\s+(?:£|€|\$)?(-?\d+\.\d{2})$/.exec(l);
    if (m) {
      const p = parseDecimalToMinor(m[2]!, 'GBP');
      if (p) r.lineItems.push({ description: m[1]!.trim(), amountMinor: p.amountMinor });
    }
  }

  const cat = suggestCategory(r.merchant.value, text);
  if (cat.category) r.category = { value: cat.category, confidence: cat.confidence, evidence: null };
  return r;
}

export class BaselineExtractor implements Extractor {
  readonly name = 'baseline' as const;

  async extract(source: ReceiptSource, _ctx: ExtractionContext): Promise<ExtractionResult> {
    const text = textFromSource(source);
    if (text === null) {
      return {
        status: 'FAILED',
        extractor: 'baseline',
        model: null,
        receipt: null,
        sourceText: null,
        flags: ['EXTRACTION_FAILED'],
        error: `rule-only extractor cannot read ${source.mime}`,
        usage: null,
      };
    }
    return {
      status: 'SUCCEEDED',
      extractor: 'baseline',
      model: null,
      receipt: extractFromText(text),
      sourceText: text,
      flags: [],
      error: null,
      usage: null,
    };
  }
}
