import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildEml, buildReplyEml } from '@swipeback/channels/testing';
import { verifyAuditChain } from '@swipeback/db';
import { finishGmailConnect, GmailTokens, pollGmailConnection, startGmailConnect, type SessionMember } from '@swipeback/engine';
import { FakeGmail } from '../../../test/support/fake-gmail.ts';
import { textReceipt } from '../../../test/fixtures/receipts.ts';
import { createHarness, FINANCE, SAM, ukDate, type Harness } from './harness.ts';

/** M3 offline: OAuth connect, mailbox polling, threaded replies, resync, reconnect state. */

let h: Harness;
let fake: FakeGmail;
let admin: SessionMember;

const gmailAuth = (from: string, result: 'pass' | 'fail' = 'pass') => ({ authservId: 'mx.google.com', result });
const train = () => textReceipt({ merchant: 'Trainline', receiptNo: `TL-${Math.random()}`, date: ukDate(1), items: [['Off-peak return', '42.10']], total: '42.10', paidWith: { card: '9911' } });
const costa = () => textReceipt({ merchant: 'Costa Coffee', receiptNo: `C-${Math.random()}`, date: ukDate(1), items: [['Latte', '3.95'], ['Toastie', '4.45']], total: '8.40', paidWith: { card: '9911' } });
const receiptEmail = (receipt: string, o: { from?: string; subject?: string; auth?: 'pass' | 'fail'; to?: string } = {}) =>
  buildEml({
    from: o.from ?? SAM, to: o.to ?? FINANCE, subject: o.subject ?? 'Train to the Watford site', auth: gmailAuth(o.from ?? SAM, o.auth),
    attachments: [{ filename: 'receipt.txt', mime: 'text/plain', content: receipt }],
    extraHeaders: o.to && o.to !== FINANCE ? {} : { 'Delivered-To': FINANCE },
  });

async function connect(): Promise<string> {
  const url = new URL(await startGmailConnect(h.deps, h.gmail!, admin));
  const r = await finishGmailConnect(h.deps, h.gmail!, admin, { code: fake.issueCode(), state: url.searchParams.get('state')! });
  expect(r.ok).toBe(true);
  return (r as { connectionId: string }).connectionId;
}

beforeEach(async () => {
  fake = new FakeGmail(FINANCE);
  h = await createHarness({ gmailFetch: fake.fetch });
  const m = (await h.db.pool.query('SELECT id, organisation_id, email, display_name, roles FROM members WHERE id = $1', [h.org.members.controller])).rows[0];
  admin = { memberId: m.id, organisationId: m.organisation_id, email: m.email, displayName: m.display_name, roles: m.roles };
});
afterEach(async () => {
  expect((await verifyAuditChain(h.db.pool, h.org.organisationId)).ok).toBe(true);
  await h.close();
});

