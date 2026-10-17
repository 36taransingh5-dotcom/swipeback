import type { Queryable } from './pool.ts';

export type AuditActorType = 'system' | 'member' | 'channel' | 'simulator' | 'provider';

export interface AuditInput {
  organisationId: string;
  actorType: AuditActorType;
  actorId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  correlationId?: string | null;
}

export interface AuditRecord {
  seq: number;
  hash: string;
}

/**
 * Append an audit event. Sequence number, timestamp and hash chain are assigned by Postgres
 * (trigger `audit_events_chain`), so callers cannot forge ordering. Call this inside the same
 * transaction as the state change it describes.
 */
export async function appendAudit(q: Queryable, e: AuditInput): Promise<AuditRecord> {
  const { rows } = await q.query<AuditRecord>(
    `INSERT INTO audit_events (organisation_id, seq, actor_type, actor_id, action, entity_type, entity_id,
                               before, after, correlation_id, created_at, hash)
     VALUES ($1, 0, $2, $3, $4, $5, $6, $7, $8, $9, clock_timestamp(), '')
     RETURNING seq, hash`,
    [
      e.organisationId,
      e.actorType,
      e.actorId ?? null,
      e.action,
      e.entityType,
      e.entityId ?? null,
      e.before === undefined ? null : JSON.stringify(e.before),
      e.after === undefined ? null : JSON.stringify(e.after),
      e.correlationId ?? null,
    ],
  );
  return rows[0]!;
}

export interface AuditChainProblem {
  seq: number;
  problem: 'SEQUENCE_GAP' | 'BROKEN_LINK' | 'CONTENT_ALTERED';
}

export interface AuditChainReport {
  ok: boolean;
  checked: number;
  headHash: string | null;
  problems: AuditChainProblem[];
}

/**
 * Recompute the hash chain for one organisation. Detects edits, deletions and reordering made
 * behind the append-only triggers (e.g. by a superuser). Publishing `headHash` outside the
 * database (e.g. in the daily finance digest) is what makes a full rewrite detectable too.
 */
export async function verifyAuditChain(q: Queryable, organisationId: string): Promise<AuditChainReport> {
  const { rows } = await q.query<{
    seq: number;
    rn: number;
    prev_hash: string | null;
    expected_prev: string | null;
    hash: string;
    recomputed: string;
  }>(
    `SELECT seq, prev_hash, hash,
            row_number() OVER (ORDER BY seq) AS rn,
            lag(hash) OVER (ORDER BY seq) AS expected_prev,
            audit_event_hash(prev_hash, organisation_id, seq, actor_type, actor_id, action, entity_type,
                             entity_id, before, after, correlation_id, created_at) AS recomputed
       FROM audit_events WHERE organisation_id = $1 ORDER BY seq`,
    [organisationId],
  );
  const problems: AuditChainProblem[] = [];
  for (const r of rows) {
    if (r.seq !== r.rn) problems.push({ seq: r.seq, problem: 'SEQUENCE_GAP' });
    if (r.prev_hash !== r.expected_prev) problems.push({ seq: r.seq, problem: 'BROKEN_LINK' });
    if (r.recomputed !== r.hash) problems.push({ seq: r.seq, problem: 'CONTENT_ALTERED' });
  }
  return { ok: problems.length === 0, checked: rows.length, headHash: rows.at(-1)?.hash ?? null, problems };
}
