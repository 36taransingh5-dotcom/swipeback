import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { MessagesClient } from './llm.ts';

/**
 * Record/replay for model calls. In `record` mode real responses are saved; in `replay` mode they
 * are served from disk, so CI exercises the full LLM extraction path (mapping, validation, evidence
 * checks, refusal/truncation handling) deterministically and for free. A cassette is keyed by
 * model, effort, system prompt and document content — change any of them and the recording no
 * longer applies, so stale recordings cannot silently pass.
 */

export interface Cassette {
  key: string;
  recordedAt: string;
  model: string;
  response: {
    model: string;
    stop_reason: string | null;
    usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null };
    parsed_output: unknown;
  };
}

export class MissingCassetteError extends Error {
  override readonly name = 'MissingCassetteError';
}

type ParseParams = Parameters<MessagesClient['beta']['messages']['parse']>[0];

export function cassetteKey(params: ParseParams): string {
  const p = params as { model: string; system?: unknown; messages: unknown; output_config?: { effort?: unknown } };
  return createHash('sha256')
    .update(JSON.stringify({ model: p.model, effort: p.output_config?.effort ?? null, system: p.system ?? null, messages: p.messages }))
    .digest('hex');
}

export function cassetteClient(opts: { dir: string; mode: 'record' | 'replay'; live?: MessagesClient }): MessagesClient {
  const parse = (async (params: ParseParams) => {
    const key = cassetteKey(params);
    const file = path.join(opts.dir, `${key}.json`);
    if (opts.mode === 'replay') {
      let raw: string;
      try {
        raw = await readFile(file, 'utf8');
      } catch {
        throw new MissingCassetteError(`no recorded response for ${key.slice(0, 12)}… (run with SB_EXTRACTOR=record)`);
      }
      return (JSON.parse(raw) as Cassette).response;
    }
    if (!opts.live) throw new Error('record mode needs a live client');
    const response = await opts.live.beta.messages.parse(params);
    const cassette: Cassette = {
      key,
      recordedAt: new Date().toISOString(),
      model: (params as { model: string }).model,
      response: { model: response.model, stop_reason: response.stop_reason, usage: response.usage, parsed_output: response.parsed_output },
    };
    await mkdir(opts.dir, { recursive: true });
    await writeFile(file, `${JSON.stringify(cassette, null, 2)}\n`);
    return response;
  }) as unknown as MessagesClient['beta']['messages']['parse'];
  return { beta: { messages: { parse } } };
}
