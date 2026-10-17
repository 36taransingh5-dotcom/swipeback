import { appendAudit, enqueue, PermanentJobError, withTransaction, type PoolClient } from '@swipeback/db';
import {
  addDays,
  dateInZone,
  decideExpense,
  detectDuplicates,
  ENGINE_VERSION,
  formatMoney,
  matchReceipt,
  money,
  parsePolicyDocument,
  resolvePaymentType,
  startOfIsoWeek,
  startOfMonth,
  type CardTransactionCandidate,
  type DecisionField,
  type ExpenseState,
  type IntegrityFlag,
  type PolicyDecision,
  type PolicyDocument,
  type QuestionKind,
} from '@swipeback/domain';
import { finaliseExtraction, TransientExtractionError, type ExtractionResult } from '@swipeback/extraction';
import { lockKey, moveExpense, type EngineDeps } from './deps.ts';
import { EMAIL_CHALLENGE_TTL_MINUTES, mintChallenge } from './challenges.ts';
import { newCorrelationToken } from './inbound.ts';
import { primaryEmailConnection, queueMessage } from './outbox.ts';
import {
  clauseText,
  clearedCardMessage,
  questionMessage,
  questionReminderMessage,
  reasonText,
  rejectedMessage,
  reviewerNotice,
  underReviewMessage,
  type ExpenseSummary,
} from './templates.ts';

export interface ExpenseRow {
  id: string;
  organisation_id: string;
  ref: string;
  member_id: string;
  source_channel: string | null;
  payment_type: 'UNKNOWN' | 'CORPORATE' | 'PERSONAL';
  category: string | null;
  merchant: string | null;
  amount_minor: number | null;
  currency: string | null;
  expense_date: string | null;
  business_purpose: string | null;
  receipt_id: string | null;
  matched_transaction_id: string | null;
  policy_version_id: string | null;
  state: ExpenseState;
  flags: IntegrityFlag[];
  version: number;
  inbound_message_id: string | null;
  sender_auth: string | null;
  card_last4: string | null;
  tender: 'CARD' | 'CASH' | 'UNKNOWN';
  has_vat_invoice: boolean;
  receipt_number: string | null;
  uncertain_fields: DecisionField[];
  stated_payment_source: 'CORPORATE' | 'PERSONAL' | null;
  match_choice: string | null;
  last_decision_id: string | null;
  created_at: Date;
  correlation_id: string;
}

export async function lockExpense(c: PoolClient, expenseId: string): Promise<ExpenseRow> {
  const r = await c.query<ExpenseRow>('SELECT * FROM expenses WHERE id = $1 FOR UPDATE', [expenseId]);
  if (!r.rows[0]) throw new PermanentJobError(`expense ${expenseId} not found`);
  return r.rows[0];
}

export function summary(e: Pick<ExpenseRow, 'ref' | 'merchant' | 'amount_minor' | 'currency' | 'expense_date'>): ExpenseSummary {
  return { ref: e.ref, merchant: e.merchant, amountMinor: e.amount_minor, currency: e.currency, date: e.expense_date };
}

// ---------------------------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------------------------

const EXTRACTABLE: readonly ExpenseState[] = ['RECEIVED', 'EXTRACTING', 'NEEDS_INFO', 'REJECTED'];

