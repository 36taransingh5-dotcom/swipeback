import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FixtureEmailAdapter,
  SyntheticChatAdapter,
  WHATSAPP_SIGNATURE_HEADER,
  WhatsAppCloudAdapter,
  WhatsAppGraphError,
  signWhatsAppBody,
  type RawInbound,
  type WhatsAppGraphClient,
} from '@swipeback/channels';
import { JobRunner, jobStats, verifyAuditChain } from '@swipeback/db';
import { channelRegistry, engineHandlers, receiveWhatsAppWebhook, type EngineDeps } from '@swipeback/engine';
import { textReceipt } from '../../../test/fixtures/receipts.ts';
import { CHAT_SECRET, CONTROLLER, createHarness, ukDate, type Harness } from './harness.ts';

/**
 * WhatsApp through the real pipeline: signed Meta webhook -> batch intake -> the same job pipeline
 * email uses -> replies back out through a fake Graph API. Real Postgres, no network.
 */

const APP_SECRET = 'whatsapp-app-secret-for-tests-0123';
const PHONE_NUMBER_ID = '106540352242922';
const SAM_DIGITS = '447700900123';
const STRANGER_DIGITS = '447700900999';

class FakeGraph implements WhatsAppGraphClient {
  readonly media = new Map<string, { bytes: Buffer; mimeType: string; sha256: string | null }>();
  readonly sent: { to: string; body: string; replyToMessageId?: string | null }[] = [];
  sendError: Error | null = null;
  mediaError: Error | null = null;
  async downloadMedia(mediaId: string) {
    if (this.mediaError) throw this.mediaError;
    const m = this.media.get(mediaId);
    if (!m) throw new WhatsAppGraphError(404, null, 'no such media');
    return m;
  }
  async sendText(p: { to: string; body: string; replyToMessageId?: string | null }) {
    if (this.sendError) throw this.sendError;
    this.sent.push(p);
    return { messageId: `wamid.OUT${this.sent.length}` };
  }
}

const train = (total = '42.10') =>
  textReceipt({
    merchant: 'Trainline', receiptNo: `TL-${Math.floor(Math.random() * 1e6)}`, date: ukDate(1),
    items: [['Off-peak return London Euston - Watford Junction', total]], total, paidWith: { card: '9911' },
  });
const costa = () =>
  textReceipt({ merchant: 'Costa Coffee', receiptNo: `C-${Math.floor(Math.random() * 1e6)}`, date: ukDate(1), items: [['Latte', '3.95'], ['Toastie', '4.45']], total: '8.40', paidWith: { card: '9911' } });
const hotel = () =>
  textReceipt({ merchant: 'Premier Stay Hotel Watford', receiptNo: `H-${Math.floor(Math.random() * 1e6)}`, date: ukDate(2), items: [['Room, 1 night', '210.00']], total: '210.00', vat: '35.00', vatNumber: 'GB000000000', paidWith: { card: '9911' } });

interface Wa {
  h: Harness;
  graph: FakeGraph;
  deps: EngineDeps;
  connectionId: string;
  drain(): Promise<void>;
  /** Build and post a signed webhook. */
  post(messages: Record<string, unknown>[], opts?: { statuses?: number; phoneNumberId?: string; signWith?: string }): ReturnType<typeof receiveWhatsAppWebhook>;
  raw(messages: Record<string, unknown>[], opts?: { statuses?: number; phoneNumberId?: string; signWith?: string }): RawInbound;
  /** A message carrying a receipt document. */
  receipt(text: string, o?: { from?: string; caption?: string }): Record<string, unknown>;
  text(body: string, o?: { from?: string; contextId?: string }): Record<string, unknown>;
  expenses(): Promise<{ id: string; state: string; payment_type: string; merchant: string | null; amount_minor: number | null; business_purpose: string | null; source_type: string }[]>;
}

let current: { wa: Wa; others: Harness[] } | null = null;

