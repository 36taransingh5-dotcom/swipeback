import { createHash, randomBytes } from 'node:crypto';
import type { PoolClient } from '@swipeback/db';

/**
 * One-time action challenges. Every approval or payment action needs a challenge minted for that
 * person, for that expense at that version, with an expiry. The link in an email carries the
 * challenge but never authenticates: the person must also hold a session and the right role.
 */

export type ChallengePurpose = 'EXPENSE_REVIEW' | 'PAYMENT_AUTHORISATION';
export type ReviewVerb = 'APPROVE' | 'DECLINE' | 'REQUEST_INFO' | 'CORRECT' | 'AUTHORISE_PAYMENT';

const hash = (nonce: string) => createHash('sha256').update(nonce).digest('hex');

export const EMAIL_CHALLENGE_TTL_MINUTES = 72 * 60;
export const PAGE_CHALLENGE_TTL_MINUTES = 30;

export async function mintChallenge(
  c: PoolClient,
  p: {
    organisationId: string;
    expenseId: string;
    reimbursementId?: string | null;
    memberId: string;
    purpose: ChallengePurpose;
    ttlMinutes: number;
  },
): Promise<{ challengeId: string; nonce: string }> {
  const nonce = randomBytes(24).toString('base64url');
  const version = await c.query<{ version: number }>('SELECT version FROM expenses WHERE id = $1', [p.expenseId]);
  const actions = p.purpose === 'EXPENSE_REVIEW' ? ['APPROVE', 'DECLINE', 'REQUEST_INFO', 'CORRECT'] : ['AUTHORISE_PAYMENT'];
  const r = await c.query<{ id: string }>(
    `INSERT INTO approval_challenges (organisation_id, expense_id, reimbursement_id, allowed_actions, required_role, nonce_hash,
        expense_version, expires_at, intended_member_id, purpose)
     VALUES ($1,$2,$3,$4,$5,$6,$7, clock_timestamp() + ($8::int * interval '1 minute'), $9, $10) RETURNING id`,
    [
      p.organisationId, p.expenseId, p.reimbursementId ?? null, actions,
      p.purpose === 'EXPENSE_REVIEW' ? 'reviewer' : 'payment_approver', hash(nonce), version.rows[0]!.version,
      p.ttlMinutes, p.memberId, p.purpose,
    ],
  );
  return { challengeId: r.rows[0]!.id, nonce };
}

export interface ChallengeRow {
  id: string;
  expense_id: string;
  reimbursement_id: string | null;
  expense_version: number;
  purpose: ChallengePurpose;
}

/** Look up a usable challenge for this person without consuming it (for rendering the page). */
export async function peekChallenge(c: Pick<PoolClient, 'query'>, p: { challengeId: string; nonce: string; memberId: string; organisationId: string }): Promise<ChallengeRow | null> {
  if (!/^[0-9a-f-]{36}$/.test(p.challengeId) || !p.nonce) return null;
  const r = await c.query<ChallengeRow>(
    `SELECT id, expense_id, reimbursement_id, expense_version, purpose FROM approval_challenges
      WHERE id = $1 AND nonce_hash = $2 AND intended_member_id = $3 AND organisation_id = $4
        AND consumed_at IS NULL AND expires_at > clock_timestamp()`,
    [p.challengeId, hash(p.nonce), p.memberId, p.organisationId],
  );
  return r.rows[0] ?? null;
}

/** Atomically consume a challenge for exactly this person, action and object; null if unusable. */
export async function consumeChallenge(
  c: PoolClient,
  p: { challengeId: string; nonce: string; memberId: string; organisationId: string; verb: ReviewVerb; expenseId: string; reimbursementId?: string | null },
): Promise<ChallengeRow | null> {
  if (!/^[0-9a-f-]{36}$/.test(p.challengeId) || !p.nonce) return null;
  const r = await c.query<ChallengeRow>(
    `UPDATE approval_challenges SET consumed_at = clock_timestamp(), consumed_by = $3
      WHERE id = $1 AND nonce_hash = $2 AND intended_member_id = $3 AND organisation_id = $4
        AND consumed_at IS NULL AND expires_at > clock_timestamp()
        AND $5 = ANY(allowed_actions) AND expense_id = $6
        AND ($7::uuid IS NULL OR reimbursement_id = $7::uuid)
      RETURNING id, expense_id, reimbursement_id, expense_version, purpose`,
    [p.challengeId, hash(p.nonce), p.memberId, p.organisationId, p.verb, p.expenseId, p.reimbursementId ?? null],
  );
  return r.rows[0] ?? null;
}
