import { randomBytes } from 'node:crypto';
import {
  InboundRejectedError,
  inboundMessageV1Schema,
  sha256Hex,
  type ConnectionContext,
  type InboundMessageV1,
  type RawInbound,
} from '@swipeback/channels';
import { appendAudit, enqueue, PermanentJobError, withTransaction, type PoolClient } from '@swipeback/db';
import { resolveIntent, type QuestionKind } from '@swipeback/domain';
import { statedPurpose } from '@swipeback/extraction';
import { moveExpense, type EngineDeps } from './deps.ts';
import { lockExpense, notifyReviewers, summary } from './expense.ts';
import { queueMessage } from './outbox.ts';
import { duplicateReceivedMessage, enrolmentMessage, helpMessage, reviewerNotice, statusMessage, describe as describeExpense } from './templates.ts';

/**
 * Channel-neutral intake. Every adapter's events arrive here as InboundMessage v1; nothing below
 * this line knows which channel a message came from except to reply on it.
 */

export type ReceiveOutcome =
  | { status: 'ACCEPTED'; inboundId: string; duplicate: boolean }
  | { status: 'IGNORED'; reason: string }
  | { status: 'REJECTED'; reason: string };

/** Verify + normalise a raw provider event with the connection's adapter, then ingest it. */
export async function receiveInbound(deps: EngineDeps, connectionId: string, raw: RawInbound): Promise<ReceiveOutcome> {
  const conn = await loadConnection(deps, connectionId);
  const adapter = deps.channels.adapterFor(conn.provider);
  try {
    const verified = await adapter.verifyInbound(conn, raw);
    const event = await adapter.normaliseInbound(verified);
    const r = await ingestInbound(deps, event);
    return { status: 'ACCEPTED', ...r };
  } catch (err) {
    if (!(err instanceof InboundRejectedError)) throw err;
    if (err.reason === 'NOT_ADDRESSED_TO_CONNECTION') return { status: 'IGNORED', reason: err.reason };
    await appendAudit(deps.pool, {
      organisationId: conn.tenantId, actorType: 'channel', actorId: conn.provider, action: 'inbound.rejected',
      entityType: 'channel_connection', entityId: connectionId, after: { reason: err.reason, detail: err.message.slice(0, 200) },
    });
    return { status: 'REJECTED', reason: err.reason };
  }
}

export async function loadConnection(deps: Pick<EngineDeps, 'pool'>, connectionId: string): Promise<ConnectionContext> {
  const r = await deps.pool.query<{ organisation_id: string; channel: ConnectionContext['channel']; provider: string; address: string; status: string }>(
    'SELECT organisation_id, channel, provider, address, status FROM channel_connections WHERE id = $1',
    [connectionId],
  );
  const row = r.rows[0];
  if (!row) throw new Error(`unknown connection ${connectionId}`);
  if (row.status !== 'ACTIVE') throw new Error(`connection ${connectionId} is ${row.status}`);
  return { tenantId: row.organisation_id, connectionId, channel: row.channel, provider: row.provider, address: row.address };
}

