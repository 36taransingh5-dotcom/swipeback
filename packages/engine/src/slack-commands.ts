import { slackChannelAddress, type SlackSlashCommand } from '@swipeback/channels';
import { appendAudit } from '@swipeback/db';
import { formatMoney, money } from '@swipeback/domain';
import type { SessionMember } from './auth.ts';
import { reviewQueue } from './case-view.ts';
import type { EngineDeps } from './deps.ts';
import { FOOTER } from './templates.ts';

/**
 * `/swipeback` slash command. Read-only: help, a member's recent expenses, and the finance queue.
 * Replies are ephemeral (only the person who ran the command sees them). Nothing here approves,
 * pays or changes an expense; those decisions stay in the authenticated web app.
 */

const FINANCE_ROLES = ['reviewer', 'payment_approver', 'admin'];
const MENTION_RE = /<@([UW][A-Z0-9]{2,31})(?:\|[^>]*)?>/;
const PENDING_LIMIT = 10;

/** Slack renders `<…>` and `&` as markup. Data from receipts and names must not be able to forge mentions or links. */
export function slackEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const HELP = [
  '*Swipeback* turns receipts into handled expenses (SYNTHETIC DEMO, simulated payouts).',
  '',
  '*Send a receipt*',
  '• Direct message the Swipeback app with a photo or PDF, or',
  '• in a channel where Swipeback has been added, post the photo or PDF and mention it (@Swipeback). The details come to you by direct message.',
  '',
  '*Commands*',
  '• `/swipeback status` shows your latest expenses.',
  '• `/swipeback status @person` shows theirs (finance reviewers only).',
  '• `/swipeback pending` lists cases waiting on finance, with sign-in review links (finance reviewers only).',
  '• `/swipeback help` shows this message.',
  '',
  'If a receipt needs one more answer, reply in the thread of the direct message. Approvals happen in the Swipeback web app, never in Slack.',
].join('\n');

async function memberFor(deps: Pick<EngineDeps, 'pool'>, connectionId: string, slackAddress: string): Promise<SessionMember | null> {
  const r = await deps.pool.query<{ id: string; organisation_id: string; email: string; display_name: string; roles: string[] }>(
    `SELECT m.id, m.organisation_id, m.email, m.display_name, m.roles
       FROM channel_connections cc
       JOIN channel_identities ci ON ci.organisation_id = cc.organisation_id AND ci.channel = 'slack' AND ci.status = 'ACTIVE'
       JOIN members m ON m.id = ci.member_id AND m.status = 'ACTIVE'
      WHERE cc.id = $1 AND lower(ci.channel_address) = $2`,
    [connectionId, slackAddress],
  );
  const m = r.rows[0];
  return m ? { memberId: m.id, organisationId: m.organisation_id, email: m.email, displayName: m.display_name, roles: m.roles } : null;
}

const isFinance = (m: Pick<SessionMember, 'roles'>) => m.roles.some((r) => FINANCE_ROLES.includes(r));

