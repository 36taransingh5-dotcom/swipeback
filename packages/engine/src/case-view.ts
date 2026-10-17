import { parsePolicyDocument, SAFETY_CLAUSES, type Finding } from '@swipeback/domain';
import type { SessionMember } from './auth.ts';
import type { EngineDeps } from './deps.ts';
import { ReviewError } from './review.ts';
import { reasonText } from './templates.ts';

/** Read models for the minimal review screen. Every query is scoped to the reviewer's organisation. */

export interface QueueItem {
  kind: 'EXPENSE_REVIEW' | 'PAYMENT_AUTHORISATION';
  expenseId: string;
  reimbursementId: string | null;
  ref: string;
  employee: string;
  merchant: string | null;
  amountMinor: number | null;
  currency: string | null;
  date: string | null;
  reasons: string[];
  since: Date;
  ownExpense: boolean;
}

export async function reviewQueue(deps: Pick<EngineDeps, 'pool'>, actor: SessionMember): Promise<{ items: QueueItem[]; handledAutomatically: number; waitingOnEmployees: number }> {
  const r = await deps.pool.query<{
    kind: QueueItem['kind']; expense_id: string; reimbursement_id: string | null; ref: string; employee: string; member_id: string;
    merchant: string | null; amount_minor: number | null; currency: string | null; expense_date: string | null; reason_codes: string[] | null; human_required: string[] | null; since: Date;
  }>(
    `SELECT 'EXPENSE_REVIEW' AS kind, e.id AS expense_id, NULL::uuid AS reimbursement_id, e.ref, m.display_name AS employee, e.member_id,
            e.merchant, e.amount_minor, e.currency, e.expense_date, d.reason_codes, NULL::text[] AS human_required, e.updated_at AS since
       FROM expenses e JOIN members m ON m.id = e.member_id LEFT JOIN policy_decisions d ON d.id = e.last_decision_id
      WHERE e.organisation_id = $1 AND e.state = 'REVIEW_REQUIRED'
     UNION ALL
     SELECT 'PAYMENT_AUTHORISATION', e.id, r.id, e.ref, m.display_name, e.member_id, e.merchant, r.amount_minor, r.currency, e.expense_date,
            NULL, (SELECT array_agg(x) FROM jsonb_array_elements_text(a.after->'humanRequired') x), r.updated_at
       FROM reimbursements r JOIN expenses e ON e.id = r.expense_id JOIN members m ON m.id = e.member_id
       LEFT JOIN LATERAL (SELECT after FROM audit_events WHERE entity_type = 'reimbursement' AND entity_id = r.id::text
                           AND action = 'reimbursement.awaiting_authorisation' ORDER BY seq DESC LIMIT 1) a ON true
      WHERE r.organisation_id = $1 AND r.state = 'ELIGIBILITY_CHECK'
      ORDER BY since`,
    [actor.organisationId],
  );
  const counts = await deps.pool.query<{ auto: number; waiting: number }>(
    `SELECT count(*) FILTER (WHERE state IN ('AUTO_CLEARED','EXPORTED') AND id NOT IN (SELECT expense_id FROM reviews))::int AS auto,
            count(*) FILTER (WHERE state IN ('NEEDS_INFO','NEEDS_MATCH'))::int AS waiting
       FROM expenses WHERE organisation_id = $1`,
    [actor.organisationId],
  );
  return {
    items: r.rows
      .filter((x) => (x.kind === 'PAYMENT_AUTHORISATION' ? actor.roles.includes('payment_approver') : actor.roles.some((ro) => ro === 'reviewer' || ro === 'admin')))
      .map((x) => ({
        kind: x.kind, expenseId: x.expense_id, reimbursementId: x.reimbursement_id, ref: x.ref, employee: x.employee, merchant: x.merchant,
        amountMinor: x.amount_minor, currency: x.currency, date: x.expense_date, since: x.since, ownExpense: x.member_id === actor.memberId,
        reasons: x.kind === 'PAYMENT_AUTHORISATION'
          ? (x.human_required ?? []).map((h) => h.toLowerCase().replace(/_/g, ' '))
          : (x.reason_codes ?? []).map(reasonText),
      })),
    handledAutomatically: counts.rows[0]!.auto,
    waitingOnEmployees: counts.rows[0]!.waiting,
  };
}

