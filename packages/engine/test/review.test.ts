import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { verifyAuditChain } from '@swipeback/db';
import {
  authorisePayment,
  consumeLoginToken,
  loadSession,
  pageChallenge,
  questionTimeout,
  requestLoginLink,
  reviewExpense,
  ReviewError,
  safeNextPath,
  type SessionMember,
} from '@swipeback/engine';
import { textReceipt } from '../../../test/fixtures/receipts.ts';
import { CONTROLLER, createHarness, SAM, ukDate, type Harness } from './harness.ts';

const attach = (text: string) => [{ filename: 'receipt.txt', mime: 'text/plain', content: text }];
const hotel = () => textReceipt({ merchant: 'Premier Stay Hotel Watford', receiptNo: `H-${Math.random()}`, date: ukDate(2), items: [['Room, 1 night', '210.00']], total: '210.00', vat: '35.00', vatNumber: 'GB000000000', paidWith: { card: '9911' } });
const costa = () => textReceipt({ merchant: 'Costa Coffee', receiptNo: `C-${Math.random()}`, date: ukDate(1), items: [['Latte', '3.95'], ['Toastie', '4.45']], total: '8.40', paidWith: { card: '9911' } });

let h: Harness;
let controller: SessionMember;
let opsManager: SessionMember;

async function member(id: string): Promise<SessionMember> {
  const r = await h.db.pool.query('SELECT id, organisation_id, email, display_name, roles FROM members WHERE id = $1', [id]);
  const m = r.rows[0];
  return { memberId: m.id, organisationId: m.organisation_id, email: m.email, displayName: m.display_name, roles: m.roles };
}

beforeEach(async () => {
  h = await createHarness();
  controller = await member(h.org.members.controller);
  opsManager = await member(h.org.members.opsManager);
});
afterEach(async () => {
  const audit = await verifyAuditChain(h.db.pool, h.org.organisationId);
  expect(audit.ok, JSON.stringify(audit.problems)).toBe(true);
  await h.close();
});

async function expenseInReview(): Promise<{ id: string; version: number }> {
  await h.email({ attachments: attach(hotel()) });
  await h.drain();
  const r = await h.db.pool.query<{ id: string; version: number; state: string }>('SELECT id, version, state FROM expenses');
  expect(r.rows[0]!.state).toBe('REVIEW_REQUIRED');
  return r.rows[0]!;
}

async function status(p: Promise<unknown>): Promise<number | 'ok'> {
  try {
    await p;
    return 'ok';
  } catch (err) {
    if (err instanceof ReviewError) return err.status;
    throw err;
  }
}

describe('reviewer authentication (magic link)', () => {
  it('a finance member gets a one-time link that opens an 8h session; the link cannot be reused', async () => {
    await requestLoginLink(h.deps, CONTROLLER.toUpperCase(), '/review/abc');
    await h.drain();
    const mail = h.sentTo(CONTROLLER).at(-1)!;
    const token = /auth\/callback\?t=([\w-]+)/.exec(mail.envelope.text)![1]!;
    const first = await consumeLoginToken(h.deps, token);
    expect(first).toMatchObject({ nextPath: '/review/abc', member: { email: CONTROLLER } });
    expect(await loadSession(h.deps, first!.sessionToken)).toMatchObject({ memberId: h.org.members.controller });
    expect(await consumeLoginToken(h.deps, token)).toBeNull();
  });

  it('employees and unknown addresses get nothing, and the response does not reveal which', async () => {
    await requestLoginLink(h.deps, SAM);
    await requestLoginLink(h.deps, 'nobody@northwind.example');
    await h.drain();
    expect(h.sentTo(SAM)).toHaveLength(0);
    expect(h.sentTo('nobody@northwind.example')).toHaveLength(0);
  });

  it('expired tokens fail; only same-site relative paths are allowed as the next page', async () => {
    await requestLoginLink(h.deps, CONTROLLER);
    await h.drain();
    const token = /t=([\w-]+)/.exec(h.sentTo(CONTROLLER).at(-1)!.envelope.text)![1]!;
    await h.db.pool.query(`UPDATE login_tokens SET expires_at = now() - interval '1 second'`);
    expect(await consumeLoginToken(h.deps, token)).toBeNull();
    expect(safeNextPath('//evil.example/x')).toBe('/review');
    expect(safeNextPath('https://evil.example')).toBe('/review');
    expect(safeNextPath('/a/123?n=x')).toBe('/a/123?n=x');
  });
});

