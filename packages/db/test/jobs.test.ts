import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { enqueue, JobRunner, jobStats, PermanentJobError, type Job } from '@swipeback/db';
import { createTestDatabase, type TestDatabase } from '../../../test/support/db.ts';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase(20);
});
afterAll(async () => db.drop());
beforeEach(async () => {
  await db.pool.query('TRUNCATE jobs RESTART IDENTITY');
});

const quiet = { onError: () => undefined };

async function drain(runners: JobRunner[], until: () => Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await until())) {
    if (Date.now() > deadline) throw new Error('drain timed out');
    const claimed = await Promise.all(runners.map((r) => r.runOnce()));
    if (claimed.every((n) => n === 0)) await new Promise((r) => setTimeout(r, 20));
  }
}

describe('job queue', () => {
  it('1,000 jobs across 4 concurrent runners each execute exactly once', async () => {
    const values = Array.from({ length: 1000 }, (_, i) => `(${'$'}${i + 1})`).join(',');
    await db.pool.query(
      `INSERT INTO jobs (kind, payload) SELECT 'count', jsonb_build_object('n', n) FROM (VALUES ${values}) v(n)`,
      Array.from({ length: 1000 }, (_, i) => i),
    );
    const seen = new Map<number, number>();
    const perWorker = new Map<string, number>();
    const runners = Array.from({ length: 4 }, (_, i) => {
      const workerId = `w${i}`;
      const handlers = {
        count: async (job: Job<never>) => {
          const n = (job.payload as { n: number }).n;
          seen.set(n, (seen.get(n) ?? 0) + 1);
          perWorker.set(workerId, (perWorker.get(workerId) ?? 0) + 1);
        },
      };
      return new JobRunner(db.pool, handlers, { workerId, batchSize: 10, ...quiet });
    });
    await drain(runners, async () => (await jobStats(db.pool)).SUCCEEDED === 1000);

    expect(seen.size).toBe(1000);
    expect([...seen.values()].every((count) => count === 1)).toBe(true);
    expect(await jobStats(db.pool)).toEqual({ QUEUED: 0, RUNNING: 0, SUCCEEDED: 1000, DEAD: 0 });
    const attempts = await db.pool.query<{ attempts: number; n: number }>(
      'SELECT attempts, count(*)::int AS n FROM jobs GROUP BY attempts',
    );
    expect(attempts.rows).toEqual([{ attempts: 1, n: 1000 }]);
    // The work was genuinely shared between the runners.
    expect(perWorker.size).toBe(4);
  });

  it('a failing job retries with growing backoff, then dead-letters', async () => {
    const { id } = await enqueue(db.pool, 'flaky', {}, { maxAttempts: 3 });
    const runAts: number[] = [];
    const runner = new JobRunner(
      db.pool,
      {
        flaky: async () => {
          throw new Error('provider unavailable');
        },
      },
      { backoffBaseMs: 100, backoffMaxMs: 10_000, ...quiet },
    );
    await drain([runner], async () => {
      const r = await db.pool.query<{ state: string; run_at: Date }>('SELECT state, run_at FROM jobs WHERE id = $1', [id]);
      const row = r.rows[0]!;
      if (runAts.at(-1) !== row.run_at.getTime()) runAts.push(row.run_at.getTime());
      return row.state === 'DEAD';
    });
    const row = (await db.pool.query('SELECT state, attempts, last_error FROM jobs WHERE id = $1', [id])).rows[0];
    expect(row).toMatchObject({ state: 'DEAD', attempts: 3, last_error: 'Error: provider unavailable' });
    // Two retries were scheduled, the second further out than the first (exponential backoff).
    expect(runAts.length).toBeGreaterThanOrEqual(3);
    const gaps = runAts.slice(1).map((t, i) => t - runAts[i]!);
    expect(gaps[0]).toBeGreaterThanOrEqual(50);
    expect(gaps[1]!).toBeGreaterThan(gaps[0]!);
  });

  it('backoff is exponential, capped and jittered within [50%, 100%]', () => {
    const r = new JobRunner(db.pool, {}, { backoffBaseMs: 1000, backoffMaxMs: 8000 });
    for (let i = 0; i < 200; i++) {
      const d1 = r.backoffDelay(1);
      const d3 = r.backoffDelay(3);
      const d10 = r.backoffDelay(10);
      expect(d1).toBeGreaterThanOrEqual(500);
      expect(d1).toBeLessThanOrEqual(1000);
      expect(d3).toBeGreaterThanOrEqual(2000);
      expect(d3).toBeLessThanOrEqual(4000);
      expect(d10).toBeLessThanOrEqual(8000);
    }
  });

  it('a PermanentJobError or unknown kind dead-letters without retry', async () => {
    const a = await enqueue(db.pool, 'bad-payload', {});
    const b = await enqueue(db.pool, 'no-such-kind', {});
    const runner = new JobRunner(
      db.pool,
      {
        'bad-payload': async () => {
          throw new PermanentJobError('payload missing expense id');
        },
      },
      quiet,
    );
    await runner.runOnce();
    const rows = (await db.pool.query('SELECT id, state, attempts FROM jobs ORDER BY id')).rows;
    expect(rows).toEqual([
      { id: a.id, state: 'DEAD', attempts: 1 },
      { id: b.id, state: 'DEAD', attempts: 1 },
    ]);
  });

  it('enqueue with a dedupe key creates the job once', async () => {
    const first = await enqueue(db.pool, 'process-inbound', { m: 1 }, { dedupeKey: 'inbound:abc' });
    const second = await enqueue(db.pool, 'process-inbound', { m: 1 }, { dedupeKey: 'inbound:abc' });
    expect(first.created).toBe(true);
    expect(second).toEqual({ id: first.id, created: false });
    expect((await jobStats(db.pool)).QUEUED).toBe(1);
  });

  it('an expired lease is reclaimed by another runner, and the stale runner cannot complete it', async () => {
    const { id } = await enqueue(db.pool, 'slow', {});
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const calls: string[] = [];
    const slow = new JobRunner(db.pool, { slow: async () => { calls.push('slow'); await gate; } }, { workerId: 'slow', leaseMs: 100, ...quiet });
    const fast = new JobRunner(db.pool, { slow: async () => { calls.push('fast'); } }, { workerId: 'fast', ...quiet });

    const pending = slow.runOnce();
    await new Promise((r) => setTimeout(r, 250)); // lease expires while the slow handler hangs
    expect(await fast.runOnce()).toBe(1);
    release();
    await pending;

    const row = (await db.pool.query('SELECT state, attempts, locked_by FROM jobs WHERE id = $1', [id])).rows[0];
    expect(calls).toEqual(['slow', 'fast']); // at-least-once: handlers must be idempotent
    expect(row).toEqual({ state: 'SUCCEEDED', attempts: 2, locked_by: null });
  });

  it('enqueue inside a rolled-back transaction leaves no job', async () => {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await enqueue(client, 'process-inbound', {});
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    expect((await jobStats(db.pool)).QUEUED).toBe(0);
  });
});