export interface CaseView {
  expense: {
    id: string; ref: string; state: string; version: number; employee: string; employeeEmail: string; memberId: string; merchant: string | null;
    amountMinor: number | null; currency: string | null; date: string | null; category: string | null; paymentType: string; businessPurpose: string | null;
    flags: string[]; uncertainFields: string[]; matchedTransaction: { descriptor: string; amountMinor: number; currency: string; date: string; last4: string } | null;
    policyVersion: number | null; createdAt: Date;
  };
  decision: { outcome: string; reasons: { code: string; text: string; clauseId: string; clauseText: string; detail: string }[]; decidedAt: Date } | null;
  extraction: { extractor: string; model: string | null; status: string; fields: { name: string; value: string | null; confidence: number; quote: string | null; uncertain: boolean }[]; notes: string[] } | null;
  evidence: { fileId: string; mime: string; filename: string | null; scan: string } | null;
  conversation: { direction: 'in' | 'out'; at: Date; who: string; subject: string | null; text: string }[];
  questions: { kind: string; status: string; question: string | null; answer: string | null }[];
  reimbursement: { id: string; state: string; amountMinor: number; currency: string; payoutRef: string | null; authorisation: { kind: string; by: string | null; reason: string | null } | null } | null;
  reviews: { action: string; reason: string; reviewer: string; at: Date }[];
  audit: { seq: number; at: Date; actor: string; action: string }[];
}