describe('connecting the finance mailbox (OAuth)', () => {
  it('asks Google for exactly read + send with PKCE and state, scoped to the designated mailbox', async () => {
    const url = new URL(await startGmailConnect(h.deps, h.gmail!, admin));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('login_hint')).toBe(FINANCE);
    expect(url.searchParams.get('state')).toMatch(/^[\w-]{20,}$/);
  });

  it('connects: tokens encrypted at rest, scopes and consent recorded, offline transport retired', async () => {
    const id = await connect();
    const row = (await h.db.pool.query('SELECT status, scopes, token_ciphertext, cursor, consented_by FROM channel_connections WHERE id = $1', [id])).rows[0];
    expect(row).toMatchObject({ status: 'ACTIVE', cursor: String(fake.historyId), consented_by: admin.memberId });
    expect(row.scopes).toEqual(fake.grantedScopes);
    expect(row.token_ciphertext).not.toContain(fake.refreshToken);
    expect(row.token_ciphertext).not.toContain(fake.accessToken);
    expect((await h.db.pool.query(`SELECT status FROM channel_connections WHERE provider = 'fixture'`)).rows[0].status).toBe('DISCONNECTED');
    expect((await h.db.pool.query(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'channel.connected'`)).rows[0].n).toBe(1);
  });

  it('refuses a replayed or forged state, a missing scope, and a mailbox that is not the designated one', async () => {
    const url = new URL(await startGmailConnect(h.deps, h.gmail!, admin));
    const state = url.searchParams.get('state')!;
    expect(await finishGmailConnect(h.deps, h.gmail!, admin, { code: fake.issueCode(), state: 'forged' })).toMatchObject({ ok: false });
    expect(await finishGmailConnect(h.deps, h.gmail!, admin, { code: fake.issueCode(), state })).toMatchObject({ ok: true });
    expect(await finishGmailConnect(h.deps, h.gmail!, admin, { code: fake.issueCode(), state })).toMatchObject({ ok: false, reason: expect.stringMatching(/expired or was already used/) });

    fake.grantedScopes = ['https://www.googleapis.com/auth/gmail.readonly'];
    const s2 = new URL(await startGmailConnect(h.deps, h.gmail!, admin)).searchParams.get('state')!;
    expect(await finishGmailConnect(h.deps, h.gmail!, admin, { code: fake.issueCode(), state: s2 })).toMatchObject({ ok: false, reason: expect.stringMatching(/gmail.send/) });

    fake.grantedScopes = ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send'];
    fake.mailbox = 'someones.personal@gmail.com';
    const s3 = new URL(await startGmailConnect(h.deps, h.gmail!, admin)).searchParams.get('state')!;
    expect(await finishGmailConnect(h.deps, h.gmail!, admin, { code: fake.issueCode(), state: s3 })).toMatchObject({ ok: false, reason: expect.stringMatching(/Nothing was connected/) });
    expect(fake.revoked).toBe(true); // the wrong mailbox's grant is revoked immediately
  });

  it('only admins can connect', async () => {
    await expect(startGmailConnect(h.deps, h.gmail!, { ...admin, roles: ['reviewer'] })).rejects.toMatchObject({ status: 403 });
  });
});

describe('polling and replying through Gmail (AC-01)', () => {
  it('a new receipt email is ingested with its Gmail id and attachment hash, processed, and answered in the same thread', async () => {
    const id = await connect();
    const inbound = fake.deliver(receiptEmail(train()));
    const r = await pollGmailConnection(h.deps, h.gmail!.tokens, id);
    expect(r).toMatchObject({ status: 'OK', fetched: 1, accepted: 1 });
    await h.drain();
    const row = (await h.db.pool.query(`SELECT provider_event_id, thread_id, sender_auth FROM inbound_messages`)).rows[0];
    expect(row).toEqual({ provider_event_id: `gmail:${inbound.id}`, thread_id: inbound.threadId, sender_auth: 'dkim_aligned' });
    expect((await h.db.pool.query('SELECT count(*)::int AS n FROM inbound_attachments')).rows[0].n).toBe(1);
    expect((await h.db.pool.query('SELECT state FROM expenses')).rows[0].state).toBe('EXPORTED');
    const reply = fake.sent.at(-1)!;
    expect(reply.threadId).toBe(inbound.threadId);
    expect(reply.raw).toContain('Subject: Re: Train to the Watford site');
    expect(reply.raw).toMatch(/In-Reply-To: <.+>/);
    expect(reply.raw).toContain('X-Swipeback-Outbound: 1');
    const out = (await h.db.pool.query(`SELECT thread_id, delivery_state FROM outbound_messages WHERE template = 'paid'`)).rows[0];
    expect(out).toEqual({ thread_id: inbound.threadId, delivery_state: 'SENT' });
  });

  it('our own sent replies are never ingested (no loops), and polling again after a restart duplicates nothing', async () => {
    const id = await connect();
    fake.deliver(receiptEmail(train()));
    await pollGmailConnection(h.deps, h.gmail!.tokens, id);
    await h.drain();
    expect(fake.sent.length).toBeGreaterThan(0);
    const again = await pollGmailConnection(h.deps, new GmailTokens(h.db.pool, h.gmail!), id); // fresh process, no token cache
    expect(again.accepted).toBe(0);
    expect(again.skipped).toBe(fake.sent.length); // SENT copies skipped
    expect((await h.db.pool.query('SELECT count(*)::int AS n FROM inbound_messages')).rows[0].n).toBe(1);
    expect((await h.db.pool.query('SELECT count(*)::int AS n FROM expenses')).rows[0].n).toBe(1);
  });

  it('a stale history cursor triggers a bounded resync without duplicates', async () => {
    const id = await connect();
    fake.deliver(receiptEmail(train()));
    await pollGmailConnection(h.deps, h.gmail!.tokens, id);
    fake.deliver(receiptEmail(costa(), { subject: 'Coffee' }));
    fake.minHistoryId = fake.historyId + 1; // Gmail forgot our cursor
    const r = await pollGmailConnection(h.deps, h.gmail!.tokens, id);
    expect(r).toMatchObject({ status: 'OK', resynced: true, accepted: 1 });
    expect((await h.db.pool.query('SELECT count(*)::int AS n FROM inbound_messages')).rows[0].n).toBe(2);
    expect((await h.db.pool.query('SELECT cursor FROM channel_connections WHERE id = $1', [id])).rows[0].cursor).toBe(String(fake.historyId));
  });

  it('a revoked grant flips the mailbox to RECONNECT_REQUIRED without crashing or leaking tokens', async () => {
    const id = await connect();
    fake.accessValid = false;
    fake.revoked = true;
    await h.db.pool.query(`UPDATE channel_connections SET access_expires_at = now() WHERE id = $1`, [id]);
    const r = await pollGmailConnection(h.deps, new GmailTokens(h.db.pool, h.gmail!), id);
    expect(r.status).toBe('RECONNECT_REQUIRED');
    const row = (await h.db.pool.query('SELECT status, last_error FROM channel_connections WHERE id = $1', [id])).rows[0];
    expect(row.status).toBe('RECONNECT_REQUIRED');
    expect(row.last_error).not.toContain(fake.refreshToken);
    expect(await pollGmailConnection(h.deps, h.gmail!.tokens, id)).toMatchObject({ status: 'NOT_ACTIVE' });
  });

  it('failed DKIM/DMARC at Google quarantines the message; mail for another address is ignored', async () => {
    const id = await connect();
    fake.deliver(receiptEmail(train(), { auth: 'fail' }));
    fake.deliver(receiptEmail(train(), { to: 'someone.else@northwind.example' }));
    const r = await pollGmailConnection(h.deps, h.gmail!.tokens, id);
    expect(r).toMatchObject({ fetched: 2, accepted: 1, skipped: 1 });
    await h.drain();
    expect((await h.db.pool.query('SELECT processing_state FROM inbound_messages')).rows).toEqual([{ processing_state: 'QUARANTINED' }]);
    expect(await h.expenses()).toHaveLength(0);
  });

  it('the one-question loop works through Gmail threads', async () => {
    const id = await connect();
    const first = fake.deliver(receiptEmail(costa(), { subject: 'coffee receipt' }));
    await pollGmailConnection(h.deps, h.gmail!.tokens, id);
    await h.drain();
    const question = fake.sent.at(-1)!;
    expect(question.raw).toContain('Subject: Re: coffee receipt');
    const reply = buildReplyEml({ raw: question.raw, to: SAM }, { from: SAM, text: 'Coffee with the Acme site team before the install', auth: gmailAuth(SAM), extraHeaders: { 'Delivered-To': FINANCE } });
    fake.deliver(reply, { threadId: first.threadId });
    await pollGmailConnection(h.deps, h.gmail!.tokens, id);
    await h.drain();
    expect((await h.db.pool.query('SELECT state, business_purpose FROM expenses')).rows[0]).toEqual({ state: 'EXPORTED', business_purpose: 'Coffee with the Acme site team before the install' });
    expect(fake.sent.every((s) => s.threadId === first.threadId)).toBe(true);
  });
});
