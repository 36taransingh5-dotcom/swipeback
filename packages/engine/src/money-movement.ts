import { appendAudit, enqueue, PermanentJobError, withTransaction, type PoolClient } from '@swipeback/db';
import { dateInZone, evaluateReimbursementEligibility, money, startOfIsoWeek, startOfMonth } from '@swipeback/domain';
import { PayoutOutcomeUnknownError, type PayoutRecord } from '@swipeback/payouts';
import { lockKey, moveExpense, moveReimbursement, type EngineDeps } from './deps.ts';
import { findDuplicates, loadPolicy, lockExpense, notifyReviewers, originOf, summary, type ExpenseRow } from './expense.ts';
import { queueMessage } from './outbox.ts';
import { awaitingPaymentAuthorisationMessage, paidMessage, reviewerNotice, underReviewMessage } from './templates.ts';

/**
 * Money movement. Two separate authorisations (PRD §5): an expense being cleared does not imply a
 * payment. Every step is idempotent and fenced by row locks and state preconditions, and every
 * payout carries a unique idempotency key that the provider also honours.
 */

const PAYOUT_LEASE_MS = 30_000;

export async function authoriseReimbursement(deps: EngineDeps, expenseId: string): Promise<string> {
  return withTransaction(deps.pool, async (c) => {
    const pre = await c.query<{ organisation_id: string }>('SELECT organisation_id FROM expenses WHERE id = $1', [expenseId]);
    if (!pre.rows[0]) throw new PermanentJobError(`expense ${expenseId} not found`);
    // Cumulative auto-pay limits and the monthly budget are organisation-wide: serialise authorisations.
    await lockKey(c, `payout-limits:${pre.rows[0].organisation_id}`);
    const e = await lockExpense(c, expenseId);
    if (e.state !== 'AUTO_CLEARED' && e.state !== 'APPROVED') return `no-op in ${e.state}`;
    const live = await c.query<{ id: string; state: string }>(`SELECT id, state FROM reimbursements WHERE expense_id = $1 AND state <> 'CANCELED'`, [e.id]);
    if (live.rows[0] && live.rows[0].state !== 'DRAFT') return `already ${live.rows[0].state}`;

    const policy = await loadPolicy(c, e.organisation_id, e.policy_version_id);
    const member = await c.query<{ status: string; payout_enrolment_status: 'NOT_ENROLLED' | 'PENDING' | 'VERIFIED' | 'SUSPENDED'; display_name: string }>(
      'SELECT status, payout_enrolment_status, display_name FROM members WHERE id = $1',
      [e.member_id],
    );
    const dest = await c.query<{ id: string; member_id: string; verified_at: Date | null }>(
      `SELECT id, member_id, verified_at FROM payout_destinations WHERE member_id = $1 AND status = 'ACTIVE'`,
      [e.member_id],
    );
    const today = dateInZone(deps.clock.now().toISOString(), policy.timezone);
    const before = await priorReimbursements(c, e, today, policy.timezone);
    const amount = e.amount_minor !== null && e.currency ? money(e.amount_minor, e.currency) : null;
    const eligibility = evaluateReimbursementEligibility(policy.doc, {
      expense: {
        state: e.state,
        paymentType: e.payment_type,
        matchedTransactionId: e.matched_transaction_id,
        amount,
        memberId: e.member_id,
        flags: e.flags,
        uncertainFields: e.uncertain_fields,
      },
      member: { active: member.rows[0]?.status === 'ACTIVE', payoutEnrolment: member.rows[0]?.payout_enrolment_status ?? 'NOT_ENROLLED' },
      destination: dest.rows[0] ? { memberId: dest.rows[0].member_id, active: true, verified: dest.rows[0].verified_at !== null } : null,
      senderVerified: e.sender_auth === 'dkim_aligned' || e.sender_auth === 'platform_signed',
      duplicates: await findDuplicates(c, e, amount),
      hasLiveReimbursement: false,
      reimbursedBefore: before,
    });

    const s = summary(e);
    if (!eligibility.payable) {
      // Cleared but not payable (e.g. no verified payout destination): finance must see it.
      await moveExpense(c, e.id, e.state, 'REVIEW_REQUIRED');
      await appendAudit(c, {
        organisationId: e.organisation_id, actorType: 'system', action: 'reimbursement.blocked', entityType: 'expense', entityId: e.id,
        after: { blockers: eligibility.blockers, limits: eligibility.limitsSnapshot },
      });
      const reasons = eligibility.blockers.map((b) => b.toLowerCase().replace(/_/g, ' '));
      await notifyReviewers(c, deps, e, reviewerNotice(s, member.rows[0]?.display_name ?? 'employee', [`the payout is blocked (${reasons.join(', ')})`], []), `payout-blocked:${e.id}`);
      await toEmployee(c, e, 'under-review', underReviewMessage(s, ['the reimbursement needs finance to check your payout details']), `payout-blocked:${e.id}`);
      return `blocked: ${eligibility.blockers.join(', ')}`;
    }

    const reimbursementId =
      live.rows[0]?.id ??
      (
        await c.query<{ id: string }>(
          `INSERT INTO reimbursements (organisation_id, expense_id, member_id, payout_destination_id, amount_minor, currency, state, idempotency_key)
           VALUES ($1,$2,$3,$4,$5,$6,'DRAFT',$7) RETURNING id`,
          [e.organisation_id, e.id, e.member_id, dest.rows[0]!.id, amount!.amountMinor, amount!.currency, `swipeback:reimbursement:${e.id}:1`],
        )
      ).rows[0]!.id;
    await moveReimbursement(c, reimbursementId, 'DRAFT', 'ELIGIBILITY_CHECK');

    if (!eligibility.autoAuthorise) {
      await appendAudit(c, {
        organisationId: e.organisation_id, actorType: 'system', action: 'reimbursement.awaiting_authorisation', entityType: 'reimbursement',
        entityId: reimbursementId, after: { humanRequired: eligibility.humanRequired, limits: eligibility.limitsSnapshot },
      });
      await notifyReviewers(
        c, deps, e,
        reviewerNotice(s, member.rows[0]?.display_name ?? 'employee', [`the reimbursement needs a payment approver (${eligibility.humanRequired.join(', ').toLowerCase().replace(/_/g, ' ')})`], []),
        `payment-authorisation:${reimbursementId}`, 'payment_approver',
      );
      await toEmployee(c, e, 'awaiting-payment', awaitingPaymentAuthorisationMessage(s), `awaiting-payment:${reimbursementId}`);
      return `awaiting human authorisation: ${eligibility.humanRequired.join(', ')}`;
    }

    await c.query(
      `INSERT INTO reimbursement_authorisations (reimbursement_id, kind, policy_version_id, checks, limits_snapshot)
       VALUES ($1, 'AUTO', $2, $3, $4)`,
      [reimbursementId, policy.id, JSON.stringify({ blockers: [], humanRequired: [], clause: policy.doc.autoReimbursement.clause }), JSON.stringify(eligibility.limitsSnapshot)],
    );
    await moveReimbursement(c, reimbursementId, 'ELIGIBILITY_CHECK', 'AUTHORIZED', 'PAYOUT_QUEUED');
    await appendAudit(c, {
      organisationId: e.organisation_id, actorType: 'system', actorId: 'auto-authorisation', action: 'reimbursement.authorised', entityType: 'reimbursement',
      entityId: reimbursementId, after: { kind: 'AUTO', amount, limits: eligibility.limitsSnapshot, clause: policy.doc.autoReimbursement.clause },
    });
    await enqueue(c, 'execute-payout', { reimbursementId }, { organisationId: e.organisation_id, dedupeKey: `payout:${reimbursementId}`, maxAttempts: 8 });
    return 'authorised (auto)';
  });
}

