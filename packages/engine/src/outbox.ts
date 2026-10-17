import { appendAudit, enqueue, withTransaction, type PoolClient, type Queryable } from '@swipeback/db';
import type { EngineDeps } from './deps.ts';
import type { Rendered } from './templates.ts';

/**
 * Transactional outbox. Messages are recorded in the same transaction as the state change that
 * caused them, then delivered by a job. The idempotency key makes a retried decision unable to
 * send the same message twice. "Sent" means the provider accepted it — not that anyone read it.
 */

const MAX_PER_RECIPIENT_PER_HOUR = 20;

export interface QueueMessageInput {
  organisationId: string;
  connectionId: string;
  channel: string;
  expenseId: string | null;
  recipientMemberId: string | null;
  recipientAddress: string;
  template: string;
  idempotencyKey: string;
  rendered: Rendered;
  thread?: { threadId: string | null; inReplyTo: string | null; references: readonly string[]; subject?: string | null };
  replyToken?: string | null;
  kind?: 'message' | 'approval_request';
  reviewUrl?: string | null;
}

export async function queueMessage(c: PoolClient, m: QueueMessageInput): Promise<string | null> {
  const recent = await c.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM outbound_messages
      WHERE organisation_id = $1 AND recipient_address = $2 AND created_at > clock_timestamp() - interval '1 hour'
        AND delivery_state <> 'SUPPRESSED'`,
    [m.organisationId, m.recipientAddress],
  );
  const suppressed = recent.rows[0]!.n >= MAX_PER_RECIPIENT_PER_HOUR;
  // Email replies keep the employee's subject (Gmail only threads replies whose Subject matches);
  // the status line moves to the top of the body.
  let subject = m.rendered.subject;
  let body = m.rendered.text;
  if (m.channel === 'email' && m.thread?.inReplyTo) {
    const original = (m.thread.subject ?? '').trim() || 'Your receipt';
    subject = /^re:/i.test(original) ? original : `Re: ${original}`;
    body = `${m.rendered.subject}\n\n${m.rendered.text}`;
  }
  const r = await c.query<{ id: string }>(
    `INSERT INTO outbound_messages (organisation_id, channel, connection_id, expense_id, recipient_member_id,
        recipient_address, template, idempotency_key, subject, body_text, thread_id, in_reply_to, references_ids,
        delivery_state, kind, reply_token, review_url)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
    [
      m.organisationId, m.channel, m.connectionId, m.expenseId, m.recipientMemberId, m.recipientAddress, m.template,
      m.idempotencyKey, subject, body, m.thread?.threadId ?? null, m.thread?.inReplyTo ?? null,
      [...(m.thread?.references ?? [])], suppressed ? 'SUPPRESSED' : 'QUEUED', m.kind ?? 'message', m.replyToken ?? null,
      m.reviewUrl ?? null,
    ],
  );
  const id = r.rows[0]?.id;
  if (!id) return null; // already queued by an earlier attempt
  if (suppressed) {
    await appendAudit(c, {
      organisationId: m.organisationId, actorType: 'system', action: 'message.suppressed_rate_limit',
      entityType: 'outbound_message', entityId: id, after: { recipient: m.recipientAddress, template: m.template },
    });
    return id;
  }
  await enqueue(c, 'deliver-outbound', { outboundId: id }, { organisationId: m.organisationId, dedupeKey: `deliver:${id}` });
  return id;
}

interface OutboundRow {
  id: string;
  organisation_id: string;
  channel: string;
  connection_id: string;
  expense_id: string | null;
  recipient_address: string;
  subject: string | null;
  body_text: string;
  thread_id: string | null;
  in_reply_to: string | null;
  references_ids: string[];
  delivery_state: string;
  idempotency_key: string;
  kind: 'message' | 'approval_request';
  reply_token: string | null;
  review_url: string | null;
  template: string;
}

