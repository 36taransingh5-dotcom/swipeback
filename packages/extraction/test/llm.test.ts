import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { money } from '@swipeback/domain';
import {
  cassetteClient,
  costMicros,
  finaliseExtraction,
  LlmExtractor,
  TransientExtractionError,
  type MessagesClient,
  type ModelOutput,
  type ReceiptSource,
} from '@swipeback/extraction';
import { ReceiptRenderer, type ReceiptSpec } from '@swipeback/cli/receipts';

/**
 * LLM extractor behaviour with an injected client (no network). Live behaviour is covered by
 * `sb smoke:extract` and by recorded cassettes replayed through the same code path.
 */

const spec: ReceiptSpec = { merchant: 'Trainline', receiptNo: 'TL-88231', date: '16/10/2026', items: [['Off-peak return Euston - Watford', '42.10']], total: '42.10', paidWith: { card: '9911' } };
const field = (value: string | null, quote: string | null = value, confidence = 0.97) => ({ value, confidence, quote });
const good = (o: Partial<ModelOutput> = {}): ModelOutput => ({
  is_receipt_or_invoice: true,
  transcription: 'Trainline\nReceipt No: TL-88231 · Date: 16/10/2026\nOff-peak return Euston - Watford £42.10\nTOTAL £42.10\nVisa ending 9911 £42.10',
  merchant: field('Trainline'),
  total: { amount: '42.10', currency: 'GBP', confidence: 0.98, quote: 'TOTAL  £42.10' },
  subtotal: { amount: null, confidence: 0, quote: null },
  tax: { amount: null, confidence: 0, quote: null },
  date: field('2026-10-16', 'Date: 16/10/2026'),
  vat_number: field(null),
  receipt_number: field('TL-88231', 'Receipt No: TL-88231'),
  card_last4: field('9911', 'Visa ending 9911'),
  tender: { value: 'CARD', confidence: 0.95, quote: 'Visa ending 9911' },
  category: { value: 'TRAVEL', confidence: 0.95 },
  line_items: [{ description: 'Off-peak return Euston - Watford', amount: '42.10' }],
  instructions_detected: false,
  ...o,
});