async function priorReimbursements(c: PoolClient, e: ExpenseRow, today: string, tz: string) {
  const r = await c.query<{ day: number; week: number; month: number }>(
    `SELECT coalesce(sum(amount_minor) FILTER (WHERE member_id = $2 AND (created_at AT TIME ZONE $6)::date = $3), 0)::bigint AS day,
            coalesce(sum(amount_minor) FILTER (WHERE member_id = $2 AND (created_at AT TIME ZONE $6)::date >= $4 AND (created_at AT TIME ZONE $6)::date < $4::date + 7), 0)::bigint AS week,
            coalesce(sum(amount_minor) FILTER (WHERE (created_at AT TIME ZONE $6)::date >= $5), 0)::bigint AS month
       FROM reimbursements
      WHERE organisation_id = $1 AND expense_id <> $7 AND state IN ('AUTHORIZED','PAYOUT_QUEUED','SIMULATED_PAID','FAILED')`,
    [e.organisation_id, e.member_id, today, startOfIsoWeek(today), startOfMonth(today), tz, e.id],
  );
  const row = r.rows[0]!;
  return { memberDay: row.day, memberWeek: row.week, organisationMonth: row.month };
}

async function toEmployee(c: PoolClient, e: ExpenseRow, template: string, rendered: { subject: string; text: string }, key: string) {
  const origin = await originOf(c, e);
  if (!origin) return;
  await queueMessage(c, {
    organisationId: e.organisation_id, connectionId: origin.connectionId, channel: origin.channel, expenseId: e.id,
    recipientMemberId: e.member_id, recipientAddress: origin.address, template, idempotencyKey: `${template}:${key}`, rendered, thread: origin.thread,
  });
}