/** Returns the text to show the person who ran the command. Never throws for user error. */
export async function handleSlackCommand(deps: EngineDeps, connectionId: string, teamId: string, command: SlackSlashCommand): Promise<string> {
  const text = command.text.trim();
  const [verb = '', ...rest] = text.split(/\s+/);
  const sub = verb.toLowerCase();
  if (sub === '' || sub === 'help' || sub === 'tips') return HELP;
  if (sub !== 'status' && sub !== 'pending') return `I don't know "${slackEscape(verb.slice(0, 40))}".\n\n${HELP}`;

  const self = await memberFor(deps, connectionId, slackChannelAddress(teamId, command.user_id));
  if (!self) {
    return "I don't know you yet. Your Slack account isn't linked to a Swipeback employee. Ask an admin to link it (demo enrolment), then try again.";
  }

  if (sub === 'pending') {
    if (!isFinance(self)) return 'Only finance reviewers can see the pending queue.';
    const q = await reviewQueue(deps, self);
    if (q.items.length === 0) return `Nothing is waiting on finance.\n${q.waitingOnEmployees} waiting on employees, ${q.handledAutomatically} handled automatically.\n\n${FOOTER}`;
    const base = deps.config.appUrl.replace(/\/$/, '');
    const lines = q.items.slice(0, PENDING_LIMIT).map((i) => {
      const amount = i.amountMinor !== null && i.currency ? formatMoney(money(i.amountMinor, i.currency)) : 'amount unknown';
      const what = i.kind === 'PAYMENT_AUTHORISATION' ? 'payment authorisation' : 'review';
      const why = i.reasons.length ? ` (${slackEscape(i.reasons.slice(0, 2).join('; '))})` : '';
      return `• <${base}/review/${i.expenseId}|${i.ref}> ${what}: ${slackEscape(i.employee)}, ${slackEscape(i.merchant ?? 'unknown merchant')}, ${amount}${why}`;
    });
    const more = q.items.length > PENDING_LIMIT ? `\n…and ${q.items.length - PENDING_LIMIT} more in the web app.` : '';
    return `*${q.items.length} waiting on finance*\n${lines.join('\n')}${more}\n\nLinks need you to sign in. Nothing is approved from Slack.\n\n${FOOTER}`;
  }

  // status [@person]
  const arg = rest.join(' ');
  const mention = MENTION_RE.exec(arg);
  let target: SessionMember = self;
  if (arg && !mention) return 'To look at someone else, mention them: `/swipeback status @name` (pick them from the list so it becomes a mention).';
  if (mention && mention[1]!.toLowerCase() !== command.user_id.toLowerCase()) {
    if (!isFinance(self)) return 'You can only see your own expenses.';
    const other = await memberFor(deps, connectionId, slackChannelAddress(teamId, mention[1]!));
    if (!other) return "That person isn't linked to Swipeback, so there is nothing to show.";
    target = other;
    await appendAudit(deps.pool, {
      organisationId: self.organisationId, actorType: 'member', actorId: self.memberId, action: 'slack.status_viewed',
      entityType: 'member', entityId: other.memberId, after: { via: 'slack_command' },
    });
  }
  return statusText(deps, target, target.memberId === self.memberId);
}

async function statusText(deps: Pick<EngineDeps, 'pool'>, who: SessionMember, isSelf: boolean): Promise<string> {
  const recent = await deps.pool.query<{ ref: string; merchant: string | null; amount_minor: number | null; currency: string | null; expense_date: string | null; state: string }>(
    `SELECT ref, merchant, amount_minor, currency, expense_date::text AS expense_date, state FROM expenses
      WHERE organisation_id = $1 AND member_id = $2 ORDER BY created_at DESC LIMIT 5`,
    [who.organisationId, who.memberId],
  );
  const totals = await deps.pool.query<{ total: number; paid: number; waiting_you: number; with_finance: number; paid_minor: string | null }>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE state = 'EXPORTED')::int AS paid,
            count(*) FILTER (WHERE state IN ('NEEDS_INFO','NEEDS_MATCH'))::int AS waiting_you,
            count(*) FILTER (WHERE state = 'REVIEW_REQUIRED')::int AS with_finance,
            (SELECT coalesce(sum(r.amount_minor), 0)::text FROM reimbursements r WHERE r.organisation_id = $1 AND r.member_id = $2 AND r.state = 'SIMULATED_PAID' AND r.currency = 'GBP') AS paid_minor
       FROM expenses WHERE organisation_id = $1 AND member_id = $2`,
    [who.organisationId, who.memberId],
  );
  const name = isSelf ? 'You' : slackEscape(who.displayName);
  const t = totals.rows[0]!;
  if (t.total === 0) return `${name} ${isSelf ? "haven't" : "hasn't"} submitted any expenses yet.\n\n${FOOTER}`;
  const lines = recent.rows.map((e) => {
    const amount = e.amount_minor !== null && e.currency ? formatMoney(money(e.amount_minor, e.currency)) : 'amount unknown';
    return `• ${e.ref} ${slackEscape(e.merchant ?? 'unknown merchant')}, ${amount}${e.expense_date ? ` on ${e.expense_date}` : ''}: ${e.state.toLowerCase().replace(/_/g, ' ')}`;
  });
  const paid = BigInt(t.paid_minor ?? '0') > 0n ? `, ${formatMoney(money(Number(t.paid_minor), 'GBP'))} reimbursed (simulated)` : '';
  return `*${isSelf ? 'Your' : `${name}'s`} expenses*: ${t.total} submitted, ${t.paid} filed, ${t.waiting_you} waiting on ${isSelf ? 'you' : 'them'}, ${t.with_finance} with finance${paid}\n${lines.join('\n')}\n\n${FOOTER}`;
}
