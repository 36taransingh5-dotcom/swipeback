import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { EXTRACTION_SYSTEM_PROMPT, mapModelOutput, modelOutputSchema } from './model-contract.ts';
import { MalformedDocumentError } from './pdf.ts';
import { textFromSource } from './text.ts';
import {
  TransientExtractionError,
  type ExtractionContext,
  type ExtractionResult,
  type Extractor,
  type ReceiptSource,
} from './types.ts';

/**
 * Claude (Anthropic) receipt extraction. The model reads messy receipts (photos, scans, PDFs, e-receipts)
 * and *proposes* typed fields, each with a confidence and a verbatim quote. It decides nothing:
 * the deterministic checks in checks.ts verify the quotes, the arithmetic and the identity of the
 * document, and the policy engine makes every decision.
 */

export const DEFAULT_EXTRACTION_MODEL = 'claude-opus-5-5';

/** USD per million tokens (Anthropic first-party pricing, cached 2026-10-06). Override via env for other models. */
export const MODEL_PRICES: Readonly<Record<string, { input: number; output: number }>> = {
  'claude-opus-5-5': { input: 4, output: 20 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
};

/** The subset of the SDK the extractor needs; injectable for tests. */
export interface MessagesClient {
  beta: { messages: { parse: Anthropic['beta']['messages']['parse'] } };
}

export interface LlmExtractorOptions {
  client?: MessagesClient;
  apiKey?: string;
  baseURL?: string;
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  timeoutMs?: number;
  /** Server-side refusal fallback (Claude API only). On by default. */
  fallbacks?: boolean;
}

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

export class LlmExtractor implements Extractor {
  readonly name = 'llm' as const;
  readonly model: string;
  private readonly client: MessagesClient;
  private readonly effort: NonNullable<LlmExtractorOptions['effort']>;
  private readonly fallbacks: boolean;

  constructor(opts: LlmExtractorOptions = {}) {
    this.model = opts.model ?? DEFAULT_EXTRACTION_MODEL;
    this.effort = opts.effort ?? 'medium';
    this.fallbacks = opts.fallbacks ?? true;
    this.client = opts.client ?? anthropicClient(opts);
  }

  async extract(source: ReceiptSource, _ctx: ExtractionContext): Promise<ExtractionResult> {
    const failed = (error: string, flag: 'EXTRACTION_FAILED' | 'MALFORMED_ATTACHMENT' = 'EXTRACTION_FAILED', sourceText: string | null = null): ExtractionResult => ({
      status: 'FAILED', extractor: 'llm', model: this.model, receipt: null, sourceText, flags: [flag], error, usage: null,
    });

    // Independent text (PDF text layer / plain text) to verify the model's quotes against.
    let layerText: string | null;
    try {
      layerText = await textFromSource(source);
    } catch (err) {
      if (err instanceof MalformedDocumentError) return failed(err.message, 'MALFORMED_ATTACHMENT');
      throw err;
    }

    let content: Anthropic.Beta.BetaContentBlockParam[];
    if (source.mime === 'application/pdf') {
      content = [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: source.bytes.toString('base64') } }];
    } else if (IMAGE_TYPES.has(source.mime)) {
      content = [{ type: 'image', source: { type: 'base64', media_type: source.mime as 'image/png', data: source.bytes.toString('base64') } }];
    } else if (layerText !== null) {
      content = [{ type: 'text', text: `<document>\n${layerText}\n</document>` }];
    } else {
      return failed(`unsupported document type ${source.mime}`, 'MALFORMED_ATTACHMENT');
    }
    content.push({ type: 'text', text: 'Extract the fields from this document.' });

    const started = Date.now();
    let response;
    try {
      response = await this.client.beta.messages.parse({
        model: this.model,
        max_tokens: 16_000,
        system: EXTRACTION_SYSTEM_PROMPT,
        messages: [{ role: 'user', content }],
        output_config: { effort: this.effort, format: betaZodOutputFormat(modelOutputSchema) },
        ...(this.fallbacks ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
      });
    } catch (err) {
      if (
        err instanceof Anthropic.RateLimitError ||
        err instanceof Anthropic.InternalServerError ||
        err instanceof Anthropic.APIConnectionError // includes APIConnectionTimeoutError
      ) {
        throw new TransientExtractionError(`${err.name}: ${err.message}`);
      }
      if (err instanceof Anthropic.APIError) return failed(`${err.name} ${err.status}: ${err.message}`);
      if ((err as Error).name === 'MissingCassetteError') return failed((err as Error).message);
      // The SDK raises when the structured output does not match the schema.
      return { ...failed(`invalid model output: ${(err as Error).message}`), status: 'INVALID' };
    }

    const usage = {
      inputTokens: response.usage.input_tokens + (response.usage.cache_read_input_tokens ?? 0) + (response.usage.cache_creation_input_tokens ?? 0),
      outputTokens: response.usage.output_tokens,
      latencyMs: Date.now() - started,
      costMicros: costMicros(response.model ?? this.model, response.usage),
    };
    const servedBy = response.model ?? this.model;

    if (response.stop_reason === 'refusal') return { ...failed('model declined the request'), usage, model: servedBy };
    if (response.stop_reason === 'max_tokens') return { ...failed('model output truncated'), status: 'INVALID', usage, model: servedBy };
    const out = response.parsed_output;
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

/** Explicit credentials and endpoint: ambient ANTHROPIC_* shell variables never redirect Swipeback traffic. */
export function anthropicClient(opts: { apiKey?: string; baseURL?: string; timeoutMs?: number } = {}): Anthropic {
  return new Anthropic({
    apiKey: opts.apiKey ?? null,
    baseURL: opts.baseURL ?? 'https://api.anthropic.com',
    timeout: opts.timeoutMs ?? 90_000,
    maxRetries: 2,
  });
}

export function costMicros(model: string, usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }): number {
  const price = MODEL_PRICES[model] ?? MODEL_PRICES[DEFAULT_EXTRACTION_MODEL]!;
  // $X per million tokens == X micro-dollars per token. Cache reads 0.1x, writes 1.25x.
  const input = usage.input_tokens + (usage.cache_read_input_tokens ?? 0) * 0.1 + (usage.cache_creation_input_tokens ?? 0) * 1.25;
  return Math.round(input * price.input + usage.output_tokens * price.output);
}

