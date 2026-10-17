import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { MessagesClient } from './llm.ts';
import type { ResponsesClient } from './openai.ts';

/**
 * Record/replay for model calls, for any provider. In `record` mode real responses are saved; in
 * `replay` mode they are served from disk, so CI exercises the full extraction path (mapping,
 * validation, evidence checks, refusal/truncation handling) deterministically and for free.
 * A cassette is keyed by provider, model, reasoning settings, prompt and document content — change
 * any of them and the recording no longer applies, so stale recordings cannot silently pass.
 */

export interface Cassette {
  key: string;
  provider: string;
  recordedAt: string;
  response: unknown;
}

export class MissingCassetteError extends Error {
  override readonly name = 'MissingCassetteError';
}

export type CassetteMode = 'record' | 'replay';

export function cassetteKey(material: unknown): string {
  return createHash('sha256').update(JSON.stringify(material)).digest('hex');
}

export class CassetteStore {
  constructor(
    readonly dir: string,
    readonly mode: CassetteMode,
  ) {}

  async run<T>(provider: string, material: unknown, live: (() => Promise<T>) | null, keep: (response: T) => unknown = (r) => r): Promise<unknown> {
    const key = cassetteKey({ provider, ...(material as object) });
    const file = path.join(this.dir, `${key}.json`);
    if (this.mode === 'replay') {
      let raw: string;
      try {
        raw = await readFile(file, 'utf8');
      } catch {
        throw new MissingCassetteError(`no recorded ${provider} response for ${key.slice(0, 12)}… (record it with SB_CASSETTES=record)`);
      }
      return (JSON.parse(raw) as Cassette).response;
    }
    if (!live) throw new Error('record mode needs a live client');
    const response = await live();
    const cassette: Cassette = { key, provider, recordedAt: new Date().toISOString(), response: keep(response) };
    await mkdir(this.dir, { recursive: true });
    await writeFile(file, `${JSON.stringify(cassette, null, 2)}\n`);
    return response;
  }
}

type AnthropicParams = Parameters<MessagesClient['beta']['messages']['parse']>[0];

/** Anthropic Messages client backed by cassettes. */
export function cassetteClient(opts: { dir: string; mode: CassetteMode; live?: MessagesClient }): MessagesClient {
  const store = new CassetteStore(opts.dir, opts.mode);
  const parse = (async (params: AnthropicParams) => {
    const p = params as { model: string; system?: unknown; messages: unknown; output_config?: { effort?: unknown } };
    return store.run(
      'anthropic',
      { model: p.model, effort: p.output_config?.effort ?? null, system: p.system ?? null, messages: p.messages },
      opts.live ? () => opts.live!.beta.messages.parse(params) : null,
      (r) => ({ model: r.model, stop_reason: r.stop_reason, usage: r.usage, parsed_output: r.parsed_output }),
    );
  }) as unknown as MessagesClient['beta']['messages']['parse'];
  return { beta: { messages: { parse } } };
}

type OpenAIParams = Parameters<ResponsesClient['responses']['parse']>[0];

/** OpenAI Responses client backed by cassettes. */
export function openAICassetteClient(opts: { dir: string; mode: CassetteMode; live?: ResponsesClient }): ResponsesClient {
  const store = new CassetteStore(opts.dir, opts.mode);
  const parse = (async (params: OpenAIParams) => {
    const p = params as { model: string; instructions?: unknown; input: unknown; reasoning?: unknown };
    return store.run(
      'openai',
      { model: p.model, reasoning: p.reasoning ?? null, instructions: p.instructions ?? null, input: p.input },
      opts.live ? () => opts.live!.responses.parse(params) : null,
      (r) => ({ model: r.model, status: r.status, incomplete_details: r.incomplete_details, usage: r.usage, output: r.output, output_parsed: r.output_parsed }),
    );
  }) as unknown as ResponsesClient['responses']['parse'];
  return { responses: { parse } };
}
