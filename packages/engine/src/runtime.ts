import path from 'node:path';
import { DirectorySink, FixtureEmailAdapter, LocalEvidenceStore, SyntheticChatAdapter } from '@swipeback/channels';
import { createPool, databaseUrl, isLocalDatabaseUrl, type Pool } from '@swipeback/db';
import { BaselineExtractor } from '@swipeback/extraction';
import { MockPayProvider } from '@swipeback/payouts';
import { channelRegistry, systemClock, type EngineDeps } from './deps.ts';

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

export interface Runtime {
  pool: Pool;
  deps: EngineDeps;
  outboxDir: string;
}

/** Wire the engine from the environment. Used by the worker, the CLI and (later) the web app. */
export function createRuntime(env: NodeJS.ProcessEnv = process.env): Runtime {
  const pool = createPool(databaseUrl(), Number(env.SB_DB_POOL_SIZE ?? 10));
  const dataDir = path.resolve(env.SB_DATA_DIR ?? '.data');
  const evidence = new LocalEvidenceStore(path.join(dataDir, 'evidence'));
  const outboxDir = path.join(dataDir, 'outbox');
  const sink = new DirectorySink(outboxDir);
  const deps: EngineDeps = {
    pool,
    clock: systemClock,
    extractor: new BaselineExtractor(),
    payouts: new MockPayProvider(pool),
    channels: channelRegistry([
      new FixtureEmailAdapter(evidence, sink),
      new SyntheticChatAdapter(evidence, sink, secret(env, 'SB_SYNTHETIC_CHAT_SECRET', 'dev-only-synthetic-chat-secret')),
    ]),
    evidence,
    config: {
      appUrl: env.SB_APP_URL ?? 'http://localhost:3000',
      cardFeedSecret: secret(env, 'SB_CARD_FEED_SECRET', 'dev-only-card-feed-secret'),
    },
  };
  return { pool, deps, outboxDir };
}