// ---------------------------------------------------------------------------------------------
// Payout execution
// ---------------------------------------------------------------------------------------------

export type PayoutRun = 'PAID' | 'DECLINED' | 'IN_FLIGHT' | 'NOOP' | 'RETRY';

interface ReimbursementRow {
  id: string;
  organisation_id: string;
  expense_id: string;
  amount_minor: number;
  currency: string;
  state: string;
  idempotency_key: string;
  provider_ref: string;
}

export async function executePayout(deps: EngineDeps, reimbursementId: string): Promise<PayoutRun> {
  // Phase 1: claim an attempt under the row lock. A fresh in-flight attempt by another worker wins.
  const claim = await withTransaction(deps.pool, async (c) => {
    const r = await c.query<ReimbursementRow>(
      `SELECT r.*, d.provider_ref FROM reimbursements r JOIN payout_destinations d ON d.id = r.payout_destination_id WHERE r.id = $1 FOR UPDATE OF r`,
      [reimbursementId],
    );
    const reimb = r.rows[0];
    if (!reimb) throw new PermanentJobError(`reimbursement ${reimbursementId} not found`);
    if (reimb.state !== 'PAYOUT_QUEUED') return { kind: 'NOOP' as const };
    const last = await c.query<{ id: string; attempt: number; status: string; created_at: Date }>(
      'SELECT id, attempt, status, created_at FROM payout_attempts WHERE reimbursement_id = $1 ORDER BY attempt DESC LIMIT 1',
      [reimbursementId],
    );
    const prev = last.rows[0];
    if (prev?.status === 'PENDING' && deps.clock.now().getTime() - prev.created_at.getTime() < PAYOUT_LEASE_MS) return { kind: 'IN_FLIGHT' as const };
    // A stale PENDING or UNKNOWN attempt: the provider may have paid. Resolve before any new request.
    const mustResolve = prev?.status === 'PENDING' || prev?.status === 'UNKNOWN';
    if (mustResolve) await c.query(`UPDATE payout_attempts SET status = 'UNKNOWN' WHERE id = $1`, [prev!.id]);
    const attempt = (prev?.attempt ?? 0) + 1;
    const ins = await c.query<{ id: string }>(
      `INSERT INTO payout_attempts (reimbursement_id, attempt, idempotency_key, provider, status, request, created_at)
       VALUES ($1,$2,$3,$4,'PENDING',$5, $6) RETURNING id`,
      [reimbursementId, attempt, reimb.idempotency_key, deps.payouts.name, JSON.stringify({ amountMinor: reimb.amount_minor, currency: reimb.currency, resolveFirst: mustResolve }), deps.clock.now()],
    );
    return { kind: 'CALL' as const, reimb, attemptId: ins.rows[0]!.id, mustResolve };
  });
  if (claim.kind !== 'CALL') return claim.kind;
  const { reimb, attemptId } = claim;

  // Phase 2: talk to the provider, outside any transaction.
  let record: PayoutRecord | null = null;
  try {
    if (claim.mustResolve) record = await deps.payouts.getPayout(reimb.idempotency_key);
    record ??= await deps.payouts.createPayout({
      idempotencyKey: reimb.idempotency_key,
      amountMinor: reimb.amount_minor,
      currency: reimb.currency,
      destinationRef: reimb.provider_ref,
      reference: `Swipeback reimbursement ${reimb.expense_id}`,
    });
  } catch (err) {
    const unknown = err instanceof PayoutOutcomeUnknownError;
    await deps.pool.query(
      `UPDATE payout_attempts SET status = $2, response = $3, completed_at = clock_timestamp() WHERE id = $1`,
      [attemptId, unknown ? 'UNKNOWN' : 'FAILED', JSON.stringify({ error: (err as Error).message })],
    );
    await appendAudit(deps.pool, {
      organisationId: reimb.organisation_id, actorType: 'provider', actorId: deps.payouts.name, action: unknown ? 'payout.outcome_unknown' : 'payout.provider_error',
      entityType: 'reimbursement', entityId: reimb.id, after: { error: (err as Error).message },
    });
    return 'RETRY';
  }

  // Phase 3: record the outcome.
  return withTransaction(deps.pool, async (c) => {
    const cur = await c.query<{ state: string }>('SELECT state FROM reimbursements WHERE id = $1 FOR UPDATE', [reimb.id]);
    await c.query(
      `UPDATE payout_attempts SET status = $2, provider_ref = $3, response = $4, completed_at = clock_timestamp() WHERE id = $1`,
      [attemptId, record.status, record.providerRef, JSON.stringify(record)],
    );
    if (cur.rows[0]!.state !== 'PAYOUT_QUEUED') return 'NOOP' as const;
    const e = await lockExpense(c, reimb.expense_id);
    if (record.status === 'SUCCEEDED') {
      await c.query('UPDATE reimbursements SET simulated_payout_ref = $2 WHERE id = $1', [reimb.id, record.providerRef]);
      await moveReimbursement(c, reimb.id, 'PAYOUT_QUEUED', 'SIMULATED_PAID');
      await appendAudit(c, {
        organisationId: reimb.organisation_id, actorType: 'provider', actorId: deps.payouts.name, action: 'reimbursement.simulated_paid',
        entityType: 'reimbursement', entityId: reimb.id, after: { providerRef: record.providerRef, amountMinor: reimb.amount_minor, currency: reimb.currency, simulated: deps.payouts.simulated },
      });
      await toEmployee(c, e, 'paid', paidMessage(summary(e), record.providerRef), reimb.id);
      await enqueue(c, 'export-expense', { expenseId: e.id }, { organisationId: e.organisation_id, dedupeKey: `export:${e.id}` });
      return 'PAID' as const;
    }
    await moveReimbursement(c, reimb.id, 'PAYOUT_QUEUED', 'FAILED');
    await moveExpense(c, e.id, e.state, 'REVIEW_REQUIRED');
    await appendAudit(c, {
      organisationId: reimb.organisation_id, actorType: 'provider', actorId: deps.payouts.name, action: 'reimbursement.payout_declined',
      entityType: 'reimbursement', entityId: reimb.id, after: { providerRef: record.providerRef },
    });
    await notifyReviewers(c, deps, e, reviewerNotice(summary(e), 'employee', ['the simulated payout was declined by the provider'], []), `payout-declined:${reimb.id}`, 'payment_approver');
    return 'DECLINED' as const;
  });
}

