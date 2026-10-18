import { createHash, randomBytes } from 'node:crypto';
import { appendAudit, withTransaction } from '@swipeback/db';
import { CATEGORIES, parsePolicyDocument, policyContentHash } from '@swipeback/domain';
import type { EngineDeps } from './deps.ts';
import { SESSION_TTL_HOURS, type SessionMember } from './auth.ts';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const newToken = () => randomBytes(32).toString('base64url');
const validEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 320;

// A preview workspace never clears or reimburses an expense automatically. An
// organisation's actual policy must be configured before automation is enabled.
const PREVIEW_POLICY = parsePolicyDocument({
  schema: 'swipeback.policy.v1', currency: 'GBP',
  clauses: { 'SB-PREVIEW': { title: 'Preview review', text: 'Every expense is sent to a person for review. No automatic reimbursement is enabled.' } },
  receipts: { required: true, clause: 'SB-PREVIEW' },
  categories: Object.fromEntries(CATEGORIES.map((category) => [category, {
    allowed: true, requiresBusinessPurpose: false, clause: 'SB-PREVIEW',
  }])),
  memberLimits: { dailyCapMinor: 100000000, weeklyCapMinor: 100000000, clause: 'SB-PREVIEW' },
  reviewAboveMinor: { amountMinor: 0, clause: 'SB-PREVIEW' },
  vatInvoice: { requiredAboveMinor: 100000000, clause: 'SB-PREVIEW' },
  claimWindow: { maxAgeDays: 365, clause: 'SB-PREVIEW' },
  currencies: { allowed: ['GBP'], foreignRequiresReview: true, clause: 'SB-PREVIEW' },
  blockedMerchants: [],
  matching: { windowBeforeDays: 1, windowAfterDays: 5, awaitCardFeedMinutes: 0, clause: 'SB-PREVIEW' },
  autoReimbursement: { enabled: false, perExpenseMaxMinor: 0, memberDailyMaxMinor: 0,
    memberWeeklyMaxMinor: 0, monthlyBudgetMinor: 0, clause: 'SB-PREVIEW' },
});
const PREVIEW_POLICY_TEXT = 'Swipeback preview policy: every expense is reviewed by a person. Automatic reimbursement is disabled.';

export type SignupRequestResult = 'sent' | 'invalid' | 'unavailable';

/** Email a single-use verification link through Swipeback's explicitly configured sender. */
export async function requestSignupLink(deps: EngineDeps, emailInput: string, senderConnectionId: string | null): Promise<SignupRequestResult> {
  const email = emailInput.trim().toLowerCase();
  if (!validEmail(email)) return 'invalid';
  if (!senderConnectionId) return 'unavailable';
  const sender = (await deps.pool.query<{ id: string; organisation_id: string; provider: string; address: string }>(
    `SELECT id, organisation_id, provider, address FROM channel_connections
     WHERE id = $1 AND channel = 'email' AND provider IN ('gmail', 'fixture') AND status = 'ACTIVE'`,
    [senderConnectionId],
  )).rows[0];
  if (!sender) return 'unavailable';

  const token = newToken();
  const tokenHash = hash(token);
  const created = await withTransaction(deps.pool, async (c) => {
    const count = await c.query<{ per_email: number; global: number }>(
      `SELECT count(*) FILTER (WHERE email = $1)::int AS per_email, count(*)::int AS global
       FROM signup_tokens WHERE created_at > clock_timestamp() - interval '1 hour'`, [email],
    );
    if (count.rows[0]!.per_email >= 3 || count.rows[0]!.global >= 100) return false;
    await c.query(
      `INSERT INTO signup_tokens (email, token_hash, expires_at)
       VALUES ($1, $2, clock_timestamp() + interval '15 minutes')`, [email, tokenHash],
    );
    return true;
  });
  if (!created) return 'sent'; // Same response for throttled requests.

  try {
    await deps.channels.adapterFor(sender.provider).sendMessage({
      tenantId: sender.organisation_id, connectionId: sender.id, from: sender.address, to: email,
      subject: 'Your Swipeback sign-in link',
      text: `Open this link to start your Swipeback workspace:\n\n${deps.config.appUrl}/start/callback?t=${token}\n\nThis link works once and expires in 15 minutes. If you did not request it, you can ignore this email.\n\nSwipeback preview · simulated payouts only.`,
      threadId: null, inReplyTo: null, references: [], replyToken: null, idempotencyKey: `signup:${tokenHash}`,
    });
  } catch {
    await deps.pool.query('DELETE FROM signup_tokens WHERE token_hash = $1', [tokenHash]);
    return 'unavailable';
  }
  return 'sent';
}