describe('authenticated review decisions (AC-08)', () => {
  it('approval email carries a personal one-time link; approving clears but does not pay; a payment approver authorises separately; paid once', async () => {
    const e = await expenseInReview();
    const notice = h.sentTo(CONTROLLER).find((m) => m.kind === 'approval_request')!;
    const link = /\/a\/([0-9a-f-]{36})\?n=([\w-]+)/.exec(notice.envelope.text ?? '') ?? /\/a\/([0-9a-f-]{36})\?n=([\w-]+)/.exec(notice.raw);
    expect(link).not.toBeNull();

    // The ops manager (reviewer, not payment approver) approves with their own page challenge.
    const ch = await pageChallenge(h.deps, opsManager, { expenseId: e.id, purpose: 'EXPENSE_REVIEW' });
    await reviewExpense(h.deps, opsManager, { expenseId: e.id, action: 'APPROVE', reason: 'One-night stay for the Watford install; rate agreed with client', expectedVersion: e.version, ...ch });
    await h.drain();
    const r = (await h.db.pool.query('SELECT id, state FROM reimbursements')).rows[0];
    expect(r.state).toBe('ELIGIBILITY_CHECK');
    expect(await h.payouts.ledgerCount()).toBe(0);
    await expect(authorisePayment(h.deps, opsManager, { reimbursementId: r.id, reason: 'x', ...(await pageChallenge(h.deps, opsManager, { expenseId: e.id, purpose: 'PAYMENT_AUTHORISATION', reimbursementId: r.id })) })).rejects.toMatchObject({ status: 403 });

    const pay = await pageChallenge(h.deps, controller, { expenseId: e.id, purpose: 'PAYMENT_AUTHORISATION', reimbursementId: r.id });
    await authorisePayment(h.deps, controller, { reimbursementId: r.id, reason: 'Approved by ops; within accommodation budget', ...pay });
    await h.drain();
    expect((await h.db.pool.query('SELECT state FROM reimbursements')).rows[0].state).toBe('SIMULATED_PAID');
    expect((await h.db.pool.query('SELECT kind, reason FROM reimbursement_authorisations')).rows).toEqual([{ kind: 'HUMAN', reason: 'Approved by ops; within accommodation budget' }]);
    expect(await h.payouts.ledgerCount()).toBe(1);
    // Replaying the same authorisation cannot pay again.
    expect(await status(authorisePayment(h.deps, controller, { reimbursementId: r.id, reason: 'again', ...pay }))).toBe(409);
  });

  it('rejects reused, expired, stale, wrong-person, wrong-role and self-review attempts', async () => {
    const e = await expenseInReview();
    const ch = await pageChallenge(h.deps, controller, { expenseId: e.id, purpose: 'EXPENSE_REVIEW' });
    // Someone else's challenge.
    expect(await status(reviewExpense(h.deps, opsManager, { expenseId: e.id, action: 'APPROVE', reason: 'ok go', expectedVersion: e.version, ...ch }))).toBe(410);
    // Stale version.
    expect(await status(reviewExpense(h.deps, controller, { expenseId: e.id, action: 'APPROVE', reason: 'ok go', expectedVersion: e.version - 1, ...ch }))).toBe(409);
    // Expired.
    await h.db.pool.query(`UPDATE approval_challenges SET expires_at = now() - interval '1 second' WHERE id = $1`, [ch.challengeId]);
    expect(await status(reviewExpense(h.deps, controller, { expenseId: e.id, action: 'DECLINE', reason: 'Not within policy', expectedVersion: e.version, ...ch }))).toBe(410);
    // Missing reason.
    const ch2 = await pageChallenge(h.deps, controller, { expenseId: e.id, purpose: 'EXPENSE_REVIEW' });
    expect(await status(reviewExpense(h.deps, controller, { expenseId: e.id, action: 'DECLINE', reason: ' ', expectedVersion: e.version, ...ch2 }))).toBe(400);
    // Used once, then reuse fails.
    expect(await status(reviewExpense(h.deps, controller, { expenseId: e.id, action: 'DECLINE', reason: 'Room rate above policy; book via travel desk', expectedVersion: e.version, ...ch2 }))).toBe('ok');
    expect(await status(reviewExpense(h.deps, controller, { expenseId: e.id, action: 'APPROVE', reason: 'changed my mind', expectedVersion: e.version + 1, ...ch2 }))).toBe(409);
    // Employee role (no reviewer role).
    const employee: SessionMember = { ...controller, memberId: h.org.members.employee, roles: ['employee'] };
    expect(await status(reviewExpense(h.deps, employee, { expenseId: e.id, action: 'APPROVE', reason: 'mine', expectedVersion: e.version, ...ch2 }))).toBe(403);
    // Another tenant cannot even see it.
    const outsider: SessionMember = { ...controller, organisationId: '00000000-0000-0000-0000-000000000000' };
    expect(await status(reviewExpense(h.deps, outsider, { expenseId: e.id, action: 'APPROVE', reason: 'x', expectedVersion: e.version, ...ch2 }))).toBe(404);
    await h.drain();
    expect(h.sentTo(SAM).at(-1)!.envelope.text).toContain('Finance declined this expense');
  });

  it('a reviewer cannot decide their own expense', async () => {
    const { buildEml } = await import('@swipeback/channels/testing');
    await h.emailRaw(buildEml({ from: 'ops.manager@northwind.example', to: 'finance@northwind.example', attachments: attach(hotel()) }));
    await h.drain();
    const e = (await h.db.pool.query('SELECT id, version FROM expenses')).rows[0];
    const ch = await pageChallenge(h.deps, opsManager, { expenseId: e.id, purpose: 'EXPENSE_REVIEW' });
    expect(await status(reviewExpense(h.deps, opsManager, { expenseId: e.id, action: 'APPROVE', reason: 'my own trip', expectedVersion: e.version, ...ch }))).toBe(403);
  });

  it('every decision appends history; nothing earlier is rewritten', async () => {
    const e = await expenseInReview();
    const before = (await h.db.pool.query('SELECT seq, hash FROM audit_events ORDER BY seq')).rows;
    const ch = await pageChallenge(h.deps, controller, { expenseId: e.id, purpose: 'EXPENSE_REVIEW' });
    await reviewExpense(h.deps, controller, { expenseId: e.id, action: 'DECLINE', reason: 'Above the accommodation cap without approval', expectedVersion: e.version, ...ch });
    const after = (await h.db.pool.query('SELECT seq, hash FROM audit_events ORDER BY seq')).rows;
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.length).toBeGreaterThan(before.length);
    expect((await h.db.pool.query('SELECT action, reason FROM reviews')).rows).toEqual([{ action: 'DECLINE', reason: 'Above the accommodation cap without approval' }]);
  });

  it('ask the employee: one question in the thread; the reply comes back to review with the answer', async () => {
    const e = await expenseInReview();
    const ch = await pageChallenge(h.deps, controller, { expenseId: e.id, purpose: 'EXPENSE_REVIEW' });
    await reviewExpense(h.deps, controller, { expenseId: e.id, action: 'REQUEST_INFO', reason: 'Need context for the rate', question: 'Which client site was this for, and was the rate pre-agreed?', expectedVersion: e.version, ...ch });
    await h.drain();
    const q = h.sentTo(SAM).at(-1)!;
    expect(q.envelope.text).toContain('Which client site was this for');
    await h.reply({ raw: q.raw, to: SAM }, { text: 'Acme Watford site; the rate was agreed by Jordan on 10 Oct.' });
    await h.drain();
    expect((await h.db.pool.query('SELECT state FROM expenses')).rows[0].state).toBe('REVIEW_REQUIRED');
    expect((await h.db.pool.query(`SELECT answer_text FROM open_questions WHERE kind = 'REVIEWER_QUESTION'`)).rows[0].answer_text).toBe('Acme Watford site; the rate was agreed by Jordan on 10 Oct.');
  });

  it('correct and re-check: a reviewer fixes an unreadable receipt; the same policy then clears and auto-pays it', async () => {
    const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
    await h.email({ text: '', attachments: [{ filename: 'photo.png', mime: 'image/png', content: png }] });
    await h.drain();
    const e = (await h.db.pool.query('SELECT id, version, state, policy_version_id FROM expenses')).rows[0];
    expect(e.state).toBe('REVIEW_REQUIRED');
    const ch = await pageChallenge(h.deps, controller, { expenseId: e.id, purpose: 'EXPENSE_REVIEW' });
    await reviewExpense(h.deps, controller, {
      expenseId: e.id, action: 'CORRECT', reason: 'Read the photo myself: Trainline ticket', expectedVersion: e.version, ...ch,
      corrections: { merchant: 'Trainline', amount: '42.10', currency: 'GBP', date: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10), category: 'TRAVEL', paymentType: 'PERSONAL' },
    });
    await h.drain();
    const after = (await h.db.pool.query('SELECT state, flags, uncertain_fields, policy_version_id FROM expenses')).rows[0];
    expect(after).toMatchObject({ state: 'EXPORTED', flags: [], uncertain_fields: [], policy_version_id: e.policy_version_id });
    expect(await h.payouts.ledgerCount()).toBe(1);
  });
});

