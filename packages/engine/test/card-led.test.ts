import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { verifyAuditChain } from '@swipeback/db';
import { chaseReceipt, questionTimeout } from '@swipeback/engine';
import { textReceipt } from '../../../test/fixtures/receipts.ts';
import { ALEX, createHarness, isoAt, SAM, ukDate, type Harness } from './harness.ts';

/**
 * Card-swipe-triggered receipt collection: the swipe opens the expense, Swipeback emails the
 * cardholder for the receipt after a grace period, the reply in the same thread completes it.
 * Company-card expenses never create reimbursements.
 */

const pret = (o: { total?: string; card?: string } = {}) =>
  textReceipt({
    merchant: 'Pret A Manger (Europe) Ltd', receiptNo: `P-${Math.floor(Math.random() * 1e6)}`, date: ukDate(1),
    items: [['Chicken caesar baguette', '6.25'], ['Flat white', '3.60'], ['Still water', '1.40']], total: o.total ?? '11.25', paidWith: { card: o.card ?? '4242' },
  });
const fuel = (o: { total?: string } = {}) =>
  textReceipt({ merchant: 'Shell Watford', receiptNo: `SH-${Math.floor(Math.random() * 1e6)}`, date: ukDate(1), items: [['Unleaded 40.1L', o.total ?? '58.40']], total: o.total ?? '58.40', paidWith: { card: '4242' } });
const attach = (text: string) => [{ filename: 'receipt.txt', mime: 'text/plain', content: text }];

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
  h.deps.config.receiptGraceMinutes = 30;
});
afterEach(async () => {
  expect((await verifyAuditChain(h.db.pool, h.org.organisationId)).ok).toBe(true);
  await h.close();
});

const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await h.db.pool.query(sql, params)).rows as T[];
const reimbursements = async () => (await q<{ n: number }>('SELECT count(*)::int AS n FROM reimbursements'))[0]!.n;
const cardLed = async () => (await q<{ id: string; state: string; receipt_id: string | null; flags: string[]; matched_transaction_id: string }>(`SELECT id, state, receipt_id, flags, matched_transaction_id FROM expenses WHERE source_type = 'CARD_FEED'`))[0]!;
/** Make delayed jobs (grace period, reminders) due now, then run everything. */
const fastForward = async (kind: string) => {
  await h.db.pool.query(`UPDATE jobs SET run_at = clock_timestamp() WHERE kind = $1 AND state = 'QUEUED'`, [kind]);
  await h.drain();
};
const fuelSwipe = () => h.card({ amountMinor: 5840, merchantDescriptor: 'SHELL WATFORD 123', transactedAt: isoAt(1) });

