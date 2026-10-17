import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { appendAudit, enqueue, withTransaction } from '@swipeback/db';
import { normaliseMerchant } from '@swipeback/domain';
import type { EngineDeps } from './deps.ts';

/**
 * Company-card transaction intake from the authenticated card-feed simulator (PRD §7.4
 * POST /api/card-events). Honest boundary: this is a simulator, not a live card integration.
 * Events are HMAC-signed, timestamp-checked and idempotent on the provider transaction id.
 */

export const CARD_SIGNATURE_HEADER = 'x-card-feed-signature';

export const cardEventSchema = z.object({
  provider: z.literal('card-sim'),
  transactionId: z.string().min(1).max(100),
  cardLast4: z.string().regex(/^\d{4}$/),
  amountMinor: z.number().int().positive(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  originalAmountMinor: z.number().int().positive().optional(),
  originalCurrency: z.string().regex(/^[A-Z]{3}$/).optional(),
  merchantDescriptor: z.string().min(1).max(100),
  mcc: z.string().regex(/^\d{4}$/).optional(),
  transactedAt: z.iso.datetime({ offset: true }),
  synthetic: z.literal(true),
});
export type CardEvent = z.infer<typeof cardEventSchema>;

export function signCardEvent(secret: string, body: string, unixSeconds: number): string {
  return `t=${unixSeconds},v1=${createHmac('sha256', secret).update(`${unixSeconds}.${body}`).digest('hex')}`;
}

export type CardEventOutcome =
  | { status: 'ACCEPTED'; transactionId: string; duplicate: boolean; memberId: string | null }
  | { status: 'REJECTED'; reason: 'BAD_SIGNATURE' | 'STALE_TIMESTAMP' | 'MALFORMED' | 'UNKNOWN_CARD' };

export async function receiveCardEvent(deps: EngineDeps, organisationId: string, rawBody: string, signature: string | undefined): Promise<CardEventOutcome> {
  const m = /^t=(\d{1,12}),v1=([0-9a-f]{64})$/.exec(signature ?? '');
  if (!m) return { status: 'REJECTED', reason: 'BAD_SIGNATURE' };
  const t = Number(m[1]);
  if (Math.abs(deps.clock.now().getTime() / 1000 - t) > 300) return { status: 'REJECTED', reason: 'STALE_TIMESTAMP' };
  const expected = Buffer.from(signCardEvent(deps.config.cardFeedSecret, rawBody, t).slice(-64), 'hex');
  if (!timingSafeEqual(expected, Buffer.from(m[2]!, 'hex'))) return { status: 'REJECTED', reason: 'BAD_SIGNATURE' };

  let event: CardEvent;
  try {
    event = cardEventSchema.parse(JSON.parse(rawBody));
  } catch {
    return { status: 'REJECTED', reason: 'MALFORMED' };
  }

  return withTransaction(deps.pool, async (c) => {
    const card = await c.query<{ id: string; member_id: string }>(
      `SELECT id, member_id FROM cards WHERE organisation_id = $1 AND last4 = $2 AND status = 'ACTIVE'`,
      [organisationId, event.cardLast4],
    );
    if (!card.rows[0]) return { status: 'REJECTED' as const, reason: 'UNKNOWN_CARD' as const };
    const ins = await c.query<{ id: string }>(
      `INSERT INTO transactions (organisation_id, provider, provider_transaction_id, card_id, member_id, amount_minor, currency,
          original_amount_minor, original_currency, merchant_descriptor, merchant_normalised, mcc, transacted_at, raw, is_synthetic)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,true)
       ON CONFLICT (organisation_id, provider, provider_transaction_id) DO NOTHING RETURNING id`,
      [
        organisationId, event.provider, event.transactionId, card.rows[0].id, card.rows[0].member_id, event.amountMinor, event.currency,
        event.originalAmountMinor ?? null, event.originalCurrency ?? null, event.merchantDescriptor, normaliseMerchant(event.merchantDescriptor),
        event.mcc ?? null, event.transactedAt, JSON.stringify(event),
      ],
    );
    if (!ins.rows[0]) {
      const existing = await c.query<{ id: string }>(
        'SELECT id FROM transactions WHERE organisation_id = $1 AND provider = $2 AND provider_transaction_id = $3',
        [organisationId, event.provider, event.transactionId],
      );
      return { status: 'ACCEPTED' as const, transactionId: existing.rows[0]!.id, duplicate: true, memberId: card.rows[0].member_id };
    }
    const transactionId = ins.rows[0].id;
    await appendAudit(c, {
      organisationId, actorType: 'simulator', actorId: 'card-sim', action: 'transaction.received', entityType: 'transaction', entityId: transactionId,
      after: { amountMinor: event.amountMinor, currency: event.currency, merchant: event.merchantDescriptor, cardLast4: event.cardLast4, synthetic: true },
    });
    // Out-of-order support: re-evaluate this member's expenses that are waiting for a card record.
    await enqueue(c, 'rematch-member', { organisationId, memberId: card.rows[0].member_id, transactionId }, { organisationId, dedupeKey: `rematch:${transactionId}` });
    return { status: 'ACCEPTED' as const, transactionId, duplicate: false, memberId: card.rows[0].member_id };
  });
}

export async function rematchMember(deps: EngineDeps, p: { organisationId: string; memberId: string; transactionId: string }): Promise<string> {
  return withTransaction(deps.pool, async (c) => {
    const waiting = await c.query<{ id: string }>(
      `SELECT id FROM expenses WHERE organisation_id = $1 AND member_id = $2 AND state IN ('NEEDS_MATCH','NEEDS_INFO')`,
      [p.organisationId, p.memberId],
    );
    for (const w of waiting.rows) {
      await enqueue(c, 'evaluate-expense', { expenseId: w.id }, { organisationId: p.organisationId, dedupeKey: `evaluate:${w.id}:txn:${p.transactionId}` });
    }
    return `re-evaluating ${waiting.rows.length}`;
  });
}