/** Verify email and create one workspace once, then open a normal server-side session. */
export async function consumeSignupToken(deps: EngineDeps, token: string): Promise<{ sessionToken: string; member: SessionMember } | null> {
  if (!token || token.length > 200) return null;
  return withTransaction(deps.pool, async (c) => {
    const claimed = await c.query<{ email: string }>(
      `UPDATE signup_tokens SET consumed_at = clock_timestamp()
       WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > clock_timestamp()
       RETURNING email`, [hash(token)],
    );
    const email = claimed.rows[0]?.email;
    if (!email) return null;
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`signup:${email}`]);
    let member = (await c.query<{ id: string; organisation_id: string; display_name: string; roles: string[] }>(
      `SELECT id, organisation_id, display_name, roles FROM members
       WHERE email = $1 AND status = 'ACTIVE' AND roles && ARRAY['admin','reviewer','payment_approver']::text[]
       ORDER BY created_at ASC LIMIT 1`, [email],
    )).rows[0];
    if (!member) {
      const domain = email.split('@')[1]!;
      const organisationId = (await c.query<{ id: string }>(
        `INSERT INTO organisations (name, designated_address, is_synthetic)
         VALUES ($1, $2, true) RETURNING id`, [`${domain} workspace`, email],
      )).rows[0]!.id;
      const displayName = email.split('@')[0]!.replace(/[._-]+/g, ' ').slice(0, 80) || 'Workspace admin';
      const memberId = (await c.query<{ id: string }>(
        `INSERT INTO members (organisation_id, email, display_name, roles)
         VALUES ($1, $2, $3, ARRAY['admin','reviewer']::text[]) RETURNING id`,
        [organisationId, email, displayName],
      )).rows[0]!.id;
      await c.query(
        `INSERT INTO channel_identities (organisation_id, member_id, channel, channel_address, verification_method)
         VALUES ($1, $2, 'email', $3, 'signup_magic_link')`, [organisationId, memberId, email],
      );
      const policyId = (await c.query<{ id: string }>(
        `INSERT INTO policy_versions (organisation_id, version, rules, source_text, content_hash, created_by)
         VALUES ($1, 1, $2, $3, $4, $5) RETURNING id`,
        [organisationId, JSON.stringify(PREVIEW_POLICY), PREVIEW_POLICY_TEXT, policyContentHash(PREVIEW_POLICY), memberId],
      )).rows[0]!.id;
      await c.query('UPDATE organisations SET active_policy_version_id = $2 WHERE id = $1', [organisationId, policyId]);
      await appendAudit(c, { organisationId, actorType: 'member', actorId: memberId, action: 'workspace.created',
        entityType: 'organisation', entityId: organisationId });
      member = { id: memberId, organisation_id: organisationId, display_name: displayName, roles: ['admin', 'reviewer'] };
    }
    const sessionToken = newToken();
    await c.query(
      `INSERT INTO sessions (member_id, token_hash, expires_at)
       VALUES ($1, $2, clock_timestamp() + ($3::int * interval '1 hour'))`,
      [member.id, hash(sessionToken), SESSION_TTL_HOURS],
    );
    await appendAudit(c, { organisationId: member.organisation_id, actorType: 'member', actorId: member.id,
      action: 'auth.signed_in', entityType: 'member', entityId: member.id });
    return { sessionToken, member: { memberId: member.id, organisationId: member.organisation_id,
      email, displayName: member.display_name, roles: member.roles } };
  });
}