export async function extractReceipt(deps: EngineDeps, expenseId: string, opts: { finalAttempt: boolean }): Promise<string> {
  const prep = await withTransaction(deps.pool, async (c) => {
    const e = await lockExpense(c, expenseId);
    if (!EXTRACTABLE.includes(e.state)) return null;
    if (!e.receipt_id) throw new PermanentJobError(`expense ${e.ref} has no receipt`);
    await moveExpense(c, e.id, e.state, 'EXTRACTING');
    const r = await c.query<{ store_ref: string; mime: string; scan_status: string; source_kind: 'ATTACHMENT' | 'EMAIL_BODY' | 'CHAT_MEDIA'; file_hash: string; text_sanitised: string | null; subject: string | null }>(
      `SELECT r.store_ref, ef.mime, ef.scan_status, r.source_kind, r.file_hash, im.text_sanitised, im.subject
         FROM receipts r JOIN evidence_files ef ON ef.id = r.evidence_file_id
         LEFT JOIN inbound_messages im ON im.id = r.inbound_message_id
        WHERE r.id = $1`,
      [e.receipt_id],
    );
    return { e, receipt: r.rows[0]! };
  });
  if (!prep) return 'not extractable in current state';
  const { e, receipt } = prep;

  const ctx = { senderText: receipt.source_kind === 'EMAIL_BODY' ? '' : (receipt.text_sanitised ?? ''), subject: receipt.subject };
  let result: ExtractionResult;
  if (receipt.scan_status === 'REJECTED') {
    result = { status: 'FAILED', extractor: deps.extractor.name, model: null, receipt: null, sourceText: null, flags: ['MALFORMED_ATTACHMENT'], error: 'attachment failed screening', usage: null };
  } else {
    try {
      const bytes = await deps.evidence.get(receipt.store_ref);
      result = await deps.extractor.extract({ kind: receipt.source_kind === 'EMAIL_BODY' ? 'EMAIL_BODY' : 'ATTACHMENT', mime: receipt.mime, bytes, sha256: receipt.file_hash }, ctx);
    } catch (err) {
      // Model outage: retry with backoff via the job runner; on the last attempt fail closed into review.
      if (err instanceof TransientExtractionError && !opts.finalAttempt) throw err;
      result = { status: 'FAILED', extractor: deps.extractor.name, model: null, receipt: null, sourceText: null, flags: ['EXTRACTION_FAILED'], error: (err as Error).message.slice(0, 300), usage: null };
    }
  }
  const facts = finaliseExtraction(result, ctx);

  await withTransaction(deps.pool, async (c) => {
    const cur = await lockExpense(c, expenseId);
    if (cur.state !== 'EXTRACTING') return;
    let llmCallId: string | null = null;
    if (result.usage) {
      const l = await c.query<{ id: string }>(
        `INSERT INTO llm_calls (organisation_id, purpose, model, input_tokens, output_tokens, latency_ms, cost_micros, outcome)
         VALUES ($1, 'receipt_extraction', $2, $3, $4, $5, $6, $7) RETURNING id`,
        [e.organisation_id, result.model ?? 'unknown', result.usage.inputTokens, result.usage.outputTokens, result.usage.latencyMs, result.usage.costMicros, result.status === 'SUCCEEDED' ? 'OK' : 'INVALID_OUTPUT'],
      );
      llmCallId = l.rows[0]!.id;
    }
    const attempt = await c.query<{ n: number }>('SELECT count(*)::int + 1 AS n FROM extractions WHERE receipt_id = $1', [e.receipt_id]);
    const ext = await c.query<{ id: string }>(
      `INSERT INTO extractions (receipt_id, attempt, extractor, model, status, fields, flags, error, llm_call_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [e.receipt_id, attempt.rows[0]!.n, result.extractor, result.model, result.status, JSON.stringify({ receipt: result.receipt, facts }), facts.flags, result.error, llmCallId],
    );
    await c.query(
      `UPDATE expenses SET merchant = $2, amount_minor = $3, currency = $4, expense_date = $5, category = $6, card_last4 = $7,
              tender = $8, has_vat_invoice = $9, receipt_number = $10, uncertain_fields = $11, flags = $12, current_extraction_id = $13
        WHERE id = $1`,
      [
        e.id, facts.merchant, facts.amount?.amountMinor ?? null, facts.amount?.currency ?? null, facts.date, facts.category,
        facts.cardLast4, facts.tender, facts.hasVatInvoice, facts.receiptNumber, facts.uncertainFields, facts.flags, ext.rows[0]!.id,
      ],
    );
    await appendAudit(c, {
      organisationId: e.organisation_id, actorType: 'system', actorId: result.extractor, action: 'expense.extracted', entityType: 'expense',
      entityId: e.id, correlationId: e.correlation_id,
      after: { status: result.status, merchant: facts.merchant, amount: facts.amount, date: facts.date, category: facts.category, uncertain: facts.uncertainFields, flags: facts.flags, notes: facts.notes },
    });
    await enqueue(c, 'evaluate-expense', { expenseId: e.id }, { organisationId: e.organisation_id, dedupeKey: `evaluate:${e.id}:extraction:${ext.rows[0]!.id}` });
  });
  return `${result.status} via ${result.extractor}`;
}

// ---------------------------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------------------------

const EVALUABLE: readonly ExpenseState[] = ['EXTRACTING', 'NEEDS_MATCH', 'NEEDS_INFO', 'POLICY_CHECK'];

export async function loadPolicy(c: PoolClient, orgId: string, pinnedId: string | null): Promise<{ id: string; doc: PolicyDocument; timezone: string }> {
  const r = await c.query<{ id: string; rules: unknown; timezone: string }>(
    `SELECT pv.id, pv.rules, o.timezone FROM organisations o JOIN policy_versions pv ON pv.id = coalesce($2, o.active_policy_version_id)
      WHERE o.id = $1`,
    [orgId, pinnedId],
  );
  const row = r.rows[0];
  if (!row) throw new PermanentJobError(`organisation ${orgId} has no active policy`);
  return { id: row.id, doc: parsePolicyDocument(row.rules), timezone: row.timezone };
}

export async function evaluateExpense(deps: EngineDeps, expenseId: string): Promise<string> {
  return withTransaction(deps.pool, async (c) => {
    const pre = await c.query<{ organisation_id: string; member_id: string }>('SELECT organisation_id, member_id FROM expenses WHERE id = $1', [expenseId]);
    if (!pre.rows[0]) throw new PermanentJobError(`expense ${expenseId} not found`);
    // Serialise evaluations per member so cumulative limits cannot be raced.
    await lockKey(c, `member-limits:${pre.rows[0].member_id}`);
    const e = await lockExpense(c, expenseId);
    if (!EVALUABLE.includes(e.state)) return `no-op in ${e.state}`;

    const policy = await loadPolicy(c, e.organisation_id, e.policy_version_id);
    if (!e.policy_version_id) await c.query('UPDATE expenses SET policy_version_id = $2 WHERE id = $1', [e.id, policy.id]);
    const now = deps.clock.now();
    const asOf = dateInZone(now.toISOString(), policy.timezone);
    const amount = e.amount_minor !== null && e.currency ? money(e.amount_minor, e.currency) : null;

    // --- card matching -------------------------------------------------------------------
    const candidates = await cardCandidates(c, e, policy);
    const match = amount && e.expense_date
      ? matchReceipt({ memberId: e.member_id, total: amount, date: e.expense_date, merchant: e.merchant, cardLast4: e.card_last4 }, candidates, policy.doc.matching)
      : null;
    const cards = await c.query<{ last4: string }>(`SELECT last4 FROM cards WHERE organisation_id = $1 AND status = 'ACTIVE'`, [e.organisation_id]);
    const payment = resolvePaymentType({
      receiptCardLast4: e.card_last4,
      receiptTender: e.tender,
      companyCardLast4s: cards.rows.map((r) => r.last4),
      match,
      statedByEmployee: e.stated_payment_source,
      minutesSinceReceived: Math.floor((now.getTime() - e.created_at.getTime()) / 60_000),
      awaitCardFeedMinutes: policy.doc.matching.awaitCardFeedMinutes,
    });

    const duplicates = await findDuplicates(c, e, amount);

    // --- questions and spend ---------------------------------------------------------------
    const qs = await c.query<{ id: string; kind: QuestionKind; status: string }>('SELECT id, kind, status FROM open_questions WHERE expense_id = $1', [e.id]);
    const openQuestion = qs.rows.find((q) => q.status === 'OPEN') ?? null;
    const questionsAsked = qs.rows.filter((q) => q.status === 'ANSWERED' || q.status === 'EXPIRED').map((q) => q.kind);
    const spendBefore = await priorSpend(c, e, policy.doc.currency);
    const member = await c.query<{ status: string; display_name: string }>('SELECT status, display_name FROM members WHERE id = $1', [e.member_id]);

    const input = {
      asOf,
      expense: {
        category: (e.category as never) ?? null,
        amount,
        date: e.expense_date,
        merchant: e.merchant,
        businessPurpose: e.business_purpose,
        hasReceipt: e.receipt_id !== null,
        hasVatInvoice: e.has_vat_invoice,
        uncertainFields: e.uncertain_fields,
        flags: e.flags,
      },
      senderVerified: e.sender_auth === 'dkim_aligned' || e.sender_auth === 'platform_signed',
      memberActive: member.rows[0]?.status === 'ACTIVE',
      match,
      payment,
      duplicates,
      questionsAsked,
      spendBefore,
    };
    const outcome = decideExpense(policy.doc, input);

    if (outcome.kind === 'AWAIT_CARD_FEED') {
      const state = await moveExpense(c, e.id, e.state, ...(e.state === 'NEEDS_MATCH' ? [] : (['POLICY_CHECK', 'NEEDS_MATCH'] as const)));
      const runAt = Math.ceil(outcome.waitMinutes);
      await enqueue(c, 'evaluate-expense', { expenseId: e.id }, {
        organisationId: e.organisation_id, delayMs: runAt * 60_000, dedupeKey: `evaluate:${e.id}:await:${Math.floor(now.getTime() / 60_000) + runAt}`,
      });
      await appendAudit(c, {
        organisationId: e.organisation_id, actorType: 'system', action: 'expense.awaiting_card_feed', entityType: 'expense', entityId: e.id,
        after: { state, waitMinutes: outcome.waitMinutes, basis: payment.basis },
      });
      return `awaiting card feed (${outcome.waitMinutes} min)`;
    }

    const d = outcome.decision;
    // A still-open question of the same kind: keep waiting for the employee; never re-send it.
    if (d.outcome === 'REQUEST_INFO' && openQuestion && openQuestion.kind === d.question?.kind) return `still waiting on ${openQuestion.kind}`;

    const decision = await c.query<{ id: string }>(
      `INSERT INTO policy_decisions (organisation_id, expense_id, policy_version_id, outcome, reason_codes, clause_ids, sources, inputs_hash, engine_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [
        e.organisation_id, e.id, policy.id, d.outcome, d.reasonCodes, d.clauseIds,
        JSON.stringify({ findings: d.findings, match, payment, duplicates, spendBefore, question: d.question, asOf }),
        d.inputsHash, ENGINE_VERSION,
      ],
    );
    const matchedTxn = match?.status === 'MATCHED' ? match.transactionId : null;
    await c.query(
      `UPDATE expenses SET payment_type = $2, matched_transaction_id = $3, last_decision_id = $4 WHERE id = $1`,
      [e.id, payment.paymentType, matchedTxn, decision.rows[0]!.id],
    );
    const state = await moveExpense(c, e.id, e.state, ...(e.state === 'POLICY_CHECK' ? [] : (['POLICY_CHECK'] as const)), outcome.nextState);
    if (openQuestion && d.outcome !== 'REQUEST_INFO') {
      await c.query(`UPDATE open_questions SET status = 'CANCELED' WHERE id = $1`, [openQuestion.id]);
    }
    await appendAudit(c, {
      organisationId: e.organisation_id, actorType: 'system', actorId: ENGINE_VERSION, action: 'expense.decided', entityType: 'expense',
      entityId: e.id, correlationId: e.correlation_id, before: { state: e.state },
      after: { state, outcome: d.outcome, reasons: d.reasonCodes, clauses: d.clauseIds, paymentType: payment.paymentType, matchedTransactionId: matchedTxn, policyVersionId: policy.id, decisionId: decision.rows[0]!.id },
    });

    await sideEffects(c, deps, { ...e, payment_type: payment.paymentType, matched_transaction_id: matchedTxn }, state, d, policy.doc, member.rows[0]?.display_name ?? 'employee', openQuestion?.id ?? null);
    return `${d.outcome} -> ${state}`;
  });
}

/** Exact (same file) and possible (same merchant/date/total) duplicates across all members and channels. */
export async function findDuplicates(c: PoolClient, e: ExpenseRow, amount: ReturnType<typeof money> | null) {
  const fileHash = e.receipt_id ? (await c.query<{ file_hash: string }>('SELECT file_hash FROM receipts WHERE id = $1', [e.receipt_id])).rows[0]?.file_hash ?? null : null;
  const others = await c.query<{ id: string; file_hash: string | null; merchant: string | null; expense_date: string | null; amount_minor: number | null; currency: string | null; receipt_number: string | null }>(
    `SELECT e.id, r.file_hash, e.merchant, e.expense_date, e.amount_minor, e.currency, e.receipt_number
       FROM expenses e LEFT JOIN receipts r ON r.id = e.receipt_id
      WHERE e.organisation_id = $1 AND e.id <> $2 AND e.state <> 'REJECTED'
        AND (r.file_hash = $3 OR (e.expense_date = $4 AND e.amount_minor = $5))`,
    [e.organisation_id, e.id, fileHash, e.expense_date, e.amount_minor],
  );
  return detectDuplicates(
    { expenseId: e.id, fileHash, merchant: e.merchant, date: e.expense_date, total: amount, receiptNumber: e.receipt_number },
    others.rows.map((o) => ({
      expenseId: o.id, fileHash: o.file_hash, merchant: o.merchant, date: o.expense_date,
      total: o.amount_minor !== null && o.currency ? money(o.amount_minor, o.currency) : null, receiptNumber: o.receipt_number,
    })),
  );
}

async function cardCandidates(c: PoolClient, e: ExpenseRow, policy: { doc: PolicyDocument; timezone: string }): Promise<CardTransactionCandidate[]> {
  if (!e.expense_date || e.match_choice === 'NONE') return [];
  const from = addDays(e.expense_date, -policy.doc.matching.windowBeforeDays - 1);
  const to = addDays(e.expense_date, policy.doc.matching.windowAfterDays + 1);
  const r = await c.query<{ id: string; member_id: string | null; last4: string; amount_minor: number; currency: string; original_amount_minor: number | null; original_currency: string | null; merchant_descriptor: string; transacted_at: Date; matched_expense_id: string | null }>(
    `SELECT t.id, t.member_id, cd.last4, t.amount_minor, t.currency, t.original_amount_minor, t.original_currency, t.merchant_descriptor,
            t.transacted_at, (SELECT x.id FROM expenses x WHERE x.matched_transaction_id = t.id AND x.id <> $2) AS matched_expense_id
       FROM transactions t JOIN cards cd ON cd.id = t.card_id
      WHERE t.organisation_id = $1 AND t.member_id = $3 AND t.transacted_at >= $4::date AND t.transacted_at < ($5::date + 1)
        AND ($6::uuid IS NULL OR t.id = $6::uuid)`,
    [e.organisation_id, e.id, e.member_id, from, to, e.match_choice && e.match_choice !== 'NONE' ? e.match_choice : null],
  );
  return r.rows.map((t) => ({
    id: t.id,
    memberId: t.member_id,
    cardLast4: t.last4,
    amount: money(t.amount_minor, t.currency),
    original: t.original_amount_minor !== null && t.original_currency ? money(t.original_amount_minor, t.original_currency) : null,
    merchantDescriptor: t.merchant_descriptor,
    date: dateInZone(t.transacted_at.toISOString(), policy.timezone),
    matchedExpenseId: t.matched_expense_id,
  }));
}

async function priorSpend(c: PoolClient, e: ExpenseRow, currency: string): Promise<{ memberDay: number; memberWeek: number; categoryMonth: number }> {
  if (!e.expense_date) return { memberDay: 0, memberWeek: 0, categoryMonth: 0 };
  const week = startOfIsoWeek(e.expense_date);
  const month = startOfMonth(e.expense_date);
  const r = await c.query<{ day: number; week: number; cat: number }>(
    `SELECT coalesce(sum(amount_minor) FILTER (WHERE expense_date = $3), 0)::bigint AS day,
            coalesce(sum(amount_minor) FILTER (WHERE expense_date >= $4 AND expense_date < $4::date + 7), 0)::bigint AS week,
            coalesce(sum(amount_minor) FILTER (WHERE category = $6 AND expense_date >= $5 AND expense_date < ($5::date + interval '1 month')), 0)::bigint AS cat
       FROM expenses
      WHERE member_id = $1 AND id <> $2 AND currency = $7 AND amount_minor > 0
        AND state IN ('AUTO_CLEARED','APPROVED','EXPORTED','REVIEW_REQUIRED','NEEDS_INFO','NEEDS_MATCH','POLICY_CHECK')`,
    [e.member_id, e.id, e.expense_date, week, month, e.category, currency],
  );
  const row = r.rows[0]!;
  return { memberDay: row.day, memberWeek: row.week, categoryMonth: row.cat };
}

async function sideEffects(
  c: PoolClient,
  deps: EngineDeps,
  e: ExpenseRow,
  state: ExpenseState,
  d: PolicyDecision,
  policy: PolicyDocument,
  employeeName: string,
  previousQuestionId: string | null,
): Promise<void> {
  const origin = await originOf(c, e);
  const toEmployee = (template: string, rendered: { subject: string; text: string }, key: string, replyToken: string | null = null) =>
    origin
      ? queueMessage(c, {
          organisationId: e.organisation_id, connectionId: origin.connectionId, channel: origin.channel, expenseId: e.id,
          recipientMemberId: e.member_id, recipientAddress: origin.address, template, idempotencyKey: key, rendered,
          thread: origin.thread, replyToken,
        })
      : Promise.resolve(null);
  const s = summary(e);
  const decisionKey = `${e.id}:${e.version}`;

  if (state === 'AUTO_CLEARED') {
    if (e.payment_type === 'CORPORATE' && e.matched_transaction_id) {
      const t = await c.query<{ merchant_descriptor: string; transacted_at: Date }>('SELECT merchant_descriptor, transacted_at FROM transactions WHERE id = $1', [e.matched_transaction_id]);
      await toEmployee('cleared-card', clearedCardMessage(s, { descriptor: t.rows[0]!.merchant_descriptor, date: t.rows[0]!.transacted_at.toISOString().slice(0, 10) }), `cleared-card:${decisionKey}`);
      await enqueue(c, 'export-expense', { expenseId: e.id }, { organisationId: e.organisation_id, dedupeKey: `export:${e.id}` });
    } else if (e.payment_type === 'PERSONAL') {
      await enqueue(c, 'authorise-reimbursement', { expenseId: e.id }, { organisationId: e.organisation_id, dedupeKey: `authorise:${e.id}` });
    }
    return;
  }

  if ((state === 'NEEDS_INFO' || state === 'NEEDS_MATCH') && d.question) {
    if (previousQuestionId) await c.query(`UPDATE open_questions SET status = 'CANCELED' WHERE id = $1 AND status = 'OPEN'`, [previousQuestionId]);
    const token = newCorrelationToken();
    let options: { label: string }[] = [];
    if (d.question.kind === 'MATCH_CONFIRMATION' && d.question.options?.length) {
      const t = await c.query<{ id: string; merchant_descriptor: string; amount_minor: number; currency: string; transacted_at: Date; last4: string }>(
        `SELECT t.id, t.merchant_descriptor, t.amount_minor, t.currency, t.transacted_at, cd.last4 FROM transactions t JOIN cards cd ON cd.id = t.card_id WHERE t.id = ANY($1)`,
        [d.question.options],
      );
      options = d.question.options.map((id) => {
        const r = t.rows.find((x) => x.id === id)!;
        return { label: `${formatMoney(money(r.amount_minor, r.currency))} at ${r.merchant_descriptor} on ${r.transacted_at.toISOString().slice(0, 10)} (card ••${r.last4})` };
      });
    }
    await c.query(
      `INSERT INTO open_questions (organisation_id, expense_id, kind, correlation_token, options) VALUES ($1,$2,$3,$4,$5)`,
      [e.organisation_id, e.id, d.question.kind, token, JSON.stringify({ transactionIds: d.question.options ?? [] })],
    );
    const outboundId = await toEmployee('question', questionMessage(s, d.question.kind, clauseText(policy, d.question.clauseId), options), `question:${e.id}:${d.question.kind}`, token);
    if (outboundId) await c.query('UPDATE open_questions SET outbound_message_id = $2 WHERE correlation_token = $1', [token, outboundId]);
    await scheduleQuestionTimeout(c, deps, e.organisation_id, token, 'REMIND');
    return;
  }

  const reasons = d.reasonCodes.map(reasonText);
  const clauses = d.clauseIds.map((id) => clauseText(policy, id));
  if (state === 'REVIEW_REQUIRED') {
    await toEmployee('under-review', underReviewMessage(s, reasons), `under-review:${decisionKey}`);
    await notifyReviewers(c, deps, e, reviewerNotice(s, employeeName, reasons, clauses), `review:${decisionKey}`);
    return;
  }
  if (state === 'REJECTED') {
    await toEmployee('rejected', rejectedMessage(s, reasons, clauses), `rejected:${decisionKey}`);
  }
}

/**
 * Email finance an approval request. Each recipient gets their own one-time challenge link: it
 * opens the authenticated review page and is useless to anyone else (session + role still required).
 * With a reimbursementId the link authorises that payment; otherwise it reviews the expense.
 */
export async function notifyReviewers(
  c: PoolClient,
  deps: EngineDeps,
  e: Pick<ExpenseRow, 'id' | 'organisation_id' | 'member_id'>,
  rendered: { subject: string; text: string },
  key: string,
  role: 'reviewer' | 'payment_approver' = 'reviewer',
  reimbursementId: string | null = null,
): Promise<void> {
  const conn = await primaryEmailConnection(c, e.organisation_id);
  if (!conn) {
    await appendAudit(c, { organisationId: e.organisation_id, actorType: 'system', action: 'notification.no_channel', entityType: 'expense', entityId: e.id });
    return;
  }
  const reviewers = await c.query<{ id: string; email: string }>(
    `SELECT id, email FROM members WHERE organisation_id = $1 AND status = 'ACTIVE' AND $3 = ANY(roles) AND id <> $2`,
    [e.organisation_id, e.member_id, role],
  );
  for (const r of reviewers.rows) {
    const already = await c.query('SELECT 1 FROM outbound_messages WHERE idempotency_key = $1', [`${key}:${r.id}`]);
    if (already.rowCount) continue;
    const { challengeId, nonce } = await mintChallenge(c, {
      organisationId: e.organisation_id, expenseId: e.id, reimbursementId, memberId: r.id,
      purpose: reimbursementId ? 'PAYMENT_AUTHORISATION' : 'EXPENSE_REVIEW', ttlMinutes: EMAIL_CHALLENGE_TTL_MINUTES,
    });
    await queueMessage(c, {
      organisationId: e.organisation_id, connectionId: conn.id, channel: 'email', expenseId: e.id, recipientMemberId: r.id,
      recipientAddress: r.email, template: `reviewer-${role}`, idempotencyKey: `${key}:${r.id}`, rendered,
      kind: 'approval_request', reviewUrl: `${deps.config.appUrl}/a/${challengeId}?n=${nonce}`,
    });
  }
}

export async function scheduleQuestionTimeout(c: PoolClient, deps: EngineDeps, organisationId: string, token: string, stage: 'REMIND' | 'EXPIRE'): Promise<void> {
  const minutes = stage === 'REMIND' ? (deps.config.questionReminderMinutes ?? 24 * 60) : (deps.config.questionExpiryMinutes ?? 24 * 60);
  await enqueue(c, 'question-timeout', { token, stage }, { organisationId, delayMs: minutes * 60_000, dedupeKey: `question-timeout:${token}:${stage}` });
}

/**
 * One reminder, then expiry. An expired question is "asked and unresolved": the next evaluation
 * escalates to finance (never a second identical question, never silence).
 */
export async function questionTimeout(deps: EngineDeps, token: string, stage: 'REMIND' | 'EXPIRE'): Promise<string> {
  return withTransaction(deps.pool, async (c) => {
    const q = await c.query<{ id: string; expense_id: string; organisation_id: string; kind: QuestionKind; status: string; reminders_sent: number }>(
      'SELECT id, expense_id, organisation_id, kind, status, reminders_sent FROM open_questions WHERE correlation_token = $1 FOR UPDATE',
      [token],
    );
    const row = q.rows[0];
    if (!row || row.status !== 'OPEN') return 'no longer open';
    const e = await lockExpense(c, row.expense_id);
    if (stage === 'REMIND') {
      await c.query('UPDATE open_questions SET reminders_sent = reminders_sent + 1 WHERE id = $1', [row.id]);
      const origin = await originOf(c, e);
      if (origin) {
        await queueMessage(c, {
          organisationId: e.organisation_id, connectionId: origin.connectionId, channel: origin.channel, expenseId: e.id,
          recipientMemberId: e.member_id, recipientAddress: origin.address, template: 'question-reminder',
          idempotencyKey: `question-reminder:${row.id}`, rendered: questionReminderMessage(summary(e)), thread: origin.thread, replyToken: token,
        });
      }
      await scheduleQuestionTimeout(c, deps, row.organisation_id, token, 'EXPIRE');
      return 'reminded';
    }
    await c.query(`UPDATE open_questions SET status = 'EXPIRED' WHERE id = $1`, [row.id]);
    await appendAudit(c, { organisationId: e.organisation_id, actorType: 'system', action: 'question.expired', entityType: 'expense', entityId: e.id, after: { kind: row.kind } });
    if (row.kind === 'REVIEWER_QUESTION' && e.state === 'NEEDS_INFO') {
      await moveExpense(c, e.id, e.state, 'REVIEW_REQUIRED');
      await notifyReviewers(c, deps, e, reviewerNotice(summary(e), 'employee', ['your question was not answered in time'], []), `question-expired:${row.id}`);
    } else {
      await enqueue(c, 'evaluate-expense', { expenseId: e.id }, { organisationId: e.organisation_id, dedupeKey: `evaluate:${e.id}:expired:${row.id}` });
    }
    return 'expired';
  });
}

/** Where to reply to the employee: the channel and thread the expense arrived on. */
export async function originOf(c: PoolClient, e: Pick<ExpenseRow, 'inbound_message_id'>) {
  if (!e.inbound_message_id) return null;
  const r = await c.query<{ connection_id: string; channel: string; sender_address: string; thread_id: string | null; message_id: string | null; envelope: { conversation: { references: string[] } } }>(
    'SELECT connection_id, channel, sender_address, thread_id, message_id, envelope FROM inbound_messages WHERE id = $1',
    [e.inbound_message_id],
  );
  const i = r.rows[0];
  if (!i) return null;
  return {
    connectionId: i.connection_id,
    channel: i.channel,
    address: i.sender_address,
    thread: {
      threadId: i.thread_id,
      inReplyTo: i.message_id,
      references: [...(i.envelope.conversation.references ?? []), ...(i.message_id ? [i.message_id] : [])].slice(-20),
    },
  };
}
