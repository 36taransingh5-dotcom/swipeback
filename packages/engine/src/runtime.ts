import path from 'node:path';
import { DirectorySink, FixtureEmailAdapter, GmailAdapter, LocalEvidenceStore, SyntheticChatAdapter } from '@swipeback/channels';
import { createPool, databaseUrl, isLocalDatabaseUrl, type Pool } from '@swipeback/db';
import {
  anthropicClient,
  BaselineExtractor,
  cassetteClient,
  DEFAULT_OPENAI_MODEL,
  LlmExtractor,
  openAICassetteClient,
  openAIClient,
  OpenAIExtractor,
  type Extractor,
  type ReasoningEffort,
} from '@swipeback/extraction';
import { MockPayProvider } from '@swipeback/payouts';
import { channelRegistry, systemClock, type EngineDeps } from './deps.ts';
import { slackAdapterFromEnv } from './slack.ts';
import { GmailTokens, type GmailRuntime } from './gmail.ts';
import { TokenCipher } from './secrets.ts';
import { TrueLayerSandboxTokens, trueLayerSandboxRuntimeFromEnv, type TrueLayerSandboxRuntime } from './truelayer-sandbox.ts';

/** Load .env.local / .env if present (never required; never printed). */
export function loadLocalEnv(): void {
  for (const file of ['.env.local', '.env']) {
    try {
      process.loadEnvFile(file);
    } catch {
      // absent: fine
    }
  }
}

function secret(env: NodeJS.ProcessEnv, name: string, devDefault: string): string {
  const v = env[name];
  if (v && v.length >= 16) return v;
  if (isLocalDatabaseUrl(databaseUrl())) return devDefault; // local development only
  throw new Error(`${name} must be set (>= 16 chars) outside local development`);
}

export const CASSETTE_DIR = path.resolve('eval/cassettes');

export type ExtractorProvider = 'openai' | 'anthropic' | 'baseline';

/**
 * Extraction provider selection:
 *   SB_EXTRACTOR = openai | anthropic | baseline  (or `llm` + SB_LLM_PROVIDER=openai|anthropic)
 *   default: openai if SB_OPENAI_API_KEY is set, else anthropic if SB_ANTHROPIC_API_KEY, else baseline.
 *   SB_CASSETTES = off (default) | record (live calls saved) | replay (recorded responses only, no network).
 *   OpenAI: SB_OPENAI_MODEL (default gpt-5.5), SB_OPENAI_REASONING_EFFORT (default medium).
 *   Anthropic: SB_EXTRACTION_MODEL (default claude-opus-5-5), SB_EXTRACTION_EFFORT (default medium).
 */
export function resolveProvider(env: NodeJS.ProcessEnv = process.env): ExtractorProvider {
  const raw = (env.SB_EXTRACTOR ?? '').toLowerCase();
  const chosen = raw === 'llm' ? (env.SB_LLM_PROVIDER ?? 'openai').toLowerCase() : raw;
  if (chosen === 'openai' || chosen === 'anthropic' || chosen === 'baseline') return chosen;
  if (chosen) throw new Error(`unknown extraction provider "${chosen}" (use openai, anthropic or baseline)`);
  return env.SB_OPENAI_API_KEY ? 'openai' : env.SB_ANTHROPIC_API_KEY ? 'anthropic' : 'baseline';
}

export function createExtractor(env: NodeJS.ProcessEnv = process.env, overrides: { model?: string } = {}): Extractor {
  const provider = resolveProvider(env);
  const cassettes = (env.SB_CASSETTES ?? 'off') as 'off' | 'record' | 'replay';
  if (!['off', 'record', 'replay'].includes(cassettes)) throw new Error(`SB_CASSETTES must be off, record or replay`);
  const key = (name: string) => {
    const v = env[name];
    if (!v && cassettes !== 'replay') throw new Error(`${provider} extraction needs ${name}`);
    return v ?? '';
  };
  if (provider === 'baseline') return new BaselineExtractor();

  if (provider === 'openai') {
    const opts = {
      model: overrides.model ?? env.SB_OPENAI_MODEL ?? DEFAULT_OPENAI_MODEL,
      ...(env.SB_OPENAI_REASONING_EFFORT ? { reasoningEffort: env.SB_OPENAI_REASONING_EFFORT as ReasoningEffort } : {}),
    };
    const live = () => openAIClient({ apiKey: key('SB_OPENAI_API_KEY'), ...(env.SB_OPENAI_BASE_URL ? { baseURL: env.SB_OPENAI_BASE_URL } : {}) });
    if (cassettes === 'off') return new OpenAIExtractor({ ...opts, client: live() });
    return new OpenAIExtractor({ ...opts, client: openAICassetteClient({ dir: CASSETTE_DIR, mode: cassettes, ...(cassettes === 'record' ? { live: live() } : {}) }) });
  }

  const anthropicModel = overrides.model ?? env.SB_EXTRACTION_MODEL;
  const opts = {
    ...(anthropicModel ? { model: anthropicModel } : {}),
    ...(env.SB_EXTRACTION_EFFORT ? { effort: env.SB_EXTRACTION_EFFORT as 'low' | 'medium' | 'high' } : {}),
  };
  const live = () => anthropicClient({ apiKey: key('SB_ANTHROPIC_API_KEY'), ...(env.SB_ANTHROPIC_BASE_URL ? { baseURL: env.SB_ANTHROPIC_BASE_URL } : {}) });
  if (cassettes === 'off') return new LlmExtractor({ ...opts, client: live() });
  return new LlmExtractor({ ...opts, client: cassetteClient({ dir: CASSETTE_DIR, mode: cassettes, ...(cassettes === 'record' ? { live: live() } : {}) }) });
}