/** Persist the event exactly once (dedupe key), with its evidence, and schedule processing. */
export async function ingestInbound(deps: EngineDeps, input: InboundMessageV1): Promise<{ inboundId: string; duplicate: boolean }> {
  const event = inboundMessageV1Schema.parse(input);
  return withTransaction(deps.pool, async (c) => {
    const ins = await c.query<{ id: string }>(
      `INSERT INTO inbound_messages (organisation_id, connection_id, channel, provider_event_id, dedupe_key, thread_id,
          message_id, in_reply_to, sender_address, sender_display_name, sender_auth, subject, text_sanitised, envelope,
          correlation_id, received_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT DO NOTHING RETURNING id`,
      [
        event.tenantId, event.connectionId, event.channel, event.providerEventId, event.dedupeKey,
        event.conversation.threadId, event.conversation.messageId, event.conversation.inReplyTo,
        event.sender.channelAddress, event.sender.displayName, event.sender.authentication, event.subject,
        event.text.sanitised, JSON.stringify(event), event.correlationId, event.receivedAt,
      ],
    );
    if (!ins.rows[0]) {
      const existing = await c.query<{ id: string }>('SELECT id FROM inbound_messages WHERE dedupe_key = $1', [event.dedupeKey]);
      return { inboundId: existing.rows[0]!.id, duplicate: true };
    }
    const inboundId = ins.rows[0].id;
    for (const [i, a] of event.attachments.entries()) {
      const fileId = await upsertEvidence(c, event.tenantId, a.sha256, a.mime, a.sizeBytes, a.storageKey, a.filename, a.scan === 'REJECTED' ? 'REJECTED' : 'UNSCANNED');
      await c.query('INSERT INTO inbound_attachments (inbound_message_id, evidence_file_id, position) VALUES ($1, $2, $3)', [inboundId, fileId, i]);
    }
    await appendAudit(c, {
      organisationId: event.tenantId, actorType: 'channel', actorId: event.channel, action: 'inbound.received',
      entityType: 'inbound_message', entityId: inboundId, correlationId: event.correlationId,
      after: { channel: event.channel, providerEventId: event.providerEventId, sender: event.sender.channelAddress, senderAuth: event.sender.authentication, attachments: event.attachments.map((a) => a.sha256) },
    });
    await enqueue(c, 'process-inbound', { inboundId }, { organisationId: event.tenantId, dedupeKey: `inbound:${inboundId}`, correlationId: event.correlationId });
    return { inboundId, duplicate: false };
  });
}

async function upsertEvidence(
  c: PoolClient, orgId: string, sha256: string, mime: string, size: number, storageKey: string, filename: string | null, scan: string,
): Promise<string> {
  const r = await c.query<{ id: string }>(
    `INSERT INTO evidence_files (organisation_id, sha256, mime, size_bytes, storage_key, original_filename, scan_status)
     VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (organisation_id, sha256) DO NOTHING RETURNING id`,
    [orgId, sha256, mime, size, storageKey, filename, scan],
  );
  if (r.rows[0]) return r.rows[0].id;
  return (await c.query<{ id: string }>('SELECT id FROM evidence_files WHERE organisation_id = $1 AND sha256 = $2', [orgId, sha256])).rows[0]!.id;
}

const REQUIRED_AUTH: Readonly<Record<string, readonly string[]>> = {
  email: ['dkim_aligned'],
  synthetic: ['platform_signed'],
  slack: ['platform_signed'],
  whatsapp: ['platform_signed'],
  telegram: ['platform_signed'],
  imessage: ['platform_signed'],
};

const RECEIPT_MIME = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/heic', 'image/webp', 'text/plain', 'text/html']);
const MAX_RECEIPTS_PER_MESSAGE = 5;

interface InboundRow {
  id: string;
  organisation_id: string;
  connection_id: string;
  channel: string;
  processing_state: string;
  envelope: InboundMessageV1;
}

