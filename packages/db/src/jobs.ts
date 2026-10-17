import { randomUUID } from 'node:crypto';
import type { Pool, Queryable } from './pool.ts';

/**
 * Postgres-backed durable job queue.
 *
 * Delivery is at-least-once: a job whose lease expires (worker crash, hang) is reclaimed by another
 * runner. Handlers must therefore be idempotent — which every Swipeback handler is anyway, because
 * the same guarantee is required for webhook and mailbox redelivery.
 */

export interface Job<P = unknown> {
  id: number;
  kind: string;
  payload: P;
  organisationId: string | null;
  attempts: number;
  maxAttempts: number;
  correlationId: string | null;
}

export interface EnqueueOptions {
  organisationId?: string | null;
  /** Enqueue at most once per key (e.g. `process-inbound:<dedupe_key>`). */
  dedupeKey?: string;
  delayMs?: number;
  maxAttempts?: number;
  correlationId?: string | null;
}

/** Enqueue a job. Pass a transaction client to make the enqueue atomic with the caller's writes. */
export async function enqueue(
  q: Queryable,
  kind: string,
  payload: unknown,
  opts: EnqueueOptions = {},
): Promise<{ id: number; created: boolean }> {
  const inserted = await q.query<{ id: number }>(
    `INSERT INTO jobs (organisation_id, kind, payload, dedupe_key, run_at, max_attempts, correlation_id)
     VALUES ($1, $2, $3, $4, clock_timestamp() + ($5::int * interval '1 millisecond'), $6, $7)
     ON CONFLICT (dedupe_key) DO NOTHING
     RETURNING id`,
    [
      opts.organisationId ?? null,
      kind,
      JSON.stringify(payload ?? {}),
      opts.dedupeKey ?? null,
      opts.delayMs ?? 0,
      opts.maxAttempts ?? 5,
      opts.correlationId ?? null,
    ],
  );
  if (inserted.rows[0]) return { id: inserted.rows[0].id, created: true };
  const existing = await q.query<{ id: number }>('SELECT id FROM jobs WHERE dedupe_key = $1', [opts.dedupeKey]);
  return { id: existing.rows[0]!.id, created: false };
}

/** Throw from a handler to dead-letter immediately (no retry), e.g. for a malformed payload. */
export class PermanentJobError extends Error {
  override readonly name = 'PermanentJobError';
}

export type JobHandler = (job: Job<never>) => Promise<void>;
export type JobHandlers = Record<string, (job: Job<never>) => Promise<void>>;

export interface JobRunnerOptions {
  workerId?: string;
  batchSize?: number;
  pollIntervalMs?: number;
  leaseMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  onError?: (job: Job, err: unknown) => void;
}

interface JobRow {
  id: number;
  kind: string;
  payload: unknown;
  organisation_id: string | null;
  attempts: number;
  max_attempts: number;
  correlation_id: string | null;
}

export class JobRunner {
  readonly workerId: string;
  private readonly batchSize: number;
  private readonly pollIntervalMs: number;
  private readonly leaseMs: number;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly onError: (job: Job, err: unknown) => void;
  private running = false;
  private loop: Promise<void> | null = null;

  constructor(
    private readonly pool: Pool,
    private readonly handlers: JobHandlers,
    opts: JobRunnerOptions = {},
  ) {
    this.workerId = opts.workerId ?? `worker-${randomUUID().slice(0, 8)}`;
    this.batchSize = opts.batchSize ?? 5;
    this.pollIntervalMs = opts.pollIntervalMs ?? 250;
    this.leaseMs = opts.leaseMs ?? 60_000;
    this.backoffBaseMs = opts.backoffBaseMs ?? 1_000;
    this.backoffMaxMs = opts.backoffMaxMs ?? 5 * 60_000;
    this.onError = opts.onError ?? ((job, err) => console.error(`[jobs] ${job.kind}#${job.id} failed:`, err));
  }