describe('swipe first, receipt later (the core company-card flow)', () => {
  it('opens the expense at the swipe, asks once after the grace period, completes from the in-thread reply, never reimburses', async () => {
    await fuelSwipe();
    await h.drain();
    let e = await cardLed();
    expect(e).toMatchObject({ state: 'NEEDS_MATCH', receipt_id: null });
    expect(h.sentTo(SAM)).toHaveLength(0); // nothing during the grace period
    const chase = (await q<{ run_at: Date }>(`SELECT run_at FROM jobs WHERE kind = 'receipt-chase'`))[0]!;
    expect(chase.run_at.getTime() - Date.now()).toBeGreaterThan(29 * 60_000);

    await fastForward('receipt-chase');
    const request = h.sentTo(SAM).at(-1)!;
    expect(request.envelope.subject).toMatch(/^Receipt needed: GBP 58\.40 at SHELL WATFORD 123 on \d{4}-\d{2}-\d{2} \[SB-\d+\]$/);
    expect(request.envelope.text).toContain('card ending 4242');
    expect(request.raw).toMatch(/Reply-To: <finance\+q-[a-z0-9]+@northwind\.example>/);
    expect((await cardLed()).state).toBe('NEEDS_INFO');

    await h.reply({ raw: request.raw, to: SAM }, { text: 'Here you go', attachments: attach(fuel()) });
    await h.drain();
    e = await cardLed();
    expect(e.state).toBe('EXPORTED');
    expect(e.receipt_id).not.toBeNull();
    const outcome = h.sentTo(SAM).at(-1)!;
    expect(outcome.envelope.subject).toMatch(/^Re: Receipt needed/); // same thread
    expect(outcome.envelope.text).toContain('cleared under policy');
    expect(await reimbursements()).toBe(0);
    expect((await q(`SELECT count(*)::int AS n FROM expenses`))[0]).toEqual({ n: 1 });

    // A reminder that comes due after resolution does nothing.
    const token = (await q<{ correlation_token: string }>(`SELECT correlation_token FROM open_questions`))[0]!.correlation_token;
    expect(await questionTimeout(h.deps, token, 'REMIND')).toBe('no longer open');
  });

  it('a receipt that does not match the card payment fails closed to finance', async () => {
    await fuelSwipe();
    await h.drain();
    await fastForward('receipt-chase');
    const request = h.sentTo(SAM).at(-1)!;
    await h.reply({ raw: request.raw, to: SAM }, { text: 'attached', attachments: attach(fuel({ total: '85.10' })) });
    await h.drain();
    const e = await cardLed();
    expect(e.state).toBe('REVIEW_REQUIRED');
    expect(e.flags).toContain('RECEIPT_TRANSACTION_MISMATCH');
    expect(e.matched_transaction_id).not.toBeNull(); // the card transaction stays the source of truth
    expect(await reimbursements()).toBe(0);
  });

  it('a reply without a receipt is not guessed: it escalates to finance instead of asking again', async () => {
    await fuelSwipe();
    await h.drain();
    await fastForward('receipt-chase');
    await h.reply({ raw: h.sentTo(SAM).at(-1)!.raw, to: SAM }, { text: 'Sorry, I lost it' });
    await h.drain();
    expect((await cardLed()).state).toBe('REVIEW_REQUIRED');
    expect((await q<{ reason_codes: string[] }>(`SELECT reason_codes FROM policy_decisions ORDER BY decided_at DESC LIMIT 1`))[0]!.reason_codes).toContain('QUESTION_UNRESOLVED');
    expect(h.sentTo(SAM).filter((m) => m.envelope.subject?.startsWith('Receipt needed'))).toHaveLength(1);
  });

  it('no reply: one reminder in the same thread, then expiry escalates to finance', async () => {
    await fuelSwipe();
    await h.drain();
    await fastForward('receipt-chase');
    await fastForward('question-timeout'); // REMIND
    const reminder = h.sentTo(SAM).at(-1)!;
    expect(reminder.envelope.subject).toMatch(/^Re: Receipt needed/);
    expect(reminder.envelope.text).toContain("we're waiting for your answer");
    await fastForward('question-timeout'); // EXPIRE
    expect((await cardLed()).state).toBe('REVIEW_REQUIRED');
    expect(h.sentTo(SAM).filter((m) => m.envelope.text.includes("we're waiting for your answer"))).toHaveLength(1);
    expect(await reimbursements()).toBe(0);
  });
});

describe('receipt before the swipe', () => {
  it('the swipe completes the waiting receipt; no second expense, no chase', async () => {
    await h.email({ text: 'Purpose: Lunch on site during the Acme install', attachments: attach(pret()) });
    await h.drain();
    expect((await q<{ state: string }>(`SELECT state FROM expenses`))[0]!.state).toBe('NEEDS_MATCH');
    await h.card({ amountMinor: 1125, merchantDescriptor: 'PRET A MANGER LONDON GB', transactedAt: isoAt(0) });
    await h.drain();
    const rows = await q<{ state: string; source_type: string; payment_type: string }>(`SELECT state, source_type, payment_type FROM expenses`);
    expect(rows).toEqual([{ state: 'EXPORTED', source_type: 'EMAIL', payment_type: 'CORPORATE' }]);
    expect((await q(`SELECT count(*)::int AS n FROM jobs WHERE kind = 'receipt-chase'`))[0]).toEqual({ n: 0 });
  });

  it('a receipt emailed separately after the swipe is merged into the waiting card expense (no duplicate, no chase)', async () => {
    await fuelSwipe();
    await h.drain();
    await h.email({ subject: 'fuel', attachments: attach(fuel()) });
    await h.drain();
    const rows = await q<{ state: string; source_type: string }>(`SELECT state, source_type FROM expenses ORDER BY created_at`);
    expect(rows).toEqual([{ state: 'EXPORTED', source_type: 'CARD_FEED' }, { state: 'MERGED', source_type: 'EMAIL' }]);
    await fastForward('receipt-chase');
    expect(h.sentTo(SAM).filter((m) => m.envelope.subject?.startsWith('Receipt needed'))).toHaveLength(0);
    expect(h.sentTo(SAM).at(-1)!.envelope.subject).toBe('Re: fuel'); // outcome in the employee's own thread
  });

  it('an unrelated receipt does not satisfy the card expense: both continue on their own', async () => {
    await fuelSwipe();
    await h.drain();
    await h.email({ attachments: attach(pret({ card: '9911' })) }); // personal lunch, different card
    await h.drain();
    expect((await cardLed()).state).toBe('NEEDS_MATCH');
    await fastForward('receipt-chase');
    expect(h.sentTo(SAM).some((m) => m.envelope.subject?.startsWith('Receipt needed: GBP 58.40'))).toBe(true);
  });
});