describe('question reminders and expiry', () => {
  it('one reminder, then expiry escalates to finance; never a second identical question', async () => {
    await h.email({ attachments: attach(costa()) });
    await h.drain();
    const token = (await h.db.pool.query(`SELECT correlation_token FROM open_questions`)).rows[0].correlation_token;
    expect(await questionTimeout(h.deps, token, 'REMIND')).toBe('reminded');
    await h.db.pool.query(`DELETE FROM jobs WHERE kind = 'question-timeout'`);
    await h.drain();
    expect(h.sentTo(SAM).at(-1)!.envelope.text).toContain("we're waiting for your answer");
    expect(await questionTimeout(h.deps, token, 'EXPIRE')).toBe('expired');
    await h.drain();
    expect((await h.db.pool.query('SELECT state FROM expenses')).rows[0].state).toBe('REVIEW_REQUIRED');
    expect((await h.db.pool.query(`SELECT reason_codes FROM policy_decisions ORDER BY decided_at DESC LIMIT 1`)).rows[0].reason_codes).toContain('QUESTION_UNRESOLVED');
    expect(h.sentTo(SAM).filter((m) => m.envelope.text.includes('What was the business purpose?'))).toHaveLength(1);
  });

  it('VAT invoice request: reply with the invoice re-extracts and clears (regression for the M2 check-constraint bug)', async () => {
    const noVat = textReceipt({ merchant: 'Trainline', receiptNo: 'TL-555', date: ukDate(1), items: [['Return to Manchester', '120.01']], total: '120.01', paidWith: { card: '9911' } });
    await h.email({ attachments: attach(noVat) });
    await h.drain();
    expect((await h.db.pool.query('SELECT state FROM expenses')).rows[0].state).toBe('NEEDS_INFO');
    const q = h.sentTo(SAM).at(-1)!;
    expect(q.envelope.text).toContain('VAT invoice');
    const invoice = noVat.replace('Paid by', 'VAT No: GB000000000\nPaid by');
    await h.reply({ raw: q.raw, to: SAM }, { text: 'Invoice attached', attachments: attach(invoice) });
    await h.drain();
    expect((await h.db.pool.query('SELECT state FROM expenses')).rows[0].state).toBe('EXPORTED');
    expect(await h.payouts.ledgerCount()).toBe(1);
  });
});
