import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { DEV_PG_PASSWORD } from './pool.ts';

/**
 * Real Postgres binaries managed from Node (no Docker). Used for local development and tests.
 * Hosted deployments use DATABASE_URL against managed Postgres instead.
 */
export interface EmbeddedCluster {
  readonly port: number;
  url(database: string): string;
  createDatabase(name: string, template?: string): Promise<void>;
  dropDatabase(name: string): Promise<void>;
  stop(): Promise<void>;
}

export interface EmbeddedOptions {
  dataDir: string;
  port: number;
  /** Keep data on stop (dev). Tests use false: the data directory is deleted on stop. */
  persistent: boolean;
  /** Trade durability for speed (tests only). */
  fast?: boolean;
  quiet?: boolean;
}

export async function startEmbeddedPostgres(opts: EmbeddedOptions): Promise<EmbeddedCluster> {
  const dataDir = path.resolve(opts.dataDir);
  await mkdir(path.dirname(dataDir), { recursive: true });
  const log = opts.quiet ? () => undefined : (m: unknown) => console.log('[postgres]', String(m).trim());
  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    port: opts.port,
    user: 'postgres',
    password: DEV_PG_PASSWORD,
    authMethod: 'scram-sha-256',
    persistent: opts.persistent,
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    postgresFlags: [
      '-c', 'listen_addresses=127.0.0.1',
      '-c', 'unix_socket_directories=',
      '-c', 'timezone=UTC',
      ...(opts.fast ? ['-c', 'fsync=off', '-c', 'synchronous_commit=off', '-c', 'full_page_writes=off'] : []),
    ],
    onLog: log,
    onError: opts.quiet ? () => undefined : (m: unknown) => console.error('[postgres]', m),
  });

  if (!existsSync(path.join(dataDir, 'PG_VERSION'))) await pg.initialise();
  await pg.start();

  const url = (database: string) =>
    `postgres://postgres:${encodeURIComponent(DEV_PG_PASSWORD)}@127.0.0.1:${opts.port}/${database}`;

  const admin = async <T>(fn: (c: ReturnType<EmbeddedPostgres['getPgClient']>) => Promise<T>): Promise<T> => {
    const client = pg.getPgClient('postgres', '127.0.0.1');
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  };

  return {
    port: opts.port,
    url,
    async createDatabase(name, template) {
      assertIdentifier(name);
      if (template) assertIdentifier(template);
      await admin(async (c) => {
        const exists = await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
        if (exists.rowCount) return;
        // Concurrent clones of the same template can transiently collide; retry briefly.
        for (let i = 0; ; i++) {
          try {
            await c.query(`CREATE DATABASE "${name}"${template ? ` TEMPLATE "${template}"` : ''}`);
            return;
          } catch (err) {
            if (i >= 20 || !/being accessed by other users/.test((err as Error).message)) throw err;
            await new Promise((r) => setTimeout(r, 50 + Math.random() * 100));
          }
        }
      });
    },
    async dropDatabase(name) {
      assertIdentifier(name);
      await admin((c) => c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`));
    },
    stop: () => pg.stop(),
  };
}

function assertIdentifier(name: string): void {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) throw new Error(`Unsafe database name: ${name}`);
}