  /** Claim and run one batch. Returns the number of jobs claimed. */
  async runOnce(): Promise<number> {
    const { rows } = await this.pool.query<JobRow>(
      `UPDATE jobs SET state = 'RUNNING', attempts = attempts + 1, locked_by = $1,
              locked_until = clock_timestamp() + ($2::int * interval '1 millisecond')
        WHERE id IN (
          SELECT id FROM jobs
           WHERE (state = 'QUEUED' AND run_at <= clock_timestamp())
              OR (state = 'RUNNING' AND locked_until < clock_timestamp())
           ORDER BY run_at, id
           FOR UPDATE SKIP LOCKED
           LIMIT $3)
        RETURNING id, kind, payload, organisation_id, attempts, max_attempts, correlation_id`,
      [this.workerId, this.leaseMs, this.batchSize],
    );
    await Promise.all(rows.map((row) => this.execute(row)));
    return rows.length;
  }

  private async execute(row: JobRow): Promise<void> {
    const job: Job = {
      id: row.id,
      kind: row.kind,
      payload: row.payload,
      organisationId: row.organisation_id,
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
      correlationId: row.correlation_id,
    };
    // A reclaimed job that keeps losing its lease has exhausted its attempts.
    if (job.attempts > job.maxAttempts) {
      await this.finishFailed(job, new Error('attempts exhausted (lease expired)'), true);
      return;
    }
    const handler = this.handlers[job.kind];
    try {
      if (!handler) throw new PermanentJobError(`no handler registered for job kind "${job.kind}"`);
      await handler(job as Job<never>);
      // Fenced on locked_by: if our lease expired and another runner reclaimed the job, this is a no-op.
      await this.pool.query(
        `UPDATE jobs SET state = 'SUCCEEDED', finished_at = clock_timestamp(), locked_by = NULL,
                locked_until = NULL, last_error = NULL
          WHERE id = $1 AND locked_by = $2 AND state = 'RUNNING'`,
        [job.id, this.workerId],
      );
    } catch (err) {
      this.onError(job, err);
      await this.finishFailed(job, err, err instanceof PermanentJobError || job.attempts >= job.maxAttempts);
    }
  }

  private async finishFailed(job: Job, err: unknown, dead: boolean): Promise<void> {
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    if (dead) {
      await this.pool.query(
        `UPDATE jobs SET state = 'DEAD', finished_at = clock_timestamp(), locked_by = NULL, locked_until = NULL,
                last_error = $3
          WHERE id = $1 AND locked_by = $2 AND state = 'RUNNING'`,
        [job.id, this.workerId, message],
      );
      return;
    }
    await this.pool.query(
      `UPDATE jobs SET state = 'QUEUED', locked_by = NULL, locked_until = NULL, last_error = $3,
              run_at = clock_timestamp() + ($4::int * interval '1 millisecond')
        WHERE id = $1 AND locked_by = $2 AND state = 'RUNNING'`,
      [job.id, this.workerId, message, this.backoffDelay(job.attempts)],
    );
  }

  /** Exponential backoff with jitter in [50%, 100%] of the capped delay. */
  backoffDelay(attempts: number): number {
    const capped = Math.min(this.backoffMaxMs, this.backoffBaseMs * 2 ** Math.max(0, attempts - 1));
    return Math.round(capped * (0.5 + Math.random() * 0.5));
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = (async () => {
      while (this.running) {
        let claimed = 0;
        try {
          claimed = await this.runOnce();
        } catch (err) {
          console.error('[jobs] claim failed:', (err as Error).message);
        }
        if (claimed === 0 && this.running) await new Promise((r) => setTimeout(r, this.pollIntervalMs));
      }
    })();
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.loop;
    this.loop = null;
  }
}

export interface JobStats {
  QUEUED: number;
  RUNNING: number;
  SUCCEEDED: number;
  DEAD: number;
}

export async function jobStats(q: Queryable): Promise<JobStats> {
  const { rows } = await q.query<{ state: keyof JobStats; n: number }>(
    'SELECT state, count(*)::int AS n FROM jobs GROUP BY state',
  );
  const stats: JobStats = { QUEUED: 0, RUNNING: 0, SUCCEEDED: 0, DEAD: 0 };
  for (const r of rows) stats[r.state] = r.n;
  return stats;
}