export interface Runtime {
  pool: Pool;
  deps: EngineDeps;
  outboxDir: string;
  /** Present when Google OAuth and the token key are configured. */
  gmail: (GmailRuntime & { tokens: GmailTokens }) | null;
  truelayer: (TrueLayerSandboxRuntime & { tokens: TrueLayerSandboxTokens }) | null;
}

export function gmailRuntimeFromEnv(env: NodeJS.ProcessEnv): GmailRuntime | null {
  const { GOOGLE_OAUTH_CLIENT_ID: clientId, GOOGLE_OAUTH_CLIENT_SECRET: clientSecret, GOOGLE_OAUTH_REDIRECT_URI: redirectUri, SB_TOKEN_ENCRYPTION_KEY: key } = env;
  if (!clientId || !clientSecret || !redirectUri) return null;
  if (!key) throw new Error('SB_TOKEN_ENCRYPTION_KEY is required to store mailbox tokens (openssl rand -base64 32)');
  return { oauth: { clientId, clientSecret, redirectUri }, cipher: new TokenCipher(key), fetch };
}

/** Wire the engine from the environment. Used by the worker, the CLI and (later) the web app. */
export function createRuntime(env: NodeJS.ProcessEnv = process.env): Runtime {
  const pool = createPool(databaseUrl(), Number(env.SB_DB_POOL_SIZE ?? 10));
  const dataDir = path.resolve(env.SB_DATA_DIR ?? '.data');
  const evidence = new LocalEvidenceStore(path.join(dataDir, 'evidence'));
  const outboxDir = path.join(dataDir, 'outbox');
  const sink = new DirectorySink(outboxDir);
  const slack = slackAdapterFromEnv(env, evidence);
  const g = gmailRuntimeFromEnv(env);
  const gmail = g ? { ...g, tokens: new GmailTokens(pool, g) } : null;
  const tl = trueLayerSandboxRuntimeFromEnv(env);
  const truelayer = tl ? { ...tl, tokens: new TrueLayerSandboxTokens(pool, tl) } : null;
  const deps: EngineDeps = {
    pool,
    clock: systemClock,
    extractor: createExtractor(env),
    payouts: new MockPayProvider(pool),
    channels: channelRegistry([
      new FixtureEmailAdapter(evidence, sink),
      ...(slack ? [slack] : []),
      new SyntheticChatAdapter(evidence, sink, secret(env, 'SB_SYNTHETIC_CHAT_SECRET', 'dev-only-synthetic-chat-secret')),
      ...(gmail ? [new GmailAdapter(evidence, async (id) => gmail.tokens.api(id))] : []),
    ]),
    evidence,
    config: {
      appUrl: env.SB_APP_URL ?? 'http://localhost:3000',
      cardFeedSecret: secret(env, 'SB_CARD_FEED_SECRET', 'dev-only-card-feed-secret'),
      ...(env.SB_RECEIPT_GRACE_MINUTES ? { receiptGraceMinutes: Number(env.SB_RECEIPT_GRACE_MINUTES) } : {}),
      ...(env.SB_QUESTION_REMINDER_MINUTES ? { questionReminderMinutes: Number(env.SB_QUESTION_REMINDER_MINUTES) } : {}),
      ...(env.SB_QUESTION_EXPIRY_MINUTES ? { questionExpiryMinutes: Number(env.SB_QUESTION_EXPIRY_MINUTES) } : {}),
    },
  };
  return { pool, deps, outboxDir, gmail, truelayer };
}