export async function loadCase(deps: Pick<EngineDeps, 'pool'>, actor: SessionMember, expenseId: string): Promise<CaseView> {
  if (!/^[0-9a-f-]{36}$/.test(expenseId)) throw new ReviewError(404, 'Expense not found');
  const q = deps.pool;
  const e = (
    await q.query(
      `SELECT e.*, m.display_name, m.email, pv.version AS policy_version, pv.rules,
              t.merchant_descriptor, t.amount_minor AS t_amount, t.currency AS t_currency, t.transacted_at, cd.last4 AS t_last4
         FROM expenses e JOIN members m ON m.id = e.member_id LEFT JOIN policy_versions pv ON pv.id = e.policy_version_id
         LEFT JOIN transactions t ON t.id = e.matched_transaction_id LEFT JOIN cards cd ON cd.id = t.card_id
        WHERE e.id = $1 AND e.organisation_id = $2`,
      [expenseId, actor.organisationId],
    )
  ).rows[0];
  if (!e) throw new ReviewError(404, 'Expense not found');
  const policy = e.rules ? parsePolicyDocument(e.rules) : null;
  const clause = (id: string) => policy?.clauses[id] ? `${id} ${policy.clauses[id]!.title}: ${policy.clauses[id]!.text}` : SAFETY_CLAUSES[id as keyof typeof SAFETY_CLAUSES] ? `${id}: ${SAFETY_CLAUSES[id as keyof typeof SAFETY_CLAUSES]}` : id;

  const d = e.last_decision_id
    ? (await q.query<{ outcome: string; reason_codes: string[]; sources: { findings: Finding[] }; decided_at: Date }>('SELECT outcome, reason_codes, sources, decided_at FROM policy_decisions WHERE id = $1', [e.last_decision_id])).rows[0]
    : undefined;
  const decisive = d ? (d.outcome === 'CLEAR' ? [] : d.sources.findings.filter((f) => d.reason_codes.includes(f.code))) : [];

  const ext = e.current_extraction_id
    ? (await q.query<{ extractor: string; model: string | null; status: string; fields: { receipt: Record<string, { value: unknown; confidence: number; evidence: { quote: string } | null }> | null; facts: { notes: string[]; uncertainFields: string[] } } }>(
        'SELECT extractor, model, status, fields FROM extractions WHERE id = $1', [e.current_extraction_id],
      )).rows[0]
    : undefined;
  const show = (v: unknown) => (v === null || v === undefined ? null : typeof v === 'object' ? ('amountMinor' in (v as object) ? `${((v as { amountMinor: number }).amountMinor / 100).toFixed(2)}${(v as { currency?: string }).currency ? ` ${(v as { currency: string }).currency}` : ''}` : JSON.stringify(v)) : String(v));
  const fieldNames: [string, string, string | null][] = [['merchant', 'Merchant', 'merchant'], ['total', 'Total', 'amount'], ['date', 'Date', 'date'], ['vatNumber', 'VAT number', null], ['receiptNumber', 'Receipt no.', null], ['cardLast4', 'Card', null], ['tender', 'Paid with', null], ['category', 'Category', null]];

  const evidence = e.receipt_id
    ? (await q.query<{ id: string; mime: string; original_filename: string | null; scan_status: string }>(
        'SELECT ef.id, ef.mime, ef.original_filename, ef.scan_status FROM receipts r JOIN evidence_files ef ON ef.id = r.evidence_file_id WHERE r.id = $1', [e.receipt_id],
      )).rows[0]
    : undefined;

  const convo = await q.query<{ direction: 'in' | 'out'; at: Date; who: string; subject: string | null; text: string }>(
    `SELECT 'in' AS direction, im.received_at AS at, im.sender_address AS who, im.subject, coalesce(im.text_sanitised, '') AS text
       FROM inbound_messages im WHERE im.organisation_id = $2
        AND (im.id = $3 OR im.id IN (SELECT answer_inbound_id FROM open_questions WHERE expense_id = $1))
     UNION ALL
     SELECT 'out', coalesce(o.sent_at, o.created_at), o.recipient_address, o.subject, o.body_text FROM outbound_messages o
      WHERE o.expense_id = $1 AND o.organisation_id = $2 AND o.template NOT LIKE 'reviewer-%'
     ORDER BY at`,
    [e.id, actor.organisationId, e.inbound_message_id],
  );
  const questions = await q.query<{ kind: string; status: string; question_text: string | null; answer_text: string | null }>(
    'SELECT kind, status, question_text, answer_text FROM open_questions WHERE expense_id = $1 ORDER BY created_at', [e.id],
  );
  const reimb = (await q.query<{ id: string; state: string; amount_minor: number; currency: string; simulated_payout_ref: string | null; kind: string | null; by_name: string | null; reason: string | null }>(
    `SELECT r.id, r.state, r.amount_minor, r.currency, r.simulated_payout_ref, a.kind, m.display_name AS by_name, a.reason
       FROM reimbursements r LEFT JOIN reimbursement_authorisations a ON a.reimbursement_id = r.id LEFT JOIN members m ON m.id = a.authorised_by
      WHERE r.expense_id = $1 AND r.state <> 'CANCELED'`, [e.id],
  )).rows[0];
  const reviews = await q.query<{ action: string; reason: string; display_name: string; created_at: Date }>(
    'SELECT rv.action, rv.reason, m.display_name, rv.created_at FROM reviews rv JOIN members m ON m.id = rv.reviewer_id WHERE rv.expense_id = $1 ORDER BY rv.created_at', [e.id],
  );
  const audit = await q.query<{ seq: number; created_at: Date; actor_type: string; actor_name: string | null; actor_id: string | null; action: string }>(
    `SELECT a.seq, a.created_at, a.actor_type, m.display_name AS actor_name, a.actor_id, a.action FROM audit_events a
       LEFT JOIN members m ON m.id::text = a.actor_id
      WHERE a.organisation_id = $1 AND ((a.entity_type = 'expense' AND a.entity_id = $2)
         OR (a.entity_type = 'reimbursement' AND a.entity_id IN (SELECT id::text FROM reimbursements WHERE expense_id = $3)))
      ORDER BY a.seq`,
    [actor.organisationId, e.id, e.id],
  );

  return {
    expense: {
      id: e.id, ref: e.ref, state: e.state, version: e.version, employee: e.display_name, employeeEmail: e.email, memberId: e.member_id, merchant: e.merchant,
      amountMinor: e.amount_minor, currency: e.currency, date: e.expense_date, category: e.category, paymentType: e.payment_type,
      businessPurpose: e.business_purpose, flags: e.flags, uncertainFields: e.uncertain_fields, policyVersion: e.policy_version, createdAt: e.created_at,
      matchedTransaction: e.merchant_descriptor ? { descriptor: e.merchant_descriptor, amountMinor: e.t_amount, currency: e.t_currency, date: (e.transacted_at as Date).toISOString().slice(0, 10), last4: e.t_last4 } : null,
    },
    decision: d ? {
      outcome: d.outcome,
      decidedAt: d.decided_at,
      reasons: (decisive.length ? decisive : d.reason_codes.map((code) => ({ code, clauseId: '', detail: '' } as unknown as Finding))).map((f) => ({
        code: f.code, text: reasonText(f.code), clauseId: f.clauseId, clauseText: f.clauseId ? clause(f.clauseId) : '', detail: f.detail,
      })),
    } : null,
    extraction: ext ? {
      extractor: ext.extractor, model: ext.model, status: ext.status, notes: ext.fields?.facts?.notes ?? [],
      fields: fieldNames.map(([key, label, decisionField]) => {
        const f = ext.fields?.receipt?.[key];
        return { name: label, value: show(f?.value), confidence: f?.confidence ?? 0, quote: f?.evidence?.quote ?? null, uncertain: !!decisionField && e.uncertain_fields.includes(decisionField) };
      }),
    } : null,
    evidence: evidence ? { fileId: evidence.id, mime: evidence.mime, filename: evidence.original_filename, scan: evidence.scan_status } : null,
    conversation: convo.rows,
    questions: questions.rows.map((x) => ({ kind: x.kind, status: x.status, question: x.question_text, answer: x.answer_text })),
    reimbursement: reimb ? { id: reimb.id, state: reimb.state, amountMinor: reimb.amount_minor, currency: reimb.currency, payoutRef: reimb.simulated_payout_ref, authorisation: reimb.kind ? { kind: reimb.kind, by: reimb.by_name, reason: reimb.reason } : null } : null,
    reviews: reviews.rows.map((r) => ({ action: r.action, reason: r.reason, reviewer: r.display_name, at: r.created_at })),
    audit: audit.rows.map((a) => ({ seq: a.seq, at: a.created_at, actor: a.actor_name ?? (a.actor_type === 'system' ? `Swipeback${a.actor_id ? ` (${a.actor_id})` : ''}` : `${a.actor_type}${a.actor_id ? `:${a.actor_id}` : ''}`), action: a.action })),
  };
}

/** Evidence bytes for an authenticated reviewer, scoped to their organisation. */
export async function loadEvidence(deps: Pick<EngineDeps, 'pool' | 'evidence'>, actor: SessionMember, fileId: string): Promise<{ bytes: Buffer; mime: string } | null> {
  if (!/^[0-9a-f-]{36}$/.test(fileId)) return null;
  const r = await deps.pool.query<{ storage_key: string; mime: string; scan_status: string }>(
    'SELECT storage_key, mime, scan_status FROM evidence_files WHERE id = $1 AND organisation_id = $2', [fileId, actor.organisationId],
  );
  const row = r.rows[0];
  if (!row || row.scan_status === 'REJECTED') return null;
  return { bytes: await deps.evidence.get(row.storage_key), mime: row.mime };
}
