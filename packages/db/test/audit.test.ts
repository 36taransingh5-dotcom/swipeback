import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appendAudit, isPgError, SQLSTATE, verifyAuditChain } from '@swipeback/db';
import { seedDemoOrg, type SeededOrg } from '@swipeback/cli/seed';
import { createTestDatabase, type TestDatabase } from '../../../test/support/db.ts';

let db: TestDatabase;
let org: SeededOrg;
beforeAll(async () => {
  db = await createTestDatabase(20);
  org = await seedDemoOrg(db.pool);
});
afterAll(async () => db.drop());

async function sqlstate(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (err) {
    return isPgError(err) ? err.code : 'NOT_PG_ERROR';
  }
}

describe('audit log', () => {
  it('assigns a gapless sequence and a valid hash chain, even under concurrent appends', async () => {
    const seeded = (await verifyAuditChain(db.pool, org.organisationId)).checked;
    await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        appendAudit(db.pool, {
          organisationId: org.organisationId,
          actorType: 'system',
          action: 'test.event',
          entityType: 'test',
          entityId: String(i),
          after: { i, nested: { b: 2, a: 1 } },
        }),
      ),
    );
    const report = await verifyAuditChain(db.pool, org.organisationId);
    expect(report.ok).toBe(true);
    expect(report.checked).toBe(seeded + 50);
    const seqs = (await db.pool.query<{ seq: number }>('SELECT seq FROM audit_events WHERE organisation_id = $1 ORDER BY seq', [org.organisationId])).rows.map((r) => r.seq);
    expect(seqs).toEqual(Array.from({ length: seeded + 50 }, (_, i) => i + 1));
  });

  it('Postgres rejects UPDATE, DELETE and TRUNCATE on audit_events', async () => {
    expect(await sqlstate(db.pool.query(`UPDATE audit_events SET action = 'x'`))).toBe(SQLSTATE.appendOnly);
    expect(await sqlstate(db.pool.query('DELETE FROM audit_events'))).toBe(SQLSTATE.appendOnly);
    expect(await sqlstate(db.pool.query('TRUNCATE audit_events'))).toBe(SQLSTATE.appendOnly);
  });

  it('callers cannot forge sequence, timestamp or hash', async () => {
    await db.pool.query(
      `INSERT INTO audit_events (organisation_id, seq, actor_type, action, entity_type, created_at, prev_hash, hash)
       VALUES ($1, 9999, 'system', 'forged', 'test', '2000-01-01', repeat('a', 64), repeat('b', 64))`,
      [org.organisationId],
    );
    const row = (await db.pool.query(`SELECT seq, created_at, hash FROM audit_events WHERE action = 'forged'`)).rows[0];
    expect(row.seq).not.toBe(9999);
    expect(row.created_at.getFullYear()).toBeGreaterThan(2000);
    expect(row.hash).not.toBe('b'.repeat(64));
    expect((await verifyAuditChain(db.pool, org.organisationId)).ok).toBe(true);
  });

  it('the verifier detects a row altered or deleted behind the triggers', async () => {
    // Simulate a privileged attacker bypassing the append-only trigger.
    await db.superuserQuery('ALTER TABLE audit_events DISABLE TRIGGER audit_events_immutable');
    try {
      await db.superuserQuery(
        `UPDATE audit_events SET after = '{"i": 999}' WHERE organisation_id = $1 AND seq = 10`,
        [org.organisationId],
      );
      let report = await verifyAuditChain(db.pool, org.organisationId);
      expect(report.ok).toBe(false);
      expect(report.problems).toContainEqual({ seq: 10, problem: 'CONTENT_ALTERED' });

      await db.superuserQuery('DELETE FROM audit_events WHERE organisation_id = $1 AND seq = 20', [org.organisationId]);
      report = await verifyAuditChain(db.pool, org.organisationId);
      expect(report.problems).toContainEqual({ seq: 21, problem: 'BROKEN_LINK' });
      expect(report.problems).toContainEqual({ seq: 21, problem: 'SEQUENCE_GAP' });
    } finally {
      await db.superuserQuery('ALTER TABLE audit_events ENABLE TRIGGER audit_events_immutable');
    }
  });
});
