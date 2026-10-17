import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import OpenAI from 'openai';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { money } from '@swipeback/domain';
import {
  EXTRACTION_SYSTEM_PROMPT,
  finaliseExtraction,
  openAICassetteClient,
  openAICostMicros,
  OpenAIExtractor,
  TransientExtractionError,
  type ModelOutput,
  type ReceiptSource,
  type ResponsesClient,
} from '@swipeback/extraction';
import { ReceiptRenderer, type ReceiptSpec } from '@swipeback/cli/receipts';

/** OpenAI extractor behaviour with an injected Responses client (no network). */

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

function response(out: ModelOutput | null, extra: Record<string, unknown> = {}) {
  return {
    model: 'gpt-5.5',
    status: 'completed',
    incomplete_details: null,
    usage: { input_tokens: 2400, output_tokens: 700, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 300 } },
    output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(out), parsed: out }] }],
    output_parsed: out,
    ...extra,
  };
}

function fake(reply: (params: Record<string, unknown>) => unknown): ResponsesClient & { calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  const parse = (async (params: Record<string, unknown>) => {
    calls.push(params);
    return reply(params);
  }) as unknown as ResponsesClient['responses']['parse'];
  return { calls, responses: { parse } };
}

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

async function run(client: ResponsesClient, source: ReceiptSource = jpeg, model?: string) {
  const result = await new OpenAIExtractor({ client, ...(model ? { model } : {}) }).extract(source, ctx);
  return { result, facts: finaliseExtraction(result, ctx) };
}

describe('OpenAI extractor (AC-02)', () => {
  it('reads a receipt photo into typed fields; evidence checked against the transcription; costed at gpt-5.5 rates', async () => {
    const client = fake(() => response(good()));
    const { result, facts } = await run(client);
    expect(result).toMatchObject({ status: 'SUCCEEDED', model: 'gpt-5.5' });
    expect(facts).toMatchObject({ merchant: 'Trainline', amount: money(4210, 'GBP'), date: '2026-10-16', cardLast4: '9911', category: 'TRAVEL', uncertainFields: [], flags: [] });
    expect(result.usage).toMatchObject({ inputTokens: 2400, outputTokens: 700, costMicros: 2400 * 5 + 700 * 30 });
  });

  it('sends the shared prompt, a high-detail image, structured output, reasoning effort and store:false', async () => {
    const client = fake(() => response(good()));
    await run(client);
    const p = client.calls[0] as { model: string; instructions: string; reasoning: { effort: string }; store: boolean; text: { format: { type: string; name: string; strict?: boolean } }; input: { content: { type: string; detail?: string; image_url?: string }[] }[] };
    expect(p.model).toBe('gpt-5.5');
    expect(p.instructions).toBe(EXTRACTION_SYSTEM_PROMPT);
    expect(p.reasoning).toEqual({ effort: 'medium' });
    expect(p.store).toBe(false);
    expect(p.text.format).toMatchObject({ type: 'json_schema', name: 'receipt_extraction' });
    expect(p.input[0]!.content[0]).toMatchObject({ type: 'input_image', detail: 'high' });
    expect(p.input[0]!.content[0]!.image_url).toMatch(/^data:image\/jpeg;base64,/);
  });

  it('PDFs go as input_file and are verified against the independent text layer', async () => {
    const client = fake(() => response(good({ total: { amount: '24.10', currency: 'GBP', confidence: 0.99, quote: 'TOTAL £24.10' } })));
    const { result, facts } = await run(client, pdf);
    expect((client.calls[0] as { input: { content: { type: string }[] }[] }).input[0]!.content[0]!.type).toBe('input_file');
    expect(result.sourceText).toContain('TOTAL  £42.10');
    expect(facts.uncertainFields).toContain('amount'); // the model's quote is not on the document
  });

  it('the cheaper model is costed at its own rates; an unknown model is reported as unknown cost', async () => {
    const mini = await run(fake(() => response(good(), { model: 'gpt-5.4-mini' })), jpeg, 'gpt-5.4-mini');
    expect(mini.result.usage?.costMicros).toBe(Math.round(2400 * 0.75 + 700 * 4.5));
    expect(openAICostMicros('gpt-5.4-mini-2026-03-17', { input_tokens: 1000, output_tokens: 0, input_tokens_details: { cached_tokens: 400 } })).toBe(Math.round(600 * 0.75 + 400 * 0.075));
    const unknown = await run(fake(() => response(good(), { model: 'gpt-x' })), jpeg, 'gpt-x');
    expect(unknown.result.usage?.costMicros).toBeNull();
  });

  it('instructions detected and arithmetic conflicts are flagged', async () => {
    expect((await run(fake(() => response(good({ instructions_detected: true }))))).facts.flags).toContain('INJECTION_SUSPECTED');
    expect((await run(fake(() => response(good({ line_items: [{ description: 'a', amount: '30.00' }, { description: 'b', amount: '30.00' }] }))))).facts.flags).toContain('ARITHMETIC_MISMATCH');
  });
});

