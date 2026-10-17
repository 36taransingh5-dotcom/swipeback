import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { inject } from 'vitest';
import { createPool, type Pool } from '@swipeback/db';

export interface TestDatabase {
  pool: Pool;
  url: string;
  name: string;
  /** Superuser connection to the same database, for tests that deliberately bypass triggers. */
  superuserQuery(sql: string, params?: unknown[]): Promise<pg.QueryResult>;
  drop(): Promise<void>;
}

/** Create an isolated, fully migrated database for one test file. */
export async function createTestDatabase(maxConnections = 10): Promise<TestDatabase> {
  const adminUrl = inject('pgAdminUrl');
  const template = inject('pgTemplateDb');
  const name = `sb_t_${randomBytes(6).toString('hex')}`;

  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    for (let i = 0; ; i++) {
      try {
        await admin.query(`CREATE DATABASE "${name}" TEMPLATE "${template}"`);
        break;
      } catch (err) {
        if (i >= 30 || !/being accessed by other users/.test((err as Error).message)) throw err;
        await new Promise((r) => setTimeout(r, 50 + Math.random() * 100));
      }
    }
  } finally {
    await admin.end();
  }

  const url = adminUrl.replace(/\/postgres$/, `/${name}`);
  const pool = createPool(url, maxConnections);
  return {
    pool,
    url,
    name,
    superuserQuery: (sql, params) => pool.query(sql, params),
    async drop() {
      await pool.end();
      const c = new pg.Client({ connectionString: adminUrl });
      await c.connect();
      try {
        await c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      } finally {
        await c.end();
      }
    },
  };
}
