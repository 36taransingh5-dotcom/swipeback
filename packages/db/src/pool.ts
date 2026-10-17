import pg from 'pg';

// int8 (bigint/bigserial) -> number, but only when exactly representable. Money is minor units, so
// values beyond 2^53 would indicate corruption rather than a real expense.
pg.types.setTypeParser(pg.types.builtins.INT8, (value: string) => {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new RangeError(`int8 value ${value} exceeds safe integer range`);
  return n;
});
// DATE stays a 'YYYY-MM-DD' string: no implicit timezone conversion of calendar dates.
pg.types.setTypeParser(pg.types.builtins.DATE, (value: string) => value);

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;
export type Queryable = pg.Pool | pg.PoolClient;

export const DEV_PG_PORT = 54329;
export const DEV_PG_PASSWORD = 'swipeback-local-only';

export function databaseUrl(): string {
  return process.env.DATABASE_URL ?? `postgres://postgres:${DEV_PG_PASSWORD}@127.0.0.1:${DEV_PG_PORT}/swipeback`;
}

export function createPool(url: string = databaseUrl(), max = 10): pg.Pool {
  const pool = new pg.Pool({ connectionString: url, max, application_name: 'swipeback' });
  // An idle client erroring (e.g. server restart) must not crash the process.
  pool.on('error', (err) => console.error('[db] idle client error:', err.message));
  return pool;
}

export type Isolation = 'read committed' | 'repeatable read' | 'serializable';

const RETRYABLE_SQLSTATES = new Set(['40001', '40P01']); // serialization_failure, deadlock_detected

/**
 * Run `fn` inside a transaction. Serialization failures and deadlocks are retried with backoff;
 * everything else rolls back and rethrows.
 */
export async function withTransaction<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
  opts: { isolation?: Isolation; retries?: number } = {},
): Promise<T> {
  const { isolation = 'read committed', retries = 3 } = opts;
  for (let attempt = 0; ; attempt++) {
    const client = await pool.connect();
    try {
      await client.query(`BEGIN ISOLATION LEVEL ${isolation.toUpperCase()}`);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (attempt < retries && isPgError(err) && RETRYABLE_SQLSTATES.has(err.code)) {
        await new Promise((r) => setTimeout(r, 10 * 2 ** attempt + Math.random() * 10));
        continue;
      }
      throw err;
    } finally {
      client.release();
    }
  }
}

export interface PgError extends Error {
  code: string;
  constraint?: string;
  detail?: string;
}

export function isPgError(err: unknown): err is PgError {
  return err instanceof Error && typeof (err as { code?: unknown }).code === 'string';
}

/** Our custom SQLSTATEs raised by invariant triggers (see migrations/0001_core.sql). */
export const SQLSTATE = {
  illegalTransition: 'SBT01',
  appendOnly: 'SBA01',
  invariant: 'SBI01',
  uniqueViolation: '23505',
} as const;
