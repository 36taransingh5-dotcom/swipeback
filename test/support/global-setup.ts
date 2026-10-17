import { randomBytes } from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import type { TestProject } from 'vitest/node';
import { createPool, migrate } from '@swipeback/db';
import { startEmbeddedPostgres, type EmbeddedCluster } from '@swipeback/db/embedded';

export const TEMPLATE_DB = 'sb_test_template';

declare module 'vitest' {
  export interface ProvidedContext {
    pgAdminUrl: string;
    pgTemplateDb: string;
  }
}

let cluster: EmbeddedCluster | undefined;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      srv.close(() => (typeof addr === 'object' && addr ? resolve(addr.port) : reject(new Error('no port'))));
    });
  });
}

/** One throwaway Postgres cluster per test run; each test file clones a migrated template database. */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const port = await freePort();
  const dataDir = path.resolve('.data/test', `pg-${process.pid}-${randomBytes(3).toString('hex')}`);
  cluster = await startEmbeddedPostgres({ dataDir, port, persistent: false, fast: true, quiet: true });

  await cluster.createDatabase(TEMPLATE_DB);
  const pool = createPool(cluster.url(TEMPLATE_DB), 2);
  try {
    await migrate(pool);
  } finally {
    await pool.end();
  }

  project.provide('pgAdminUrl', cluster.url('postgres'));
  project.provide('pgTemplateDb', TEMPLATE_DB);

  return async () => {
    await cluster?.stop();
  };
}