export async function processInbound(deps: EngineDeps, inboundId: string): Promise<string> {
  return withTransaction(deps.pool, async (c) => {
    const r = await c.query<InboundRow>('SELECT id, organisation_id, connection_id, channel, processing_state, envelope FROM inbound_messages WHERE id = $1 FOR UPDATE', [inboundId]);
    const row = r.rows[0];
    if (!row) throw new PermanentJobError(`inbound ${inboundId} not found`);
    if (row.processing_state !== 'RECEIVED') return `already ${row.processing_state}`;
    const ev = row.envelope;
    const org = ev.tenantId;
    const finish = async (state: string, note: string, extra: { memberId?: string; intent?: string } = {}) => {
      await c.query(
        `UPDATE inbound_messages SET processing_state = $2, processing_note = $3, member_id = $4, intent = $5, processed_at = clock_timestamp() WHERE id = $1`,
        [inboundId, state, note, extra.memberId ?? null, extra.intent ?? null],
      );
      return `${state}: ${note}`;
    };
    const reply = (template: string, rendered: { subject: string; text: string }, memberId: string | null, expenseId: string | null = null, keySuffix = '') =>
      queueMessage(c, {
        organisationId: org, connectionId: row.connection_id, channel: row.channel, expenseId,
        recipientMemberId: memberId, recipientAddress: ev.sender.channelAddress, template,
        idempotencyKey: `${template}:${inboundId}${keySuffix}`, rendered,
        thread: threadFor(ev),
      });

    // Anti-loop: never respond to auto-generated mail.
    if (ev.autoGenerated) return finish('IGNORED', 'auto-generated message');

    // Identity: enrolled address AND sufficient sender authentication. Display names are never used.
    const ident = await c.query<{ member_id: string; status: string; display_name: string }>(
      `SELECT ci.member_id, m.status, m.display_name FROM channel_identities ci JOIN members m ON m.id = ci.member_id
        WHERE ci.organisation_id = $1 AND ci.channel = $2 AND lower(ci.channel_address) = lower($3) AND ci.status = 'ACTIVE'`,
      [org, ev.channel, ev.sender.channelAddress],
    );
    const authOk = (REQUIRED_AUTH[ev.channel] ?? []).includes(ev.sender.authentication);
    const member = ident.rows[0];
    if (!authOk || !member || member.status !== 'ACTIVE') {
      const reason = !authOk ? 'sender authentication failed' : !member ? 'sender not enrolled' : 'member disabled';
      await appendAudit(c, {
        organisationId: org, actorType: 'channel', actorId: ev.channel, action: 'inbound.quarantined', entityType: 'inbound_message',
        entityId: inboundId, correlationId: ev.correlationId, after: { reason, sender: ev.sender.channelAddress, senderAuth: ev.sender.authentication },
      });
      // Only reply to authenticated-but-unknown senders (never to possibly spoofed addresses), at most daily.
      if (authOk && !member && !(await sentRecently(c, org, ev.sender.channelAddress, 'enrolment'))) {
        await reply('enrolment', enrolmentMessage(), null);
      }
      return finish('QUARANTINED', reason);
    }
    const memberId = member.member_id;

    // Is this an answer to an open question? Correlate by reply token, else by thread — and only for the same member.
    const question = await findOpenQuestion(c, org, ev, memberId);
    const receiptSources = ev.attachments.filter((a) => RECEIPT_MIME.has(a.mime)).slice(0, MAX_RECEIPTS_PER_MESSAGE);
    const bodyLooksLikeReceipt = receiptSources.length === 0 && /\b(total|amount paid)\b[^\n]{0,40}\d+\.\d{2}/i.test(ev.text.sanitised);
    const resolution = resolveIntent({
      verifiedAction: null, // signed actions are handled by the review flow (M5), never from free text
      openQuestion: question ? { kind: question.kind, options: question.optionIds } : null,
      hasReceiptAttachment: receiptSources.length > 0,
      bodyLooksLikeReceipt,
      text: ev.text.sanitised,
    });

    if (question) {
      const a = resolution.answer;
      if (a?.kind === 'PAYMENT_SOURCE') await c.query('UPDATE expenses SET stated_payment_source = $2 WHERE id = $1', [question.expenseId, a.value]);
      if (a?.kind === 'BUSINESS_PURPOSE') await c.query('UPDATE expenses SET business_purpose = $2 WHERE id = $1', [question.expenseId, a.value]);
      if (a?.kind === 'MATCH_CONFIRMATION') await c.query('UPDATE expenses SET match_choice = $2 WHERE id = $1', [question.expenseId, a.value]);
      let newReceiptId: string | null = null;
      if (a?.kind === 'RECEIPT' || a?.kind === 'VAT_INVOICE') {
        newReceiptId = await createReceipt(c, deps, row, ev, receiptSources[0] ?? null);
        await c.query('UPDATE expenses SET receipt_id = $2 WHERE id = $1', [question.expenseId, newReceiptId]);
      }
      await c.query(`UPDATE open_questions SET status = 'ANSWERED', answered_at = clock_timestamp(), answer_inbound_id = $2 WHERE id = $1`, [question.id, inboundId]);
      await c.query('INSERT INTO conversation_links (organisation_id, channel, thread_id, expense_id) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [
        org, ev.channel, ev.conversation.threadId ?? inboundId, question.expenseId,
      ]);
      await appendAudit(c, {
        organisationId: org, actorType: 'member', actorId: memberId, action: 'question.answered', entityType: 'expense',
        entityId: question.expenseId, correlationId: ev.correlationId,
        after: { kind: question.kind, understood: a !== null, answer: a && 'value' in a ? a.value : a?.kind ?? null },
      });
      if (question.kind === 'REVIEWER_QUESTION') {
        // A reviewer asked: the answer goes back to finance, not to the policy engine.
        await c.query('UPDATE open_questions SET answer_text = $2 WHERE id = $1', [question.id, a && 'value' in a ? a.value : null]);
        const exp = await lockExpense(c, question.expenseId);
        if (exp.state === 'NEEDS_INFO') {
          await moveExpense(c, exp.id, 'NEEDS_INFO', 'REVIEW_REQUIRED');
          await notifyReviewers(c, deps, exp, reviewerNotice(summary(exp), member.display_name, ['the employee answered your question'], []), `reviewer-answer:${inboundId}`);
        }
      } else {
        await enqueue(c, newReceiptId ? 'extract-receipt' : 'evaluate-expense', { expenseId: question.expenseId }, {
          organisationId: org, dedupeKey: `answer:${question.expenseId}:${inboundId}`,
        });
      }
      return finish('PROCESSED', `answered ${question.kind}`, { memberId, intent: resolution.intent });
    }

    if (resolution.intent === 'SUBMIT_RECEIPT') {
      const sources = receiptSources.length ? receiptSources : [null];
      const created: string[] = [];
      for (const [i, src] of sources.entries()) {
        // Same member re-sending the same file: link, don't duplicate (AC-09).
        if (src) {
          const dup = await c.query<{ id: string; ref: string; state: string; merchant: string | null; amount_minor: number | null; currency: string | null; expense_date: string | null }>(
            `SELECT e.id, e.ref, e.state, e.merchant, e.amount_minor, e.currency, e.expense_date FROM expenses e JOIN receipts r ON r.id = e.receipt_id
              WHERE e.organisation_id = $1 AND e.member_id = $2 AND r.file_hash = $3 ORDER BY e.created_at LIMIT 1`,
            [org, memberId, src.sha256],
          );
          const d = dup.rows[0];
          if (d) {
            await appendAudit(c, { organisationId: org, actorType: 'member', actorId: memberId, action: 'receipt.resubmitted', entityType: 'expense', entityId: d.id, after: { inboundId } });
            await reply('duplicate-received', duplicateReceivedMessage({ ref: d.ref, merchant: d.merchant, amountMinor: d.amount_minor, currency: d.currency, date: d.expense_date }, d.state), memberId, d.id, `:${i}`);
            continue;
          }
        }
        const receiptId = await createReceipt(c, deps, row, ev, src);
        const exp = await c.query<{ id: string; ref: string }>(
          `INSERT INTO expenses (organisation_id, member_id, source_type, source_channel, receipt_id, inbound_message_id,
              sender_auth, business_purpose, state, correlation_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'RECEIVED',$9) RETURNING id, ref`,
          [org, memberId, ev.channel === 'email' ? 'EMAIL' : 'CHAT', ev.channel, receiptId, inboundId, ev.sender.authentication, statedPurpose(ev.text.sanitised), ev.correlationId],
        );
        const expenseId = exp.rows[0]!.id;
        created.push(exp.rows[0]!.ref);
        await c.query('INSERT INTO conversation_links (organisation_id, channel, thread_id, expense_id) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [
          org, ev.channel, ev.conversation.threadId ?? inboundId, expenseId,
        ]);
        await appendAudit(c, {
          organisationId: org, actorType: 'member', actorId: memberId, action: 'expense.received', entityType: 'expense',
          entityId: expenseId, correlationId: ev.correlationId, after: { ref: exp.rows[0]!.ref, channel: ev.channel, receiptId },
        });
        await enqueue(c, 'extract-receipt', { expenseId }, { organisationId: org, dedupeKey: `extract:${expenseId}:${receiptId}`, correlationId: ev.correlationId });
      }
      return finish('PROCESSED', created.length ? `created ${created.join(', ')}` : 'resubmission linked', { memberId, intent: 'SUBMIT_RECEIPT' });
    }

    if (resolution.intent === 'EXPENSE_STATUS') {
      const recent = await c.query<{ ref: string; merchant: string | null; amount_minor: number | null; currency: string | null; expense_date: string | null; state: string }>(
        `SELECT ref, merchant, amount_minor, currency, expense_date, state FROM expenses WHERE organisation_id = $1 AND member_id = $2 ORDER BY created_at DESC LIMIT 5`,
        [org, memberId],
      );
      const lines = recent.rows.map((e) => `• ${describeExpense({ ref: e.ref, merchant: e.merchant, amountMinor: e.amount_minor, currency: e.currency, date: e.expense_date })}: ${e.state.toLowerCase().replace(/_/g, ' ')}`);
      await reply('status', statusMessage(lines), memberId);
      return finish('PROCESSED', 'status sent', { memberId, intent: 'EXPENSE_STATUS' });
    }

    if (!(await sentRecently(c, org, ev.sender.channelAddress, 'help'))) await reply('help', helpMessage(), memberId);
    return finish('PROCESSED', 'help', { memberId, intent: 'HELP' });
  });
}