export async function deliverOutbound(deps: EngineDeps, outboundId: string): Promise<'SENT' | 'SKIPPED'> {
  const claimed = await withTransaction(deps.pool, async (c) => {
    const r = await c.query<OutboundRow & { provider: string; address: string }>(
      `SELECT o.*, cc.provider, cc.address FROM outbound_messages o JOIN channel_connections cc ON cc.id = o.connection_id
        WHERE o.id = $1 FOR UPDATE OF o`,
      [outboundId],
    );
    const row = r.rows[0];
    if (!row || row.delivery_state === 'SENT' || row.delivery_state === 'SUPPRESSED') return null;
    await c.query(`UPDATE outbound_messages SET delivery_state = 'SENDING', attempts = attempts + 1 WHERE id = $1`, [outboundId]);
    return row;
  });
  if (!claimed) return 'SKIPPED';

  const adapter = deps.channels.adapterFor(claimed.provider);
  const envelope = {
    tenantId: claimed.organisation_id,
    connectionId: claimed.connection_id,
    from: claimed.address,
    to: claimed.recipient_address,
    subject: claimed.subject,
    text: claimed.body_text,
    threadId: claimed.thread_id,
    inReplyTo: claimed.in_reply_to,
    references: claimed.references_ids,
    replyToken: claimed.reply_token,
    idempotencyKey: claimed.idempotency_key,
  };
  try {
    const result =
      claimed.kind === 'approval_request' && claimed.review_url
        ? await adapter.sendApprovalRequest({ ...envelope, reviewUrl: claimed.review_url, actions: ['APPROVE', 'DECLINE', 'REQUEST_INFO'] })
        : await adapter.sendMessage(envelope);
    await withTransaction(deps.pool, async (c) => {
      await c.query(
        `UPDATE outbound_messages SET delivery_state = 'SENT', provider_message_id = $2, sent_at = clock_timestamp(),
                thread_id = coalesce(thread_id, $3), rfc_message_id = $4, last_error = NULL WHERE id = $1`,
        [outboundId, result.providerMessageId, result.threadId, result.rfcMessageId ?? null],
      );
      // Replies to this message must correlate back to the expense.
      if (claimed.expense_id && result.threadId) {
        await c.query(
          `INSERT INTO conversation_links (organisation_id, channel, thread_id, expense_id) VALUES ($1, $2, $3, $4)
           ON CONFLICT DO NOTHING`,
          [claimed.organisation_id, claimed.channel, result.threadId, claimed.expense_id],
        );
      }
      if (claimed.expense_id && claimed.channel === 'email') {
        await c.query(
          `INSERT INTO conversation_links (organisation_id, channel, thread_id, expense_id) VALUES ($1, 'email', $2, $3)
           ON CONFLICT DO NOTHING`,
          [claimed.organisation_id, result.providerMessageId, claimed.expense_id],
        );
      }
      await appendAudit(c, {
        organisationId: claimed.organisation_id, actorType: 'system', action: 'message.sent',
        entityType: 'outbound_message', entityId: outboundId,
        after: { template: claimed.template, channel: claimed.channel, providerMessageId: result.providerMessageId },
      });
    });
    return 'SENT';
  } catch (err) {
    // Back to QUEUED with the error recorded; the job runner retries with backoff, then dead-letters
    // (at which point the message stays visibly undelivered — "sent" is never assumed).
    await deps.pool.query(`UPDATE outbound_messages SET delivery_state = 'QUEUED', last_error = $2 WHERE id = $1`, [
      outboundId,
      (err as Error).message.slice(0, 500),
    ]);
    throw err;
  }
}

export async function primaryEmailConnection(q: Queryable, organisationId: string): Promise<{ id: string; provider: string; address: string } | null> {
  const r = await q.query<{ id: string; provider: string; address: string }>(
    `SELECT id, provider, address FROM channel_connections
      WHERE organisation_id = $1 AND channel = 'email' AND status = 'ACTIVE' ORDER BY created_at LIMIT 1`,
    [organisationId],
  );
  return r.rows[0] ?? null;
}
