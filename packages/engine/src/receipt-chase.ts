import { appendAudit, withTransaction } from '@swipeback/db';
import { clauseText, receiptRequestMessage } from './templates.ts';
import type { EngineDeps } from './deps.ts';
import { moveExpense } from './deps.ts';
import { loadPolicy, lockExpense, scheduleQuestionTimeout, summary } from './expense.ts';
import { newCorrelationToken } from './inbound.ts';
import { primaryEmailConnection, queueMessage } from './outbox.ts';

/**
 * After the grace period, ask the cardholder — once, by email, from the finance mailbox — for the
 * receipt of a card transaction that has none. A no-op if the receipt arrived in the meantime.
 * Reminder and expiry follow the standard question loop; expiry escalates to finance.
 */
export async function chaseReceipt(deps: EngineDeps, expenseId: string): Promise<string> {
  return withTransaction(deps.pool, async (c) => {
    const e = await lockExpense(c, expenseId);
    if (e.source_type !== 'CARD_FEED') return 'not a card-led expense';
    if (e.receipt_id || e.state !== 'NEEDS_MATCH') return `no chase needed (${e.receipt_id ? 'receipt received' : e.state})`;
    const asked = await c.query('SELECT 1 FROM open_questions WHERE expense_id = $1 AND kind = $2', [e.id, 'RECEIPT']);
    if (asked.rowCount) return 'already asked';

    const conn = await primaryEmailConnection(c, e.organisation_id);
    if (!conn) {
      // No mailbox to ask through: fail closed to finance rather than wait silently.
      await moveExpense(c, e.id, 'NEEDS_MATCH', 'REVIEW_REQUIRED');
      await appendAudit(c, { organisationId: e.organisation_id, actorType: 'system', action: 'receipt.chase_impossible', entityType: 'expense', entityId: e.id, after: { reason: 'no connected mailbox' } });
      return 'no mailbox: escalated';
    }
    const member = (await c.query<{ email: string }>('SELECT email FROM members WHERE id = $1', [e.member_id])).rows[0]!;
    const txn = (await c.query<{ merchant_descriptor: string; amount_minor: number; currency: string; transacted_at: Date; last4: string }>(
      'SELECT t.merchant_descriptor, t.amount_minor, t.currency, t.transacted_at, cd.last4 FROM transactions t JOIN cards cd ON cd.id = t.card_id WHERE t.id = $1',
      [e.matched_transaction_id],
    )).rows[0]!;
    const policy = await loadPolicy(c, e.organisation_id, e.policy_version_id);
    const token = newCorrelationToken();
    await c.query(
      `INSERT INTO open_questions (organisation_id, expense_id, kind, correlation_token, question_text) VALUES ($1, $2, 'RECEIPT', $3, $4)`,
      [e.organisation_id, e.id, token, `Receipt for ${txn.merchant_descriptor}`],
    );
    await moveExpense(c, e.id, 'NEEDS_MATCH', 'NEEDS_INFO');
    const outboundId = await queueMessage(c, {
      organisationId: e.organisation_id, connectionId: conn.id, channel: 'email', expenseId: e.id, recipientMemberId: e.member_id,
      recipientAddress: member.email, template: 'receipt-request', idempotencyKey: `receipt-request:${e.id}`,
      rendered: receiptRequestMessage(summary(e), { descriptor: txn.merchant_descriptor, amountMinor: txn.amount_minor, currency: txn.currency, date: e.expense_date ?? txn.transacted_at.toISOString().slice(0, 10), last4: txn.last4 }, clauseText(policy.doc, policy.doc.receipts.clause)),
      replyToken: token,
    });
    if (outboundId) await c.query('UPDATE open_questions SET outbound_message_id = $2 WHERE correlation_token = $1', [token, outboundId]);
    await appendAudit(c, { organisationId: e.organisation_id, actorType: 'system', action: 'receipt.requested', entityType: 'expense', entityId: e.id, after: { to: member.email, transactionId: e.matched_transaction_id } });
    await scheduleQuestionTimeout(c, deps, e.organisation_id, token, 'REMIND');
    return 'receipt requested';
  });
}