function threadFor(ev: InboundMessageV1) {
  return {
    threadId: ev.conversation.threadId,
    inReplyTo: ev.conversation.messageId,
    references: [...ev.conversation.references, ...(ev.conversation.messageId ? [ev.conversation.messageId] : [])].slice(-20),
  };
}

async function sentRecently(c: PoolClient, org: string, address: string, template: string): Promise<boolean> {
  const r = await c.query(
    `SELECT 1 FROM outbound_messages WHERE organisation_id = $1 AND recipient_address = $2 AND template = $3 AND created_at > clock_timestamp() - interval '24 hours' LIMIT 1`,
    [org, address, template],
  );
  return (r.rowCount ?? 0) > 0;
}

async function findOpenQuestion(c: PoolClient, org: string, ev: InboundMessageV1, memberId: string) {
  const select = `SELECT oq.id, oq.kind, oq.options, oq.expense_id FROM open_questions oq JOIN expenses e ON e.id = oq.expense_id
                   WHERE oq.organisation_id = $1 AND oq.status = 'OPEN' AND e.member_id = $2`;
  let r = ev.conversation.correlationToken
    ? await c.query<{ id: string; kind: QuestionKind; options: { transactionIds?: string[] } | null; expense_id: string }>(`${select} AND oq.correlation_token = $3`, [org, memberId, ev.conversation.correlationToken])
    : null;
  if (!r?.rows[0]) {
    const threads = [ev.conversation.threadId, ...ev.conversation.references, ev.conversation.inReplyTo].filter((t): t is string => !!t);
    if (threads.length) {
      r = await c.query(
        `${select} AND oq.expense_id IN (SELECT expense_id FROM conversation_links WHERE organisation_id = $1 AND channel = $3 AND thread_id = ANY($4))
         ORDER BY oq.created_at DESC LIMIT 1`,
        [org, memberId, ev.channel, threads],
      );
    }
  }
  const q = r?.rows[0];
  return q ? { id: q.id, kind: q.kind, expenseId: q.expense_id, optionIds: q.options?.transactionIds ?? [] } : null;
}

