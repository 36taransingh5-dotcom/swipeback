import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { appendAudit, enqueue, withTransaction } from '@swipeback/db';
import { dateInZone, matchReceipt, money, normaliseMerchant } from '@swipeback/domain';
import { lockKey, moveExpense, type EngineDeps } from './deps.ts';
import { loadPolicy } from './expense.ts';

/**
 * Company-card transaction intake. Every card source — the hackathon's signed simulator today, an
 * issuer or open-banking webhook later — is an adapter that verifies its own request and produces
 * a provider-neutral CardTransactionV1. Everything after that (idempotent storage, receipt
 * matching, the card-led expense, the receipt chase) is shared and provider-agnostic.
 */

export const cardTransactionV1Schema = z.object({
  schema: z.literal('swipeback.card_transaction.v1'),
  provider: z.string().min(1).max(50),
  providerTransactionId: z.string().min(1).max(200),
  cardLast4: z.string().regex(/^\d{4}$/),
  amountMinor: z.number().int().positive(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  originalAmountMinor: z.number().int().positive().nullable(),
  originalCurrency: z.string().regex(/^[A-Z]{3}$/).nullable(),
  merchantDescriptor: z.string().min(1).max(200),
  mcc: z.string().regex(/^\d{4}$/).nullable(),
  transactedAt: z.iso.datetime({ offset: true }),
  synthetic: z.boolean(),
});
export type CardTransactionV1 = z.infer<typeof cardTransactionV1Schema>;

export type CardFeedRejection = 'BAD_SIGNATURE' | 'STALE_TIMESTAMP' | 'MALFORMED';
export interface CardFeedAdapter {
  readonly provider: string;
  verify(rawBody: string, headers: Readonly<Record<string, string | undefined>>, now: Date): { ok: true; transaction: CardTransactionV1 } | { ok: false; reason: CardFeedRejection };
}

// ---- the hackathon card simulator (HMAC-signed webhook) -------------------------------------

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

export class CardSimulatorFeed implements CardFeedAdapter {
  readonly provider = 'card-sim';
  constructor(private readonly secret: string) {}

  verify(rawBody: string, headers: Readonly<Record<string, string | undefined>>, now: Date) {
    const m = /^t=(\d{1,12}),v1=([0-9a-f]{64})$/.exec(headers[CARD_SIGNATURE_HEADER] ?? '');
    if (!m) return { ok: false as const, reason: 'BAD_SIGNATURE' as const };
    const t = Number(m[1]);
    if (Math.abs(now.getTime() / 1000 - t) > 300) return { ok: false as const, reason: 'STALE_TIMESTAMP' as const };
    const expected = Buffer.from(signCardEvent(this.secret, rawBody, t).slice(-64), 'hex');
    if (!timingSafeEqual(expected, Buffer.from(m[2]!, 'hex'))) return { ok: false as const, reason: 'BAD_SIGNATURE' as const };
    let e: CardEvent;
    try {
      e = cardEventSchema.parse(JSON.parse(rawBody));
    } catch {
      return { ok: false as const, reason: 'MALFORMED' as const };
    }
    return {
      ok: true as const,
      transaction: {
        schema: 'swipeback.card_transaction.v1' as const, provider: e.provider, providerTransactionId: e.transactionId, cardLast4: e.cardLast4,
        amountMinor: e.amountMinor, currency: e.currency, originalAmountMinor: e.originalAmountMinor ?? null, originalCurrency: e.originalCurrency ?? null,
        merchantDescriptor: e.merchantDescriptor, mcc: e.mcc ?? null, transactedAt: e.transactedAt, synthetic: e.synthetic,
      },
    };
  }
}

export type CardEventOutcome =
  | { status: 'ACCEPTED'; transactionId: string; duplicate: boolean; memberId: string | null }
  | { status: 'REJECTED'; reason: CardFeedRejection | 'UNKNOWN_CARD' };

/** Simulator webhook entry point (PRD §7.4 POST /api/card-events). */
export async function receiveCardEvent(deps: EngineDeps, organisationId: string, rawBody: string, signature: string | undefined): Promise<CardEventOutcome> {
  const v = new CardSimulatorFeed(deps.config.cardFeedSecret).verify(rawBody, { [CARD_SIGNATURE_HEADER]: signature }, deps.clock.now());
  if (!v.ok) return { status: 'REJECTED', reason: v.reason };
  return ingestCardTransaction(deps, organisationId, v.transaction);
}

/** Provider-neutral: store the transaction exactly once and start the card workflow. */
export async function ingestCardTransaction(deps: EngineDeps, organisationId: string, input: CardTransactionV1): Promise<CardEventOutcome> {
  const event = cardTransactionV1Schema.parse(input);
  return withTransaction(deps.pool, async (c) => {
    const card = await c.query<{ id: string; member_id: string }>(
      `SELECT id, member_id FROM cards WHERE organisation_id = $1 AND last4 = $2 AND status = 'ACTIVE'`,
      [organisationId, event.cardLast4],
    );
    if (!card.rows[0]) return { status: 'REJECTED' as const, reason: 'UNKNOWN_CARD' as const };
    const ins = await c.query<{ id: string }>(
      `INSERT INTO transactions (organisation_id, provider, provider_transaction_id, card_id, member_id, amount_minor, currency,
          original_amount_minor, original_currency, merchant_descriptor, merchant_normalised, mcc, transacted_at, raw, feed_event, is_synthetic)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14,$15)
       ON CONFLICT (organisation_id, provider, provider_transaction_id) DO NOTHING RETURNING id`,
      [
        organisationId, event.provider, event.providerTransactionId, card.rows[0].id, card.rows[0].member_id, event.amountMinor, event.currency,
        event.originalAmountMinor, event.originalCurrency, event.merchantDescriptor, normaliseMerchant(event.merchantDescriptor),
        event.mcc, event.transactedAt, JSON.stringify(event), event.synthetic,
      ],
    );
    if (!ins.rows[0]) {
      const existing = await c.query<{ id: string }>('SELECT id FROM transactions WHERE organisation_id = $1 AND provider = $2 AND provider_transaction_id = $3', [organisationId, event.provider, event.providerTransactionId]);
      return { status: 'ACCEPTED' as const, transactionId: existing.rows[0]!.id, duplicate: true, memberId: card.rows[0].member_id };
    }
    const transactionId = ins.rows[0].id;
    await appendAudit(c, {
      organisationId, actorType: event.synthetic ? 'simulator' : 'provider', actorId: event.provider, action: 'transaction.received', entityType: 'transaction', entityId: transactionId,
      after: { amountMinor: event.amountMinor, currency: event.currency, merchant: event.merchantDescriptor, cardLast4: event.cardLast4, synthetic: event.synthetic },
    });
    await enqueue(c, 'card-transaction', { transactionId }, { organisationId, dedupeKey: `card-txn:${transactionId}` });
    return { status: 'ACCEPTED' as const, transactionId, duplicate: false, memberId: card.rows[0].member_id };
  });
}

/**
 * A card swipe either completes a receipt that already arrived, or opens a card-led expense that
 * waits for its receipt and chases the cardholder after the grace period. Never both: one
 * transaction backs at most one expense (unique index).
 */
export async function onCardTransaction(deps: EngineDeps, transactionId: string): Promise<string> {
  return withTransaction(deps.pool, async (c) => {
    const t = (
      await c.query<{ id: string; organisation_id: string; member_id: string; last4: string; amount_minor: number; currency: string; original_amount_minor: number | null; original_currency: string | null; merchant_descriptor: string; transacted_at: Date }>(
        `SELECT t.id, t.organisation_id, t.member_id, cd.last4, t.amount_minor, t.currency, t.original_amount_minor, t.original_currency, t.merchant_descriptor, t.transacted_at
           FROM transactions t JOIN cards cd ON cd.id = t.card_id WHERE t.id = $1`,
        [transactionId],
      )
    ).rows[0];
    if (!t) return 'transaction not found';
    await lockKey(c, `member-limits:${t.member_id}`); // serialise with receipt evaluations for this cardholder
    const owner = await c.query('SELECT 1 FROM expenses WHERE matched_transaction_id = $1', [t.id]);
    if (owner.rowCount) return 'already linked';

    const policy = await loadPolicy(c, t.organisation_id, null);
    const date = dateInZone(t.transacted_at.toISOString(), policy.timezone);
    const candidate = {
      id: t.id, memberId: t.member_id, cardLast4: t.last4, amount: money(t.amount_minor, t.currency),
      original: t.original_amount_minor !== null && t.original_currency ? money(t.original_amount_minor, t.original_currency) : null,
      merchantDescriptor: t.merchant_descriptor, date, matchedExpenseId: null,
    };

    // 1. A receipt that already arrived (receipt-first) and is waiting for this swipe.
    const waiting = await c.query<{ id: string; amount_minor: number | null; currency: string | null; expense_date: string | null; merchant: string | null; card_last4: string | null }>(
      `SELECT id, amount_minor, currency, expense_date, merchant, card_last4 FROM expenses
        WHERE organisation_id = $1 AND member_id = $2 AND matched_transaction_id IS NULL AND source_type <> 'CARD_FEED'
          AND state IN ('NEEDS_MATCH','NEEDS_INFO','POLICY_CHECK')`,
      [t.organisation_id, t.member_id],
    );
    const fits = waiting.rows.filter((w) =>
      w.amount_minor !== null && w.currency && w.expense_date &&
      matchReceipt({ memberId: t.member_id, total: money(w.amount_minor, w.currency), date: w.expense_date, merchant: w.merchant, cardLast4: w.card_last4 }, [candidate], policy.doc.matching).status !== 'NONE',
    );
    if (fits.length) {
      for (const w of fits) await enqueue(c, 'evaluate-expense', { expenseId: w.id }, { organisationId: t.organisation_id, dedupeKey: `evaluate:${w.id}:txn:${t.id}` });
      await appendAudit(c, { organisationId: t.organisation_id, actorType: 'system', action: 'transaction.receipt_already_received', entityType: 'transaction', entityId: t.id, after: { expenses: fits.map((f) => f.id) } });
      return `matched to ${fits.length} waiting receipt(s)`;
    }

    // 2. No receipt yet: open the card-led expense now, chase after the grace period.
    const exp = await c.query<{ id: string; ref: string }>(
      `INSERT INTO expenses (organisation_id, member_id, source_type, source_channel, payment_type, merchant, amount_minor, currency, expense_date,
          matched_transaction_id, policy_version_id, sender_auth, card_last4, tender, state)
       VALUES ($1,$2,'CARD_FEED','card-feed','CORPORATE',$3,$4,$5,$6,$7,$8,'platform_signed',$9,'CARD','RECEIVED') RETURNING id, ref`,
      [t.organisation_id, t.member_id, t.merchant_descriptor, t.amount_minor, t.currency, date, t.id, policy.id, t.last4],
    );
    const expenseId = exp.rows[0]!.id;
    await moveExpense(c, expenseId, 'RECEIVED', 'NEEDS_MATCH');
    await appendAudit(c, {
      organisationId: t.organisation_id, actorType: 'system', action: 'expense.created_from_card', entityType: 'expense', entityId: expenseId,
      after: { ref: exp.rows[0]!.ref, transactionId: t.id, amountMinor: t.amount_minor, currency: t.currency, merchant: t.merchant_descriptor, paymentType: 'CORPORATE' },
    });
    const grace = deps.config.receiptGraceMinutes ?? 60;
    await enqueue(c, 'receipt-chase', { expenseId }, { organisationId: t.organisation_id, delayMs: grace * 60_000, dedupeKey: `receipt-chase:${expenseId}` });
    return `card-led expense ${exp.rows[0]!.ref} created; receipt chase in ${grace} min`;
  });
}

/** Legacy job kind (queued before card-led expenses existed): re-evaluate waiting receipts. */
export async function rematchMember(deps: EngineDeps, p: { organisationId: string; memberId: string; transactionId: string }): Promise<string> {
  return withTransaction(deps.pool, async (c) => {
    const waiting = await c.query<{ id: string }>(
      `SELECT id FROM expenses WHERE organisation_id = $1 AND member_id = $2 AND state IN ('NEEDS_MATCH','NEEDS_INFO') AND source_type <> 'CARD_FEED'`,
      [p.organisationId, p.memberId],
    );
    for (const w of waiting.rows) {
      await enqueue(c, 'evaluate-expense', { expenseId: w.id }, { organisationId: p.organisationId, dedupeKey: `evaluate:${w.id}:txn:${p.transactionId}` });
    }
    return `re-evaluating ${waiting.rows.length}`;
  });
}
