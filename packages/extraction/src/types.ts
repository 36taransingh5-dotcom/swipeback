import { z } from 'zod';
import { CATEGORIES, type IntegrityFlag } from '@swipeback/domain';

/**
 * The shared extraction result. Every extractor (rule-only baseline, LLM, recorded replay) must
 * produce exactly this shape; the engine validates it and decides nothing from free text.
 * Each field carries a confidence and a pointer to the source text it came from.
 */

export const evidenceSchema = z.object({
  source: z.enum(['attachment', 'body']),
  quote: z.string().min(1).max(500),
});
export type Evidence = z.infer<typeof evidenceSchema>;

const field = <T extends z.ZodType>(value: T) =>
  z.object({ value: value.nullable(), confidence: z.number().min(0).max(1), evidence: evidenceSchema.nullable() });

export const extractedReceiptSchema = z.object({
  merchant: field(z.string().min(1).max(200)),
  total: field(z.object({ amountMinor: z.number().int(), currency: z.string().regex(/^[A-Z]{3}$/) })),
  subtotal: field(z.object({ amountMinor: z.number().int() })),
  tax: field(z.object({ amountMinor: z.number().int().nonnegative() })),
  date: field(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
  vatNumber: field(z.string().max(32)),
  receiptNumber: field(z.string().max(64)),
  cardLast4: field(z.string().regex(/^\d{4}$/)),
  tender: field(z.enum(['CARD', 'CASH'])),
  category: field(z.enum(CATEGORIES)),
  lineItems: z.array(z.object({ description: z.string().max(200), amountMinor: z.number().int() })).max(100),
});
export type ExtractedReceipt = z.infer<typeof extractedReceiptSchema>;
export type ExtractedField<T> = { value: T | null; confidence: number; evidence: Evidence | null };

export interface ReceiptSource {
  kind: 'ATTACHMENT' | 'EMAIL_BODY';
  mime: string;
  bytes: Buffer;
  sha256: string;
}

export interface ExtractionContext {
  /** The sender's own message text (untrusted). Used for injection screening and stated purpose only. */
  senderText: string;
  subject: string | null;
}

export type ExtractorName = 'baseline' | 'llm' | 'stub' | 'replay';

export interface ExtractionResult {
  status: 'SUCCEEDED' | 'FAILED' | 'INVALID';
  extractor: ExtractorName;
  model: string | null;
  receipt: ExtractedReceipt | null;
  /** Text the extractor read (text layer / transcription), used to verify evidence quotes. */
  sourceText: string | null;
  flags: IntegrityFlag[];
  error: string | null;
  /** costMicros is null when the model's price is unknown (never guessed). */
  usage: { inputTokens: number; outputTokens: number; latencyMs: number; costMicros: number | null } | null;
}

export interface Extractor {
  readonly name: ExtractorName;
  extract(source: ReceiptSource, ctx: ExtractionContext): Promise<ExtractionResult>;
}

/** Transient failures (timeouts, provider 5xx) are retried by the job runner, then fail closed. */
export class TransientExtractionError extends Error {
  override readonly name = 'TransientExtractionError';
}