async function setup(): Promise<Wa> {
  const h = await createHarness();
  const graph = new FakeGraph();
  const adapter = new WhatsAppCloudAdapter(h.deps.evidence, graph, APP_SECRET);
  const deps: EngineDeps = {
    ...h.deps,
    channels: channelRegistry([new FixtureEmailAdapter(h.deps.evidence, h.sink), new SyntheticChatAdapter(h.deps.evidence, h.sink, CHAT_SECRET), adapter]),
  };
  const connectionId = (
    await h.db.pool.query<{ id: string }>(
      `INSERT INTO channel_connections (organisation_id, channel, provider, address, scopes, status, consented_by, consented_at)
       VALUES ($1, 'whatsapp', 'whatsapp-cloud', $2, $3, 'ACTIVE', $4, now()) RETURNING id`,
      [h.org.organisationId, PHONE_NUMBER_ID, ['whatsapp:messages'], h.org.members.controller],
    )
  ).rows[0]!.id;
  await h.db.pool.query(
    `INSERT INTO channel_identities (organisation_id, member_id, channel, channel_address, verification_method)
     VALUES ($1, $2, 'whatsapp', $3, 'demo_enrolment')`,
    [h.org.organisationId, h.org.members.employee, `+${SAM_DIGITS}`],
  );
  const runner = new JobRunner(h.db.pool, engineHandlers(deps), { backoffBaseMs: 5, backoffMaxMs: 20, batchSize: 10, onError: () => undefined });
  const drain = async () => {
    for (let i = 0; i < 500; i++) {
      const n = await runner.runOnce();
      if (n === 0) {
        const ready = await h.db.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM jobs WHERE state = 'QUEUED' AND run_at <= clock_timestamp() + interval '50 milliseconds'`);
        if (ready.rows[0]!.n === 0 && (await jobStats(h.db.pool)).RUNNING === 0) return;
        await new Promise((r) => setTimeout(r, 15));
      }
    }
    throw new Error('drain did not settle');
  };
  const raw: Wa['raw'] = (messages, opts = {}) => {
    const body = Buffer.from(
      JSON.stringify({
        object: 'whatsapp_business_account',
        entry: [{ id: 'waba-1', changes: [{ field: 'messages', value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: '15550000000', phone_number_id: opts.phoneNumberId ?? PHONE_NUMBER_ID },
          contacts: [{ profile: { name: 'Sam Taylor' }, wa_id: SAM_DIGITS }],
          messages: messages.length ? messages : undefined,
          statuses: opts.statuses ? Array.from({ length: opts.statuses }, (_, i) => ({ id: `wamid.s${i}`, status: 'delivered' })) : undefined,
        } }] }],
      }),
    );
    return { body, headers: { [WHATSAPP_SIGNATURE_HEADER]: signWhatsAppBody(opts.signWith ?? APP_SECRET, body) } };
  };
  const wa: Wa = {
    h, graph, deps, connectionId, drain, raw,
    post: (messages, opts) => receiveWhatsAppWebhook(deps, connectionId, raw(messages, opts)),
    receipt: (text, o = {}) => {
      const mediaId = `media-${randomUUID()}`;
      graph.media.set(mediaId, { bytes: Buffer.from(text), mimeType: 'text/plain', sha256: null });
      return {
        from: o.from ?? SAM_DIGITS, id: `wamid.${randomUUID()}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'document',
        document: { id: mediaId, mime_type: 'text/plain', filename: 'receipt.txt', caption: o.caption },
      };
    },
    text: (body, o = {}) => ({
      from: o.from ?? SAM_DIGITS, id: `wamid.${randomUUID()}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body },
      ...(o.contextId ? { context: { from: PHONE_NUMBER_ID, id: o.contextId } } : {}),
    }),
    expenses: async () =>
      (await h.db.pool.query('SELECT id, state, payment_type, merchant, amount_minor, business_purpose, source_type FROM expenses ORDER BY created_at')).rows,
  };
  current = { wa, others: [] };
  return wa;
}

afterEach(async () => {
  if (!current) return;
  const { wa, others } = current;
  current = null;
  const audit = await verifyAuditChain(wa.h.db.pool, wa.h.org.organisationId);
  expect(audit.ok, JSON.stringify(audit.problems)).toBe(true);
  await wa.h.close();
  for (const o of others) await o.close();
});

const count = async (wa: Wa, sql: string, params: unknown[] = []) => (await wa.h.db.pool.query<{ n: number }>(sql, params)).rows[0]!.n;

describe('whatsapp: receipt in, decision, reply in the same chat', () => {
  it('an in-policy personal receipt is cleared, paid (simulated) once, and the reply goes to the sender on WhatsApp', async () => {
    const wa = await setup();
    const r = await wa.post([wa.receipt(train())]);
    expect(r).toEqual({ status: 'PROCESSED', accepted: 1, duplicates: 0, ignored: 0, rejected: 0 });
    await wa.drain();
    const [e] = await wa.expenses();
    expect(e).toMatchObject({ state: 'EXPORTED', payment_type: 'PERSONAL', amount_minor: 4210, merchant: 'Trainline', source_type: 'CHAT' });
    const reply = wa.graph.sent.at(-1)!;
    expect(reply.to).toBe(SAM_DIGITS);
    expect(reply.body).toContain('Simulated payout reference: SIMULATED-MP-');
    const out = (await wa.h.db.pool.query(`SELECT channel, delivery_state, provider_message_id FROM outbound_messages WHERE recipient_address = $1`, [`+${SAM_DIGITS}`])).rows;
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((o) => o.channel === 'whatsapp' && o.delivery_state === 'SENT' && /^wamid\.OUT\d+$/.test(o.provider_message_id))).toBe(true);
    expect(await wa.h.payouts.ledgerCount()).toBe(1);
  });

  it('batches: 2 receipts + 1 status in one POST become 2 expenses', async () => {
    const wa = await setup();
    const r = await wa.post([wa.receipt(train('42.10')), wa.receipt(train('19.80'))], { statuses: 1 });
    expect(r).toEqual({ status: 'PROCESSED', accepted: 2, duplicates: 0, ignored: 1, rejected: 0 });
    await wa.drain();
    expect(await wa.expenses()).toHaveLength(2);
  });
});

describe('whatsapp: threading (the three cases from the design)', () => {
  it('case 2: the engine asks one question and a plain-text answer (no quote-reply) completes the same expense', async () => {
    const wa = await setup();
    await wa.post([wa.receipt(costa())]);
    await wa.drain();
    expect((await wa.expenses())[0]!.state).toBe('NEEDS_INFO');
    expect(wa.graph.sent).toHaveLength(1);
    expect(wa.graph.sent[0]!.body).toContain('What was the business purpose?');

    await wa.post([wa.text('Coffee and lunch with the Acme site team during the install')]);
    await wa.drain();
    const all = await wa.expenses();
    expect(all).toHaveLength(1); // the answer did not create a new expense
    expect(all[0]).toMatchObject({ state: 'EXPORTED', business_purpose: 'Coffee and lunch with the Acme site team during the install' });
  });

  it('case 2b: a quote-reply to the question also attaches to the same expense', async () => {
    const wa = await setup();
    await wa.post([wa.receipt(costa())]);
    await wa.drain();
    await wa.post([wa.text('Coffee and lunch with the Acme site team during the install', { contextId: 'wamid.OUT1' })]);
    await wa.drain();
    const all = await wa.expenses();
    expect(all).toHaveLength(1);
    expect(all[0]!.state).toBe('EXPORTED');
  });

  it('case 3: a new, unrelated receipt sent while a question is open becomes a new expense, not the answer', async () => {
    const wa = await setup();
    await wa.post([wa.receipt(costa())]);
    await wa.drain();
    await wa.post([wa.receipt(train())]);
    await wa.drain();
    const all = await wa.expenses();
    expect(all).toHaveLength(2);
    expect(all.find((e) => e.merchant === 'Costa Coffee')).toMatchObject({ state: 'NEEDS_INFO', business_purpose: null });
    expect(all.find((e) => e.merchant === 'Trainline')).toMatchObject({ state: 'EXPORTED' });
  });
});

describe('whatsapp: idempotency and identity', () => {
  it('the same webhook delivered 5 times creates one expense and one reply', async () => {
    const wa = await setup();
    const raw = wa.raw([wa.receipt(train())]);
    const results = [];
    for (let i = 0; i < 5; i++) results.push(await receiveWhatsAppWebhook(wa.deps, wa.connectionId, raw));
    expect(results.map((r) => (r.status === 'PROCESSED' ? [r.accepted, r.duplicates] : null))).toEqual([[1, 0], [0, 1], [0, 1], [0, 1], [0, 1]]);
    await wa.drain();
    expect(await wa.expenses()).toHaveLength(1);
    expect(await count(wa, 'SELECT count(*)::int AS n FROM inbound_messages')).toBe(1);
    expect(wa.graph.sent.filter((m) => m.to === SAM_DIGITS)).toHaveLength(1);
  });

  it('an unknown number is quarantined: no expense, and at most one enrolment reply however often it writes', async () => {
    const wa = await setup();
    await wa.post([wa.receipt(train(), { from: STRANGER_DIGITS })]);
    await wa.post([wa.receipt(train('19.80'), { from: STRANGER_DIGITS })]);
    await wa.drain();
    expect(await wa.expenses()).toHaveLength(0);
    expect(wa.graph.sent.filter((m) => m.to === STRANGER_DIGITS).length).toBeLessThanOrEqual(1);
    expect(wa.graph.sent.filter((m) => m.to === SAM_DIGITS)).toHaveLength(0);
    expect(await count(wa, `SELECT count(*)::int AS n FROM inbound_messages WHERE sender_address = $1`, [`+${STRANGER_DIGITS}`])).toBe(2);
  });
});

describe('whatsapp: failing closed', () => {
  it('a bad signature is rejected (audited) and nothing is ingested', async () => {
    const wa = await setup();
    const r = await wa.post([wa.receipt(train())], { signWith: 'another-secret-0123456789' });
    expect(r).toEqual({ status: 'REJECTED', reason: 'BAD_SIGNATURE' });
    expect(await count(wa, 'SELECT count(*)::int AS n FROM inbound_messages')).toBe(0);
    expect(await count(wa, `SELECT count(*)::int AS n FROM audit_events WHERE action = 'inbound.rejected'`)).toBe(1);
  });

  it('a webhook for another phone number id is acknowledged and ignored', async () => {
    const wa = await setup();
    const r = await wa.post([wa.receipt(train())], { phoneNumberId: '999' });
    expect(r).toMatchObject({ status: 'PROCESSED', accepted: 0 });
    expect(await count(wa, 'SELECT count(*)::int AS n FROM inbound_messages')).toBe(0);
  });

  it('a media download failure throws (so Meta retries) and creates nothing; the retry then succeeds exactly once', async () => {
    const wa = await setup();
    const raw = wa.raw([wa.receipt(train())]);
    wa.graph.mediaError = new WhatsAppGraphError(503, null, 'media unavailable');
    await expect(receiveWhatsAppWebhook(wa.deps, wa.connectionId, raw)).rejects.toBeInstanceOf(WhatsAppGraphError);
    expect(await count(wa, 'SELECT count(*)::int AS n FROM inbound_messages')).toBe(0);
    await wa.drain();
    expect(await wa.expenses()).toHaveLength(0);

    wa.graph.mediaError = null;
    expect(await receiveWhatsAppWebhook(wa.deps, wa.connectionId, raw)).toMatchObject({ accepted: 1, duplicates: 0 });
    await wa.drain();
    expect(await wa.expenses()).toHaveLength(1);
  });

  it('a send outside the 24-hour window leaves the reply visibly undelivered while finance still sees the case', async () => {
    const wa = await setup();
    wa.graph.sendError = new WhatsAppGraphError(400, 131047, 'WhatsApp Graph API 400 (code 131047): Re-engagement message');
    await wa.post([wa.receipt(hotel())]);
    await wa.drain();
    const [e] = await wa.expenses();
    expect(e).toMatchObject({ state: 'REVIEW_REQUIRED' });
    const toSam = (await wa.h.db.pool.query(`SELECT delivery_state, last_error, attempts FROM outbound_messages WHERE recipient_address = $1`, [`+${SAM_DIGITS}`])).rows;
    expect(toSam.length).toBeGreaterThan(0);
    expect(toSam.every((o) => o.delivery_state !== 'SENT' && String(o.last_error).includes('131047'))).toBe(true);
    expect(wa.graph.sent).toHaveLength(0);
    // Finance is notified by email and can see the case in the reviewer app (it is REVIEW_REQUIRED).
    expect(wa.h.sink.to(CONTROLLER).at(-1)!.kind).toBe('approval_request');
    expect(await wa.h.payouts.ledgerCount()).toBe(0);
  });
});

describe('whatsapp: channel neutrality', () => {
  const cases = [
    ['an in-policy personal receipt', () => train()],
    ['a receipt over the category cap', () => hotel()],
    ['a receipt with no business purpose', () => costa()],
  ] as const;

  for (const [name, receipt] of cases) {
    it(`${name} gets the same decision by email and by WhatsApp`, async () => {
      const wa = await setup();
      const email = await createHarness();
      current!.others.push(email);
      const text = receipt();
      await email.email({ attachments: [{ filename: 'receipt.txt', mime: 'text/plain', content: text }] });
      await email.drain();
      await wa.post([wa.receipt(text)]);
      await wa.drain();

      const shape = async (h: Harness) => {
        const [e] = await h.expenses();
        const decisions = (await h.db.pool.query<{ outcome: string }>('SELECT outcome FROM policy_decisions ORDER BY decided_at')).rows.map((d) => d.outcome);
        const paid = await h.payouts.ledgerCount();
        return { state: e!.state, payment_type: e!.payment_type, merchant: e!.merchant, amount_minor: e!.amount_minor, decisions, paid };
      };
      expect(await shape(wa.h)).toEqual(await shape(email));
    });
  }
});