async function createReceipt(c: PoolClient, deps: EngineDeps, row: InboundRow, ev: InboundMessageV1, src: InboundMessageV1['attachments'][number] | null): Promise<string> {
  if (src) {
    const file = await c.query<{ id: string }>('SELECT id FROM evidence_files WHERE organisation_id = $1 AND sha256 = $2', [ev.tenantId, src.sha256]);
    const r = await c.query<{ id: string }>(
      `INSERT INTO receipts (organisation_id, inbound_message_id, evidence_file_id, source_kind, file_hash, store_ref)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [ev.tenantId, row.id, file.rows[0]!.id, row.channel === 'email' ? 'ATTACHMENT' : 'CHAT_MEDIA', src.sha256, src.storageKey],
    );
    return r.rows[0]!.id;
  }
  // E-receipt in the message body: store the body text itself as immutable evidence.
  const bytes = Buffer.from(ev.text.sanitised, 'utf8');
  const stored = await deps.evidence.put(ev.tenantId, bytes);
  const fileId = await upsertEvidence(c, ev.tenantId, stored.sha256, 'text/plain', stored.sizeBytes, stored.storageKey, null, 'UNSCANNED');
  const r = await c.query<{ id: string }>(
    `INSERT INTO receipts (organisation_id, inbound_message_id, evidence_file_id, source_kind, file_hash, store_ref)
     VALUES ($1,$2,$3,'EMAIL_BODY',$4,$5) RETURNING id`,
    [ev.tenantId, row.id, fileId, stored.sha256, stored.storageKey],
  );
  return r.rows[0]!.id;
}

export function newCorrelationToken(): string {
  return randomBytes(9).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, 'x').slice(0, 12);
}

export { sha256Hex };
