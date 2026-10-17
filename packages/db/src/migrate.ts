import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { STATE_MACHINES } from '@swipeback/domain';
import type { Pool, PoolClient } from './pool.ts';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));
const MIGRATION_LOCK_KEY = 7_342_001; // arbitrary constant for pg_advisory_lock

export interface MigrationResult {
  applied: string[];
  alreadyApplied: string[];
}

/**
 * Apply pending SQL migrations in order, each in its own transaction, then sync the state machine
 * tables from packages/domain. Re-running is a no-op. A changed checksum for an applied migration
 * is an error: migrations are append-only.
 */
export async function migrate(pool: Pool, migrationsDir = MIGRATIONS_DIR): Promise<MigrationResult> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, checksum char(64) NOT NULL, applied_at timestamptz NOT NULL DEFAULT clock_timestamp())`);

    const files = (await readdir(migrationsDir)).filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f)).sort();
    const { rows } = await client.query<{ name: string; checksum: string }>('SELECT name, checksum FROM schema_migrations');
    const applied = new Map(rows.map((r) => [r.name, r.checksum]));
    const result: MigrationResult = { applied: [], alreadyApplied: [] };

    for (const file of files) {
      const sql = await readFile(path.join(migrationsDir, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const existing = applied.get(file);
      if (existing !== undefined) {
        if (existing !== checksum) {
          throw new Error(`Migration ${file} was modified after being applied (checksum mismatch). Add a new migration instead.`);
        }
        result.alreadyApplied.push(file);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [file, checksum]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`, { cause: err });
      }
      result.applied.push(file);
    }

    await syncStateMachines(client);
    return result;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => undefined);
    client.release();
  }
}

/** Copy the domain transition tables into Postgres so triggers enforce exactly the same rules. */
export async function syncStateMachines(client: PoolClient): Promise<void> {
  await client.query('BEGIN');
  try {
    await client.query('DELETE FROM state_transitions');
    for (const m of STATE_MACHINES) {
      await client.query(
        `INSERT INTO state_machines (machine, initial_state) VALUES ($1, $2)
         ON CONFLICT (machine) DO UPDATE SET initial_state = EXCLUDED.initial_state`,
        [m.name, m.initial],
      );
      for (const [from, to] of m.transitions) {
        await client.query('INSERT INTO state_transitions (machine, from_state, to_state) VALUES ($1, $2, $3)', [
          m.name,
          from,
          to,
        ]);
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

/** Drop and recreate the public schema. Callers must guard against non-local databases. */
export async function resetSchema(pool: Pool): Promise<void> {
  await pool.query('DROP SCHEMA IF EXISTS public CASCADE');
  await pool.query('CREATE SCHEMA public');
}

export function isLocalDatabaseUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  } catch {
    return false;
  }
}