describe('duplicates, senders and money safety', () => {
  it('the same card webhook 5 times and the chase twice: one transaction, one expense, one email', async () => {
    await Promise.all(Array.from({ length: 5 }, () => h.card({ transactionId: 'txn-same', amountMinor: 5840, merchantDescriptor: 'SHELL WATFORD 123', transactedAt: isoAt(1) })));
    await h.drain();
    expect((await q(`SELECT count(*)::int AS n FROM transactions`))[0]).toEqual({ n: 1 });
    expect((await q(`SELECT count(*)::int AS n FROM expenses`))[0]).toEqual({ n: 1 });
    await fastForward('receipt-chase');
    expect(await chaseReceipt(h.deps, (await cardLed()).id)).toBe('no chase needed (NEEDS_INFO)');
    expect(h.sentTo(SAM).filter((m) => m.envelope.subject?.startsWith('Receipt needed'))).toHaveLength(1);
  });

  it('the same receipt reply delivered twice is processed once', async () => {
    await fuelSwipe();
    await h.drain();
    await fastForward('receipt-chase');
    const { buildReplyEml } = await import('@swipeback/channels/testing');
    const reply = buildReplyEml({ raw: h.sentTo(SAM).at(-1)!.raw, to: SAM }, { from: SAM, text: 'receipt', attachments: attach(fuel()) });
    await Promise.all([h.emailRaw(reply), h.emailRaw(reply)]);
    await h.drain();
    expect((await q(`SELECT count(*)::int AS n FROM inbound_messages`))[0]).toEqual({ n: 1 });
    expect((await q(`SELECT count(*)::int AS n FROM extractions`))[0]).toEqual({ n: 1 });
    expect((await cardLed()).state).toBe('EXPORTED');
  });

  it('a colleague replying, or a spoofed reply, does not answer the cardholder\'s request', async () => {
    await fuelSwipe();
    await h.drain();
    await fastForward('receipt-chase');
    const request = h.sentTo(SAM).at(-1)!;
    const { buildReplyEml } = await import('@swipeback/channels/testing');
    await h.emailRaw(buildReplyEml({ raw: request.raw, to: SAM }, { from: ALEX, text: 'here', attachments: attach(fuel()) }));
    await h.emailRaw(buildReplyEml({ raw: request.raw, to: SAM }, { from: SAM, auth: 'fail', text: 'here', attachments: attach(fuel()) }));
    await h.drain();
    expect((await cardLed()).state).toBe('NEEDS_INFO');
    expect((await q<{ status: string }>(`SELECT status FROM open_questions`))[0]!.status).toBe('OPEN');
    expect((await q<{ processing_state: string }>(`SELECT processing_state FROM inbound_messages WHERE sender_auth = 'none'`))[0]!.processing_state).toBe('QUARANTINED');
  });

  it('a swipe on an unknown card is rejected; a card-led expense can never be reimbursed', async () => {
    expect(await h.card({ cardLast4: '0000' })).toEqual({ status: 'REJECTED', reason: 'UNKNOWN_CARD' });
    await fuelSwipe();
    await h.drain();
    const e = await cardLed();
    await h.db.pool.query(`UPDATE expenses SET state = 'POLICY_CHECK' WHERE id = $1`, [e.id]);
    await h.db.pool.query(`UPDATE expenses SET state = 'AUTO_CLEARED' WHERE id = $1`, [e.id]);
    const attempt = h.db.pool.query(
      `INSERT INTO reimbursements (organisation_id, expense_id, member_id, payout_destination_id, amount_minor, currency, state, idempotency_key)
       VALUES ($1, $2, $3, $4, 5840, 'GBP', 'DRAFT', 'x')`,
      [h.org.organisationId, e.id, h.org.members.employee, h.org.payoutDestinations.employee],
    );
    await expect(attempt).rejects.toMatchObject({ code: 'SBI01' });
  });

  it('with no connected mailbox, the chase fails closed to finance rather than waiting silently', async () => {
    await fuelSwipe();
    await h.drain();
    await h.db.pool.query(`UPDATE channel_connections SET status = 'DISCONNECTED' WHERE channel = 'email'`);
    await fastForward('receipt-chase');
    expect((await cardLed()).state).toBe('REVIEW_REQUIRED');
  });
});
