import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LlmExtractor, type MessagesClient, type ModelOutput } from '@swipeback/extraction';
import { ReceiptRenderer } from '@swipeback/cli/receipts';
import { createHarness, ukDate } from './harness.ts';

/** The full pipeline with the LLM extractor in place of the baseline (model responses injected). */

let renderer: ReceiptRenderer;
beforeAll(() => {
  renderer = new ReceiptRenderer();
});
afterAll(async () => renderer.close());

const iso = (uk: string) => uk.split('/').reverse().join('-');

function modelReturning(out: (date: string) => ModelOutput): MessagesClient {
  const parse = (async () => ({
    model: 'claude-opus-5-5',
    stop_reason: 'end_turn',
    usage: { input_tokens: 2100, output_tokens: 450 },
    parsed_output: out(iso(ukDate(1))),
  })) as unknown as MessagesClient['beta']['messages']['parse'];
  return { beta: { messages: { parse } } };
}

const q = (value: string | null, quote: string | null = value) => ({ value, confidence: 0.96, quote });
const trainOutput = (date: string, o: Partial<ModelOutput> = {}): ModelOutput => ({
  is_receipt_or_invoice: true,
  transcription: '',
  merchant: q('Trainline'),
  total: { amount: '42.10', currency: 'GBP', confidence: 0.98, quote: 'TOTAL  £42.10' },
  subtotal: { amount: null, confidence: 0, quote: null },
  tax: { amount: null, confidence: 0, quote: null },
  date: q(date, `Date: ${ukDate(1)}`),
  vat_number: q(null),
  receipt_number: q('TL-1', 'Receipt No: TL-1'),
  card_last4: q('9911', 'Visa ending 9911'),
  tender: { value: 'CARD', confidence: 0.95, quote: 'Visa ending 9911' },
  category: { value: 'TRAVEL', confidence: 0.95 },
  line_items: [{ description: 'Off-peak return', amount: '42.10' }],
  instructions_detected: false,
  ...o,
});

async function trainPdf() {
  return renderer.render({ merchant: 'Trainline', receiptNo: 'TL-1', date: ukDate(1), items: [['Off-peak return Euston - Watford', '42.10']], total: '42.10', paidWith: { card: '9911' } }, 'pdf');
}

describe('pipeline with the LLM extractor', () => {
  it('a PDF receipt read by the model is verified, cleared and paid once; the model call is costed', async () => {
    const h = await createHarness({ extractor: new LlmExtractor({ client: modelReturning((d) => trainOutput(d)) }) });
    try {
      const pdf = await trainPdf();
      await h.email({ attachments: [{ filename: 'receipt.pdf', mime: 'application/pdf', content: pdf.bytes }] });
      await h.drain();
      expect((await h.expenses())[0]).toMatchObject({ state: 'EXPORTED', payment_type: 'PERSONAL', amount_minor: 4210 });
      const calls = (await h.db.pool.query('SELECT model, input_tokens, output_tokens, cost_micros, outcome FROM llm_calls')).rows;
      expect(calls).toEqual([{ model: 'claude-opus-5-5', input_tokens: 2100, output_tokens: 450, cost_micros: 2100 * 4 + 450 * 20, outcome: 'OK' }]);
    } finally {
      await h.close();
    }
  }, 60_000);

  it('a model-read total that is not on the document (manipulated/hallucinated) goes to review, not payout', async () => {
    const h = await createHarness({
      extractor: new LlmExtractor({ client: modelReturning((d) => trainOutput(d, { total: { amount: '24.10', currency: 'GBP', confidence: 0.99, quote: 'TOTAL £24.10' } })) }),
    });
    try {
      const pdf = await trainPdf();
      await h.email({ attachments: [{ filename: 'receipt.pdf', mime: 'application/pdf', content: pdf.bytes }] });
      await h.drain();
      expect((await h.expenses())[0]).toMatchObject({ state: 'REVIEW_REQUIRED' });
      expect((await h.db.pool.query('SELECT count(*)::int AS n FROM reimbursements')).rows[0].n).toBe(0);
    } finally {
      await h.close();
    }
  }, 60_000);

  it('instructions the model detects in a receipt: review, not payout', async () => {
    const h = await createHarness({ extractor: new LlmExtractor({ client: modelReturning((d) => trainOutput(d, { instructions_detected: true })) }) });
    try {
      const pdf = await trainPdf();
      await h.email({ attachments: [{ filename: 'receipt.pdf', mime: 'application/pdf', content: pdf.bytes }] });
      await h.drain();
      expect((await h.expenses())[0]).toMatchObject({ state: 'REVIEW_REQUIRED', flags: ['INJECTION_SUSPECTED'] });
    } finally {
      await h.close();
    }
  }, 60_000);
});