/** Called when the payout job exhausts its retries: never leave money state ambiguous silently. */
export async function failPayoutPermanently(deps: EngineDeps, reimbursementId: string, reason: string): Promise<void> {
  await withTransaction(deps.pool, async (c) => {
    const r = await c.query<{ state: string; organisation_id: string; expense_id: string }>('SELECT state, organisation_id, expense_id FROM reimbursements WHERE id = $1 FOR UPDATE', [reimbursementId]);
    const row = r.rows[0];
    if (!row || row.state !== 'PAYOUT_QUEUED') return;
    await moveReimbursement(c, reimbursementId, 'PAYOUT_QUEUED', 'FAILED');
    const e = await lockExpense(c, row.expense_id);
    await moveExpense(c, e.id, e.state, 'REVIEW_REQUIRED');
    await appendAudit(c, { organisationId: row.organisation_id, actorType: 'system', action: 'reimbursement.payout_failed', entityType: 'reimbursement', entityId: reimbursementId, after: { reason } });
    await notifyReviewers(c, deps, e, reviewerNotice(summary(e), 'employee', [`the simulated payout could not be completed (${reason}); check the provider before retrying`], []), `payout-failed:${reimbursementId}`, 'payment_approver');
  });
}

// ---------------------------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------------------------

const CSV_HEADER = 'ref,date,merchant,category,amount,currency,payment_type,vat_invoice,policy_version,decision_id,reimbursement_ref,synthetic';

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  // Neutralise spreadsheet formula injection from untrusted merchant names.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export async function exportExpense(deps: EngineDeps, expenseId: string): Promise<string> {
  return withTransaction(deps.pool, async (c) => {
    const e = await lockExpense(c, expenseId);
    if (e.state === 'EXPORTED') return 'already exported';
    if (e.state !== 'AUTO_CLEARED' && e.state !== 'APPROVED') return `no-op in ${e.state}`;
    const reimb = await c.query<{ state: string; simulated_payout_ref: string | null }>(`SELECT state, simulated_payout_ref FROM reimbursements WHERE expense_id = $1 AND state <> 'CANCELED'`, [e.id]);
    if (e.payment_type === 'PERSONAL' && reimb.rows[0]?.state !== 'SIMULATED_PAID') return 'waiting for payout';
    if (e.payment_type === 'UNKNOWN') return 'payment type unknown';
    const pv = await c.query<{ version: number }>('SELECT version FROM policy_versions WHERE id = $1', [e.policy_version_id]);
    const amount = e.amount_minor !== null && e.currency ? (e.amount_minor / 100).toFixed(2) : '';
    const row = [e.ref, e.expense_date, e.merchant, e.category, amount, e.currency, e.payment_type, e.has_vat_invoice, pv.rows[0]?.version, e.last_decision_id, reimb.rows[0]?.simulated_payout_ref ?? '', true].map(csvCell).join(',');
    const csv = Buffer.from(`${CSV_HEADER}\n${row}\n`, 'utf8');
    const stored = await deps.evidence.put(e.organisation_id, csv);
    const exp = await c.query<{ id: string }>(`INSERT INTO exports (organisation_id, kind, storage_key, row_count) VALUES ($1, 'ACCOUNTING_CSV', $2, 1) RETURNING id`, [e.organisation_id, stored.storageKey]);
    await c.query('INSERT INTO export_items (export_id, expense_id) VALUES ($1, $2)', [exp.rows[0]!.id, e.id]);
    await moveExpense(c, e.id, e.state, 'EXPORTED');
    await appendAudit(c, { organisationId: e.organisation_id, actorType: 'system', action: 'expense.exported', entityType: 'expense', entityId: e.id, after: { exportId: exp.rows[0]!.id, format: 'ACCOUNTING_CSV' } });
    return 'exported';
  });
}
