import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EXPENSE_MACHINE, REIMBURSEMENT_MACHINE, STATE_MACHINES } from '@swipeback/domain';
import { readdir } from 'node:fs/promises';
import { migrate, MIGRATIONS_DIR, resetSchema } from '@swipeback/db';
import { createTestDatabase, type TestDatabase } from '../../../test/support/db.ts';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => db.drop());

describe('migrations', () => {
  it('re-running migrate on an up-to-date database is a no-op', async () => {
    const r = await migrate(db.pool);
    expect(r.applied).toEqual([]);
    expect(r.alreadyApplied).toContain('0001_core.sql');
  });

  it('reset + migrate reproduces the same schema', async () => {
    const snapshot = async () =>
      (
        await db.pool.query<{ t: string }>(
          `SELECT table_name || '.' || column_name || ':' || data_type AS t
             FROM information_schema.columns WHERE table_schema IN ('public', 'mockpay') ORDER BY 1`,
        )
      ).rows.map((r) => r.t);
    const before = await snapshot();
    await resetSchema(db.pool);
    expect(await snapshot()).toEqual([]);
    const r = await migrate(db.pool);
    expect(r.applied).toEqual((await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort());
    expect(await snapshot()).toEqual(before);
  });

  it('rejects a modified, already-applied migration', async () => {
    await db.pool.query(`UPDATE schema_migrations SET checksum = repeat('0', 64) WHERE name = '0001_core.sql'`);
    await expect(migrate(db.pool)).rejects.toThrow(/checksum mismatch/);
    await resetSchema(db.pool);
    await migrate(db.pool);
  });

  it('database transition table matches the domain state machines exactly', async () => {
    const { rows } = await db.pool.query<{ machine: string; from_state: string; to_state: string }>(
      'SELECT machine, from_state, to_state FROM state_transitions ORDER BY 1, 2, 3',
    );
    const expected = STATE_MACHINES.flatMap((m) => m.transitions.map(([f, t]) => ({ machine: m.name, from_state: f, to_state: t })))
      .sort((a, b) => (a.machine + a.from_state + a.to_state).localeCompare(b.machine + b.from_state + b.to_state));
    expect(rows).toEqual(expected);
    const initials = await db.pool.query('SELECT machine, initial_state FROM state_machines ORDER BY machine');
    expect(initials.rows).toEqual([
      { machine: EXPENSE_MACHINE.name, initial_state: EXPENSE_MACHINE.initial },
      { machine: REIMBURSEMENT_MACHINE.name, initial_state: REIMBURSEMENT_MACHINE.initial },
    ]);
  });
});
