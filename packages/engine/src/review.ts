import { appendAudit, enqueue, withTransaction, type PoolClient } from '@swipeback/db';
import { CATEGORIES, canHumanAuthorisePayment, isIsoDate, parseDecimalToMinor, type Category, type DecisionField, type IntegrityFlag } from '@swipeback/domain';
import type { SessionMember } from './auth.ts';
import { consumeChallenge, mintChallenge, PAGE_CHALLENGE_TTL_MINUTES, type ChallengePurpose } from './challenges.ts';
import { lockKey, moveExpense, moveReimbursement, type EngineDeps } from './deps.ts';
import { lockExpense, originOf, summary, type ExpenseRow } from './expense.ts';
import { newCorrelationToken } from './inbound.ts';
import { computeEligibility, toEmployee } from './money-movement.ts';
import { queueMessage } from './outbox.ts';
import { reviewerQuestionMessage, reviewOutcomeMessage } from './templates.ts';

/**
 * Authenticated human decisions. Every command re-checks, inside one transaction: tenant, role,
 * segregation of duties, the expense version the reviewer saw, and a one-time challenge minted for
 * that reviewer. Prior history is never edited — decisions append reviews and audit events.
 */

export class ReviewError extends Error {
  override readonly name = 'ReviewError';
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 410,
    message: string,
  ) {
    super(message);
  }
}

export type ReviewAction = 'APPROVE' | 'DECLINE' | 'REQUEST_INFO' | 'CORRECT';

export interface Corrections {
  merchant?: string;
  amount?: string;
  currency?: string;
  date?: string;
  category?: string;
  paymentType?: 'CORPORATE' | 'PERSONAL';
}

export interface ReviewInput {
  expenseId: string;
  action: ReviewAction;
  reason: string;
  expectedVersion: number;
  challengeId: string;
  nonce: string;
  /** REQUEST_INFO: the question to send the employee. */
  question?: string;
  corrections?: Corrections;
}

const hasRole = (m: SessionMember, ...roles: string[]) => m.roles.some((r) => roles.includes(r));
const DATA_READING_FLAGS: readonly IntegrityFlag[] = ['EXTRACTION_FAILED', 'ARITHMETIC_MISMATCH', 'EVIDENCE_INCONSISTENCY'];

async function lockOwnExpense(c: PoolClient, actor: SessionMember, expenseId: string): Promise<ExpenseRow> {
  if (!/^[0-9a-f-]{36}$/.test(expenseId)) throw new ReviewError(404, 'Expense not found');
  const r = await c.query<{ organisation_id: string }>('SELECT organisation_id FROM expenses WHERE id = $1', [expenseId]);
  if (r.rows[0]?.organisation_id !== actor.organisationId) throw new ReviewError(404, 'Expense not found');
  return lockExpense(c, expenseId);
}

