import { createHash, randomBytes } from 'node:crypto';
import { appendAudit, withTransaction } from '@swipeback/db';
import type { EngineDeps } from './deps.ts';
import { primaryEmailConnection, queueMessage } from './outbox.ts';
import { loginLinkMessage } from './templates.ts';

/**
 * Reviewer authentication: email magic link -> server-side session. Only members holding a finance
 * role can sign in. Tokens are random, single-use, short-lived, and stored only as hashes.
 */

export const LOGIN_TTL_MINUTES = 15;
export const SESSION_TTL_HOURS = 8;
export const FINANCE_ROLES = ['reviewer', 'payment_approver', 'admin'] as const;

const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const newToken = () => randomBytes(32).toString('base64url');

/** Only same-site relative paths are allowed as post-login destinations (no open redirect). */
export function safeNextPath(next: string | null | undefined): string {
  return next && /^\/(?!\/)[A-Za-z0-9/_\-?=&.%]*$/.test(next) ? next : '/review';
}

/**
 * Always resolves the same way whether or not the address belongs to a reviewer (no account
 * enumeration). The link is delivered through the organisation's connected mailbox.
 */
export async function requestLoginLink(deps: EngineDeps, emailInput: string, nextPath?: string | null): Promise<void> {
  const email = emailInput.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 320) return;
  await withTransaction(deps.pool, async (c) => {
    const m = await c.query<{ id: string; organisation_id: string }>(
      `SELECT id, organisation_id FROM members WHERE email = $1 AND status = 'ACTIVE' AND roles && $2::text[]`,
      [email, [...FINANCE_ROLES]],
    );
    const member = m.rows[0];
    if (!member) return;
    // Throttle: at most 5 links per member per 15 minutes.
    const recent = await c.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM login_tokens WHERE member_id = $1 AND created_at > clock_timestamp() - interval '15 minutes'`,
      [member.id],
    );
    if (recent.rows[0]!.n >= 5) return;
    const conn = await primaryEmailConnection(c, member.organisation_id);
    if (!conn) return;
    const token = newToken();
    await c.query(
      `INSERT INTO login_tokens (member_id, token_hash, expires_at, next_path) VALUES ($1, $2, clock_timestamp() + ($3::int * interval '1 minute'), $4)`,
      [member.id, hash(token), LOGIN_TTL_MINUTES, safeNextPath(nextPath)],
    );
    await queueMessage(c, {
      organisationId: member.organisation_id, connectionId: conn.id, channel: 'email', expenseId: null, recipientMemberId: member.id,
      recipientAddress: email, template: 'login-link', idempotencyKey: `login:${hash(token)}`,
      rendered: loginLinkMessage(`${deps.config.appUrl}/auth/callback?t=${token}`),
    });
    await appendAudit(c, { organisationId: member.organisation_id, actorType: 'member', actorId: member.id, action: 'auth.login_link_requested', entityType: 'member', entityId: member.id });
  });
}

export interface SessionMember {
  memberId: string;
  organisationId: string;
  email: string;
  displayName: string;
  roles: string[];
}

/** Consume a magic-link token (once) and open a session. Returns the raw session token for the cookie. */
export async function consumeLoginToken(deps: EngineDeps, token: string): Promise<{ sessionToken: string; nextPath: string; member: SessionMember } | null> {
  if (!token || token.length > 200) return null;
  return withTransaction(deps.pool, async (c) => {
    const r = await c.query<{ id: string; member_id: string; next_path: string | null }>(
      `UPDATE login_tokens SET consumed_at = clock_timestamp()
        WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > clock_timestamp()
        RETURNING id, member_id, next_path`,
      [hash(token)],
    );
    const row = r.rows[0];
    if (!row) return null;
    const member = await loadMember(c, row.member_id);
    if (!member) return null;
    const sessionToken = newToken();
    await c.query(
      `INSERT INTO sessions (member_id, token_hash, expires_at) VALUES ($1, $2, clock_timestamp() + ($3::int * interval '1 hour'))`,
      [member.memberId, hash(sessionToken), SESSION_TTL_HOURS],
    );
    await appendAudit(c, { organisationId: member.organisationId, actorType: 'member', actorId: member.memberId, action: 'auth.signed_in', entityType: 'member', entityId: member.memberId });
    return { sessionToken, nextPath: safeNextPath(row.next_path), member };
  });
}

export async function loadSession(deps: Pick<EngineDeps, 'pool'>, sessionToken: string | undefined): Promise<SessionMember | null> {
  if (!sessionToken || sessionToken.length > 200) return null;
  const r = await deps.pool.query<{ member_id: string }>(
    `UPDATE sessions SET last_seen_at = clock_timestamp()
      WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > clock_timestamp() RETURNING member_id`,
    [hash(sessionToken)],
  );
  if (!r.rows[0]) return null;
  return loadMember(deps.pool, r.rows[0].member_id);
}

export async function endSession(deps: Pick<EngineDeps, 'pool'>, sessionToken: string | undefined): Promise<void> {
  if (!sessionToken) return;
  await deps.pool.query(`UPDATE sessions SET revoked_at = clock_timestamp() WHERE token_hash = $1 AND revoked_at IS NULL`, [hash(sessionToken)]);
}

async function loadMember(q: Pick<EngineDeps['pool'], 'query'>, memberId: string): Promise<SessionMember | null> {
  const m = await q.query<{ id: string; organisation_id: string; email: string; display_name: string; roles: string[]; status: string }>(
    'SELECT id, organisation_id, email, display_name, roles, status FROM members WHERE id = $1',
    [memberId],
  );
  const row = m.rows[0];
  if (!row || row.status !== 'ACTIVE' || !row.roles.some((r) => (FINANCE_ROLES as readonly string[]).includes(r))) return null;
  return { memberId: row.id, organisationId: row.organisation_id, email: row.email, displayName: row.display_name, roles: row.roles };
}