describe('OpenAI extractor failure handling (AC-10)', () => {
  it.each([
    ['schema mismatch', response(null), 'INVALID'],
    ['truncated (incomplete)', response(good(), { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }), 'INVALID'],
    ['refusal', response(null, { output: [{ type: 'message', content: [{ type: 'refusal', refusal: "I can't help with that." }] }] }), 'FAILED'],
  ])('%s -> %s, fails closed', async (_l, r, status) => {
    const { result, facts } = await run(fake(() => r));
    expect(result.status).toBe(status);
    expect(facts.flags).toContain('EXTRACTION_FAILED');
    expect(facts.amount).toBeNull();
  });

  it.each([
    ['rate limit', () => new OpenAI.RateLimitError(429, undefined, 'rate limited', new Headers())],
    ['5xx', () => new OpenAI.InternalServerError(503, undefined, 'unavailable', new Headers())],
    ['timeout', () => new OpenAI.APIConnectionTimeoutError({ message: 'timed out' })],
    ['connection', () => new OpenAI.APIConnectionError({ message: 'ECONNRESET' })],
  ])('%s is transient', async (_l, err) => {
    await expect(run(fake(() => { throw err(); }))).rejects.toBeInstanceOf(TransientExtractionError);
  });

  it('a 400 fails closed without retry; a malformed PDF never reaches the API', async () => {
    expect((await run(fake(() => { throw new OpenAI.BadRequestError(400, undefined, 'bad', new Headers()); }))).result.status).toBe('FAILED');
    const client = fake(() => response(good()));
    const { facts } = await run(client, { kind: 'ATTACHMENT', mime: 'application/pdf', bytes: Buffer.from('%PDF-1.4 junk'), sha256: 'c'.repeat(64) });
    expect(client.calls).toHaveLength(0);
    expect(facts.flags).toContain('MALFORMED_ATTACHMENT');
  });
});

describe('OpenAI cassettes', () => {
  it('records, replays identically, and refuses to replay a different document', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'sb-oai-'));
    const live = fake(() => response(good()));
    const recorded = await new OpenAIExtractor({ client: openAICassetteClient({ dir, mode: 'record', live }) }).extract(jpeg, ctx);
    expect(await readdir(dir)).toHaveLength(1);
    const replayer = new OpenAIExtractor({ client: openAICassetteClient({ dir, mode: 'replay' }) });
    const replayed = await replayer.extract(jpeg, ctx);
    expect({ ...replayed, usage: { ...replayed.usage, latencyMs: 0 } }).toEqual({ ...recorded, usage: { ...recorded.usage, latencyMs: 0 } });
    const other = await replayer.extract(pdf, ctx);
    expect(other).toMatchObject({ status: 'FAILED', error: expect.stringMatching(/no recorded openai response/) });
  });
});