function fakeClient(reply: (params: Record<string, unknown>) => unknown | Promise<unknown>): MessagesClient & { calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  const parse = (async (params: Record<string, unknown>) => {
    calls.push(params);
    return reply(params);
  }) as unknown as MessagesClient['beta']['messages']['parse'];
  return { calls, beta: { messages: { parse } } };
}
const ok = (out: ModelOutput | null, extra: Record<string, unknown> = {}) => ({
  model: 'claude-opus-5-5',
  stop_reason: 'end_turn',
  usage: { input_tokens: 1800, output_tokens: 400, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  parsed_output: out,
  ...extra,
});

const ctx = { senderText: '', subject: null };
let renderer: ReceiptRenderer;
let pdf: ReceiptSource;
let jpeg: ReceiptSource;
beforeAll(async () => {
  renderer = new ReceiptRenderer();
  const p = await renderer.render(spec, 'pdf');
  const j = await renderer.render(spec, 'photo');
  pdf = { kind: 'ATTACHMENT', mime: p.mime, bytes: p.bytes, sha256: 'a'.repeat(64) };
  jpeg = { kind: 'ATTACHMENT', mime: j.mime, bytes: j.bytes, sha256: 'b'.repeat(64) };
}, 60_000);
afterAll(async () => renderer.close());

async function run(client: MessagesClient, source: ReceiptSource = pdf) {
  const result = await new LlmExtractor({ client }).extract(source, ctx);
  return { result, facts: finaliseExtraction(result, ctx) };
}

describe('LLM extractor (AC-02)', () => {
  it('returns typed vendor, amount, currency, date with evidence verified against the PDF text layer', async () => {
    const client = fakeClient(() => ok(good()));
    const { result, facts } = await run(client);
    expect(result.status).toBe('SUCCEEDED');
    expect(result.sourceText).toContain('TOTAL  £42.10'); // independent text layer, not the model's transcription
    expect(facts).toMatchObject({ merchant: 'Trainline', amount: money(4210, 'GBP'), date: '2026-10-16', category: 'TRAVEL', cardLast4: '9911', tender: 'CARD', uncertainFields: [], flags: [] });
    expect(result.usage).toMatchObject({ inputTokens: 1800, outputTokens: 400, costMicros: 1800 * 4 + 400 * 20 });
  });

  it('sends the document as a PDF block with the schema, effort and server-side fallback', async () => {
    const client = fakeClient(() => ok(good()));
    await run(client);
    const params = client.calls[0] as { model: string; system: string; messages: { content: { type: string }[] }[]; output_config: { effort: string; format: unknown }; betas: string[]; fallbacks: string };
    expect(params.model).toBe('claude-opus-5-5');
    expect(params.output_config.effort).toBe('medium');
    expect(params.output_config.format).toBeTruthy();
    expect(params.betas).toEqual(['server-side-fallback-2026-07-01']);
    expect(params.fallbacks).toBe('default');
    expect(params.messages[0]!.content[0]!.type).toBe('document');
    expect(params.system).toMatch(/untrusted data/);
    const imageCall = fakeClient(() => ok(good()));
    await run(imageCall, jpeg);
    expect((imageCall.calls[0] as typeof params).messages[0]!.content[0]!.type).toBe('image');
  });

  it('marks a value whose quote is not on the document as uncertain (no invented fields)', async () => {
    const client = fakeClient(() => ok(good({ total: { amount: '24.10', currency: 'GBP', confidence: 0.99, quote: 'TOTAL £24.10' } })));
    const { facts } = await run(client);
    expect(facts.uncertainFields).toContain('amount');
    expect(facts.notes.join(' ')).toMatch(/not found in the source/);
  });

  it('low confidence or a missing currency symbol is uncertain, never assumed', async () => {
    const blurry = await run(fakeClient(() => ok(good({ date: field('2026-10-16', 'Date: 16/10/2026', 0.55) }))));
    expect(blurry.facts.uncertainFields).toEqual(['date']);
    const noCurrency = await run(fakeClient(() => ok(good({ total: { amount: '42.10', currency: null, confidence: 0.9, quote: 'TOTAL  £42.10' } }))));
    expect(noCurrency.facts.uncertainFields).toEqual(expect.arrayContaining(['amount', 'currency']));
  });

  it('for photos, evidence is checked against the model transcription', async () => {
    const { result, facts } = await run(fakeClient(() => ok(good())), jpeg);
    expect(result.sourceText).toBe(good().transcription);
    expect(facts.amount).toEqual(money(4210, 'GBP'));
  });

  it('instructions in the document raise INJECTION_SUSPECTED', async () => {
    const { facts } = await run(fakeClient(() => ok(good({ instructions_detected: true }))));
    expect(facts.flags).toContain('INJECTION_SUSPECTED');
  });

  it('line items that do not add up raise ARITHMETIC_MISMATCH', async () => {
    const { facts } = await run(fakeClient(() => ok(good({ line_items: [{ description: 'a', amount: '30.00' }, { description: 'b', amount: '30.00' }] }))));
    expect(facts.flags).toContain('ARITHMETIC_MISMATCH');
  });

  it('a non-receipt document fails closed', async () => {
    const { result, facts } = await run(fakeClient(() => ok(good({ is_receipt_or_invoice: false }))));
    expect(result.status).toBe('INVALID');
    expect(facts.flags).toContain('EXTRACTION_FAILED');
  });
});

describe('LLM extractor failure handling (AC-10)', () => {
  it.each([
    ['schema mismatch (parsed_output null)', ok(null), 'INVALID'],
    ['truncated output', ok(good(), { stop_reason: 'max_tokens' }), 'INVALID'],
    ['refusal', ok(null, { stop_reason: 'refusal' }), 'FAILED'],
  ])('%s -> %s and EXTRACTION_FAILED', async (_l, response, status) => {
    const { result, facts } = await run(fakeClient(() => response));
    expect(result.status).toBe(status);
    expect(facts.flags).toContain('EXTRACTION_FAILED');
    expect(facts.amount).toBeNull();
  });

  it.each([
    ['rate limit', () => new Anthropic.RateLimitError(429, undefined, 'rate limited', new Headers())],
    ['overloaded / 5xx', () => new Anthropic.InternalServerError(529, undefined, 'overloaded', new Headers())],
    ['timeout', () => new Anthropic.APIConnectionTimeoutError({ message: 'timed out' })],
    ['connection reset', () => new Anthropic.APIConnectionError({ message: 'socket hang up' })],
  ])('%s is transient (retried by the job runner, then fails closed)', async (_l, err) => {
    await expect(run(fakeClient(() => { throw err(); }))).rejects.toBeInstanceOf(TransientExtractionError);
  });

  it('a 400 is not retried: it fails closed immediately', async () => {
    const { result } = await run(fakeClient(() => { throw new Anthropic.BadRequestError(400, undefined, 'bad request', new Headers()); }));
    expect(result.status).toBe('FAILED');
  });

  it('a malformed PDF is rejected before any model call', async () => {
    const client = fakeClient(() => ok(good()));
    const { facts } = await run(client, { kind: 'ATTACHMENT', mime: 'application/pdf', bytes: Buffer.from('%PDF-1.7 garbage'), sha256: 'c'.repeat(64) });
    expect(client.calls).toHaveLength(0);
    expect(facts.flags).toContain('MALFORMED_ATTACHMENT');
  });

  it('costs are computed from token usage (cache reads 0.1x, writes 1.25x)', () => {
    expect(costMicros('claude-opus-5-5', { input_tokens: 1000, output_tokens: 500 })).toBe(14_000);
    expect(costMicros('claude-opus-5-5', { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1000, cache_creation_input_tokens: 1000 })).toBe(400 + 5000);
  });
});

describe('record / replay cassettes', () => {
  it('replays a recorded response through the same extraction path; changed input is not silently replayed', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'sb-cassettes-'));
    const live = fakeClient(() => ok(good()));
    const recorded = await new LlmExtractor({ client: cassetteClient({ dir, mode: 'record', live }) }).extract(pdf, ctx);
    expect(await readdir(dir)).toHaveLength(1);

    const replayer = new LlmExtractor({ client: cassetteClient({ dir, mode: 'replay' }) });
    const replayed = await replayer.extract(pdf, ctx);
    expect({ ...replayed, usage: { ...replayed.usage, latencyMs: 0 } }).toEqual({ ...recorded, usage: { ...recorded.usage, latencyMs: 0 } });
    expect(live.calls).toHaveLength(1);

    const other = await replayer.extract(jpeg, ctx);
    expect(other.status).toBe('FAILED');
    expect(other.error).toMatch(/no recorded response/);
  });
});