export async function reviewExpense(deps: EngineDeps, actor: SessionMember, input: ReviewInput): Promise<{ state: string }> {
  return withTransaction(deps.pool, async (c) => {
    const e = await lockOwnExpense(c, actor, input.expenseId);
    if (!hasRole(actor, 'reviewer', 'admin')) throw new ReviewError(403, 'You need the reviewer role to decide expenses');
    if (e.member_id === actor.memberId) throw new ReviewError(403, 'You cannot review your own expense');
    if (e.state !== 'REVIEW_REQUIRED') throw new ReviewError(409, `This expense is no longer awaiting review (now ${e.state.toLowerCase().replace(/_/g, ' ')})`);
    if (e.version !== input.expectedVersion) throw new ReviewError(409, 'This expense changed since you opened it; reload to see the latest');
    const reason = input.reason.trim();
    if (reason.length < 3) throw new ReviewError(400, 'A reason is required');

    const challenge = await consumeChallenge(c, {
      challengeId: input.challengeId, nonce: input.nonce, memberId: actor.memberId, organisationId: actor.organisationId,
      verb: input.action, expenseId: e.id,
    });
    if (!challenge) throw new ReviewError(410, 'This action link has expired or was already used; reload the case to act again');
    if (challenge.expense_version !== e.version) throw new ReviewError(409, 'This expense changed since the link was issued; reload to see the latest');

    let corrections: Record<string, unknown> | null = null;
    if (input.action === 'CORRECT' || (input.action === 'APPROVE' && input.corrections?.paymentType)) {
      corrections = validateCorrections(input.corrections ?? {}, e);
    }
    await c.query(
      `INSERT INTO reviews (organisation_id, expense_id, reviewer_id, action, reason, expense_version, challenge_id, corrections)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [e.organisation_id, e.id, actor.memberId, input.action, reason, e.version, challenge.id, corrections ? JSON.stringify(corrections) : null],
    );
    const s = summary(e);
    const audit = (action: string, after: unknown) =>
      appendAudit(c, { organisationId: e.organisation_id, actorType: 'member', actorId: actor.memberId, action, entityType: 'expense', entityId: e.id, before: { state: e.state, version: e.version }, after });

    switch (input.action) {
      case 'APPROVE': {
        const paymentType = input.corrections?.paymentType ?? e.payment_type;
        if (paymentType === 'UNKNOWN') throw new ReviewError(400, 'Say whether this was paid on a company card or personally before approving');
        if (paymentType !== e.payment_type) await c.query('UPDATE expenses SET payment_type = $2 WHERE id = $1', [e.id, paymentType]);
        await moveExpense(c, e.id, 'REVIEW_REQUIRED', 'APPROVED');
        await audit('expense.approved', { reason, paymentType, challengeId: challenge.id });
        await toEmployee(c, e, 'review-approved', reviewOutcomeMessage(s, 'APPROVED', reason), `${e.id}:${e.version}`);
        // Clearing is not paying: a personal expense now goes to the separate payment authorisation.
        if (paymentType === 'PERSONAL') await enqueue(c, 'authorise-reimbursement', { expenseId: e.id }, { organisationId: e.organisation_id, dedupeKey: `authorise:${e.id}:${e.version}` });
        else await enqueue(c, 'export-expense', { expenseId: e.id }, { organisationId: e.organisation_id, dedupeKey: `export:${e.id}` });
        return { state: 'APPROVED' };
      }
      case 'DECLINE': {
        await moveExpense(c, e.id, 'REVIEW_REQUIRED', 'REJECTED');
        await audit('expense.declined', { reason, challengeId: challenge.id });
        await toEmployee(c, e, 'review-declined', reviewOutcomeMessage(s, 'DECLINED', reason), `${e.id}:${e.version}`);
        return { state: 'REJECTED' };
      }
      case 'REQUEST_INFO': {
        const question = (input.question ?? '').trim();
        if (question.length < 5 || question.length > 1000) throw new ReviewError(400, 'Write the question to send to the employee (5–1000 characters)');
        await c.query(`UPDATE open_questions SET status = 'CANCELED' WHERE expense_id = $1 AND status = 'OPEN'`, [e.id]);
        const token = newCorrelationToken();
        await c.query(
          `INSERT INTO open_questions (organisation_id, expense_id, kind, correlation_token, question_text, asked_by)
           VALUES ($1,$2,'REVIEWER_QUESTION',$3,$4,$5)`,
          [e.organisation_id, e.id, token, question, actor.memberId],
        );
        await moveExpense(c, e.id, 'REVIEW_REQUIRED', 'NEEDS_INFO');
        await audit('expense.info_requested', { reason, question, challengeId: challenge.id });
        const origin = await originOf(c, e);
        if (origin) {
          const outboundId = await queueMessage(c, {
            organisationId: e.organisation_id, connectionId: origin.connectionId, channel: origin.channel, expenseId: e.id,
            recipientMemberId: e.member_id, recipientAddress: origin.address, template: 'reviewer-question',
            idempotencyKey: `reviewer-question:${e.id}:${e.version}`, rendered: reviewerQuestionMessage(s, actor.displayName, question),
            thread: origin.thread, replyToken: token,
          });
          if (outboundId) await c.query('UPDATE open_questions SET outbound_message_id = $2 WHERE correlation_token = $1', [token, outboundId]);
        }
        return { state: 'NEEDS_INFO' };
      }
      case 'CORRECT': {
        const fix = corrections!;
        const corrected = new Set<DecisionField>();
        if ('merchant' in fix) corrected.add('merchant');
        if ('amountMinor' in fix) corrected.add('amount').add('currency');
        if ('currency' in fix) corrected.add('currency');
        if ('date' in fix) corrected.add('date');
        await c.query(
          `UPDATE expenses SET merchant = coalesce($2, merchant), amount_minor = coalesce($3, amount_minor), currency = coalesce($4, currency),
                  expense_date = coalesce($5, expense_date), category = coalesce($6, category),
                  -- A reviewer's statement of how it was paid is evidence the re-check uses (like an employee's answer).
                  stated_payment_source = coalesce($7, stated_payment_source),
                  uncertain_fields = $8, flags = $9
            WHERE id = $1`,
          [
            e.id, fix.merchant ?? null, fix.amountMinor ?? null, fix.currency ?? null, fix.date ?? null, fix.category ?? null, fix.paymentType ?? null,
            e.uncertain_fields.filter((f) => !corrected.has(f)),
            // The reviewer has read the evidence: reading-related flags are resolved; others (injection, malformed file) stay.
            e.flags.filter((f) => !DATA_READING_FLAGS.includes(f)),
          ],
        );
        await moveExpense(c, e.id, 'REVIEW_REQUIRED', 'POLICY_CHECK');
        await audit('expense.corrected', { reason, corrections: fix, challengeId: challenge.id });
        // Re-run the same deterministic policy (same pinned version) on the corrected facts.
        await enqueue(c, 'evaluate-expense', { expenseId: e.id }, { organisationId: e.organisation_id, dedupeKey: `evaluate:${e.id}:corrected:${e.version}` });
        return { state: 'POLICY_CHECK' };
      }
    }
  });
}

function validateCorrections(input: Corrections, e: ExpenseRow): Record<string, string | number> & { amountMinor?: number } {
  const out: Record<string, string | number> & { amountMinor?: number } = {};
  if (input.merchant?.trim()) out.merchant = input.merchant.trim().slice(0, 200);
  const currency = (input.currency?.trim().toUpperCase() || e.currency) ?? null;
  if (input.amount?.trim()) {
    if (!currency) throw new ReviewError(400, 'Give a currency with the amount');
    const m = parseDecimalToMinor(input.amount.trim(), currency);
    if (!m || m.amountMinor <= 0) throw new ReviewError(400, 'Amount must be a positive decimal like 42.10');
    out.amountMinor = m.amountMinor;
    out.currency = currency;
  } else if (input.currency?.trim()) {
    if (!/^[A-Z]{3}$/.test(currency!)) throw new ReviewError(400, 'Currency must be a 3-letter code');
    out.currency = currency!;
  }
  if (input.date?.trim()) {
    if (!isIsoDate(input.date.trim())) throw new ReviewError(400, 'Date must be YYYY-MM-DD');
    out.date = input.date.trim();
  }
  if (input.category?.trim()) {
    if (!(CATEGORIES as readonly string[]).includes(input.category)) throw new ReviewError(400, 'Unknown category');
    out.category = input.category as Category;
  }
  if (input.paymentType) out.paymentType = input.paymentType;
  if (!Object.keys(out).length) throw new ReviewError(400, 'No corrections given');
  return out;
}

/** The second, separate authorisation: a payment approver releases a reimbursement above auto-pay limits. */
export async function authorisePayment(
  deps: EngineDeps,
  actor: SessionMember,
  input: { reimbursementId: string; reason: string; challengeId: string; nonce: string },
): Promise<{ state: string }> {
  if (!/^[0-9a-f-]{36}$/.test(input.reimbursementId)) throw new ReviewError(404, 'Reimbursement not found');
  return withTransaction(deps.pool, async (c) => {
    await lockKey(c, `payout-limits:${actor.organisationId}`);
    const r = await c.query<{ id: string; expense_id: string; state: string; member_id: string; organisation_id: string; amount_minor: number }>(
      'SELECT id, expense_id, state, member_id, organisation_id, amount_minor FROM reimbursements WHERE id = $1 FOR UPDATE',
      [input.reimbursementId],
    );
    const reimb = r.rows[0];
    if (!reimb || reimb.organisation_id !== actor.organisationId) throw new ReviewError(404, 'Reimbursement not found');
    if (reimb.state !== 'ELIGIBILITY_CHECK') throw new ReviewError(409, `This payment is no longer awaiting authorisation (now ${reimb.state.toLowerCase().replace(/_/g, ' ')})`);
    const e = await lockExpense(c, reimb.expense_id);
    const { eligibility, policy } = await computeEligibility(c, deps, e);
    const allowed = canHumanAuthorisePayment(eligibility, { memberId: actor.memberId, roles: actor.roles, active: true }, reimb.member_id, input.reason);
    if (!allowed.allowed) throw new ReviewError(eligibility.payable ? 403 : 409, allowed.why);
    const challenge = await consumeChallenge(c, {
      challengeId: input.challengeId, nonce: input.nonce, memberId: actor.memberId, organisationId: actor.organisationId,
      verb: 'AUTHORISE_PAYMENT', expenseId: e.id, reimbursementId: reimb.id,
    });
    if (!challenge) throw new ReviewError(410, 'This action link has expired or was already used; reload to act again');

    await c.query(
      `INSERT INTO reimbursement_authorisations (reimbursement_id, kind, authorised_by, policy_version_id, checks, limits_snapshot, reason)
       VALUES ($1, 'HUMAN', $2, $3, $4, $5, $6)`,
      [reimb.id, actor.memberId, policy.id, JSON.stringify({ blockers: eligibility.blockers, humanRequired: eligibility.humanRequired, challengeId: challenge.id }), JSON.stringify(eligibility.limitsSnapshot), input.reason.trim()],
    );
    await moveReimbursement(c, reimb.id, 'ELIGIBILITY_CHECK', 'AUTHORIZED', 'PAYOUT_QUEUED');
    await appendAudit(c, {
      organisationId: e.organisation_id, actorType: 'member', actorId: actor.memberId, action: 'reimbursement.authorised', entityType: 'reimbursement',
      entityId: reimb.id, after: { kind: 'HUMAN', reason: input.reason.trim(), humanRequired: eligibility.humanRequired, amountMinor: reimb.amount_minor },
    });
    await enqueue(c, 'execute-payout', { reimbursementId: reimb.id }, { organisationId: e.organisation_id, dedupeKey: `payout:${reimb.id}`, maxAttempts: 8 });
    return { state: 'PAYOUT_QUEUED' };
  });
}

/** Mint a short-lived challenge for the reviewer viewing a case page (forms carry it). */
export async function pageChallenge(deps: EngineDeps, actor: SessionMember, p: { expenseId: string; purpose: ChallengePurpose; reimbursementId?: string | null }) {
  return withTransaction(deps.pool, (c) =>
    mintChallenge(c, { organisationId: actor.organisationId, expenseId: p.expenseId, reimbursementId: p.reimbursementId ?? null, memberId: actor.memberId, purpose: p.purpose, ttlMinutes: PAGE_CHALLENGE_TTL_MINUTES }),
  );
}
