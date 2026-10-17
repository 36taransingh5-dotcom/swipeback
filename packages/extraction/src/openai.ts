import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import { EXTRACTION_SYSTEM_PROMPT, mapModelOutput, modelOutputSchema, type ModelOutput } from './model-contract.ts';
import { MalformedDocumentError } from './pdf.ts';
import { textFromSource } from './text.ts';
import { TransientExtractionError, type ExtractionContext, type ExtractionResult, type Extractor, type ReceiptSource } from './types.ts';

/**
 * OpenAI receipt extraction (Responses API + structured outputs). Same prompt, schema, mapping and
 * deterministic checks as every other provider: the model proposes fields with quotes and
 * confidences; checks.ts verifies them; the policy engine decides.
 */

export const DEFAULT_OPENAI_MODEL = 'gpt-5.5';

/**
 * USD per million tokens, standard tier, short context (OpenAI pricing page, checked 2026-10-17).
 * Reasoning tokens are billed as output tokens and are included in output_tokens.
 */
export const OPENAI_PRICES: Readonly<Record<string, { input: number; cachedInput: number; output: number }>> = {
  'gpt-5.5': { input: 5, cachedInput: 0.5, output: 30 },
  'gpt-5.4': { input: 2.5, cachedInput: 0.25, output: 15 },
  'gpt-5.4-mini': { input: 0.75, cachedInput: 0.075, output: 4.5 },
};

/** The subset of the SDK the extractor needs; injectable for tests and cassettes. */
export interface ResponsesClient {
  responses: { parse: OpenAI['responses']['parse'] };
}

export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export interface OpenAIExtractorOptions {
  client?: ResponsesClient;
  apiKey?: string;
  baseURL?: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  /** Image detail: receipts have small print, so `high` by default. */
  imageDetail?: 'low' | 'high' | 'auto';
  timeoutMs?: number;
}

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/** Explicit credentials and endpoint: ambient OPENAI_* shell variables never redirect Swipeback traffic. */
export function openAIClient(opts: { apiKey?: string; baseURL?: string; timeoutMs?: number } = {}): OpenAI {
  return new OpenAI({
    apiKey: opts.apiKey ?? '',
    baseURL: opts.baseURL ?? 'https://api.openai.com/v1',
    organization: null,
    project: null,
    timeout: opts.timeoutMs ?? 120_000,
    maxRetries: 2,
  });
}

export function openAICostMicros(model: string, usage: { input_tokens: number; output_tokens: number; input_tokens_details?: { cached_tokens?: number } | null }): number | null {
  const base = model.replace(/-\d{4}-\d{2}-\d{2}$/, ''); // dated snapshots price like their alias
  const price = OPENAI_PRICES[base];
  if (!price) return null; // unknown price: reported as unknown, never guessed
  const cached = usage.input_tokens_details?.cached_tokens ?? 0;
  return Math.round((usage.input_tokens - cached) * price.input + cached * price.cachedInput + usage.output_tokens * price.output);
}

export class OpenAIExtractor implements Extractor {
  readonly name = 'llm' as const;
  readonly model: string;
  private readonly client: ResponsesClient;
  private readonly effort: ReasoningEffort;
  private readonly detail: 'low' | 'high' | 'auto';

  constructor(opts: OpenAIExtractorOptions = {}) {
    this.model = opts.model ?? DEFAULT_OPENAI_MODEL;
    this.effort = opts.reasoningEffort ?? 'medium';
    this.detail = opts.imageDetail ?? 'high';
    this.client = opts.client ?? openAIClient(opts);
  }

  async extract(source: ReceiptSource, _ctx: ExtractionContext): Promise<ExtractionResult> {
    const failed = (error: string, flag: 'EXTRACTION_FAILED' | 'MALFORMED_ATTACHMENT' = 'EXTRACTION_FAILED'): ExtractionResult => ({
      status: 'FAILED', extractor: 'llm', model: this.model, receipt: null, sourceText: null, flags: [flag], error, usage: null,
    });

    // Independent text (PDF text layer / plain text) to verify the model's quotes against.
    let layerText: string | null;
    try {
      layerText = await textFromSource(source);
    } catch (err) {
      if (err instanceof MalformedDocumentError) return failed(err.message, 'MALFORMED_ATTACHMENT');
      throw err;
    }

    type Part = OpenAI.Responses.ResponseInputContent;
    let document: Part;
    if (source.mime === 'application/pdf') {
      document = { type: 'input_file', filename: 'receipt.pdf', file_data: `data:application/pdf;base64,${source.bytes.toString('base64')}` };
    } else if (IMAGE_TYPES.has(source.mime)) {
      document = { type: 'input_image', image_url: `data:${source.mime};base64,${source.bytes.toString('base64')}`, detail: this.detail };
    } else if (layerText !== null) {
      document = { type: 'input_text', text: `<document>\n${layerText}\n</document>` };
    } else {
      return failed(`unsupported document type ${source.mime}`, 'MALFORMED_ATTACHMENT');
    }

    const started = Date.now();
    let response;
    try {
      response = await this.client.responses.parse({
        model: this.model,
        instructions: EXTRACTION_SYSTEM_PROMPT,
        input: [{ role: 'user', content: [document, { type: 'input_text', text: 'Extract the fields from this document.' }] }],
        reasoning: { effort: this.effort },
        max_output_tokens: 16_000,
        store: false, // no retention of synthetic customer documents beyond the request
        text: { format: zodTextFormat(modelOutputSchema, 'receipt_extraction') },
      });
    } catch (err) {
      if (err instanceof OpenAI.RateLimitError || err instanceof OpenAI.InternalServerError || err instanceof OpenAI.APIConnectionError) {
        throw new TransientExtractionError(`${err.name}: ${err.message}`);
      }
      if (err instanceof OpenAI.APIError) return failed(`${err.name} ${err.status}: ${err.message}`);
      if ((err as Error).name === 'MissingCassetteError') return failed((err as Error).message);
      // The SDK raises when the output cannot be parsed against the schema.
      return { ...failed(`invalid model output: ${(err as Error).message}`), status: 'INVALID' };
    }

    const servedBy = response.model ?? this.model;
    const usage = response.usage
      ? {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          latencyMs: Date.now() - started,
          costMicros: openAICostMicros(servedBy, response.usage),
        }
      : null;

    const refusal = response.output
      .flatMap((item) => (item.type === 'message' ? item.content : []))
      .find((c) => c.type === 'refusal');
    if (refusal) return { ...failed('model declined the request'), usage, model: servedBy };
    if (response.status === 'incomplete') {
      return { ...failed(`model output incomplete (${response.incomplete_details?.reason ?? 'unknown'})`), status: 'INVALID', usage, model: servedBy };
    }
    const out = response.output_parsed as ModelOutput | null;
    if (!out) return { ...failed('model output did not match the schema'), status: 'INVALID', usage, model: servedBy };

    const mapped = mapModelOutput(out);
    return {
      status: mapped.receipt ? 'SUCCEEDED' : 'INVALID',
      extractor: 'llm',
      model: servedBy,
      receipt: mapped.receipt,
      // Prefer the independent text layer; for images only the model's own transcription exists.
      sourceText: layerText ?? out.transcription,
      flags: [...mapped.flags],
      error: mapped.error,
      usage,
    };
  }
}
