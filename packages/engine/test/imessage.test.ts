import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BlueBubblesAdapter,
  BlueBubblesApiError,
  FixtureEmailAdapter,
  MemoryEvidenceStore,
  MemorySink,
  type BlueBubblesClient,
  type BlueBubblesDownload,
} from '@swipeback/channels';
import { buildEml } from '@swipeback/channels/testing';
import { JobRunner, jobStats, verifyAuditChain } from '@swipeback/db';
import { BaselineExtractor } from '@swipeback/extraction';
import { MockPayProvider } from '@swipeback/payouts';
import { seedDemoOrg, type SeededOrg } from '@swipeback/cli/seed';
import {
  channelRegistry,
  deliverOutbound,
  engineHandlers,
  receiveBlueBubblesMessage,
  receiveInbound,
  runBlueBubblesPoller,
  type EngineDeps,
} from '@swipeback/engine';
import { textReceipt } from '../../../test/fixtures/receipts.ts';
import { createTestDatabase, type TestDatabase } from '../../../test/support/db.ts';
import { ukDate } from './harness.ts';

/**
 * iMessage (BlueBubbles) end to end on real Postgres: a fake BlueBubbles client stands in for the
 * server, everything else (adapter, intake, jobs, policy, outbox) is the real engine.
 */

const HANDLE = '+44 7700 900123';
const SAM_ADDRESS = 'imessage:+447700900123';
const CHAT = 'iMessage;-;+447700900123';
const STRANGER_HANDLE = '+447700900456';
const STRANGER_CHAT = 'iMessage;-;+447700900456';
const BOT_LABEL = 'swipeback-demo-bot@example.com';
const FINANCE = 'finance@northwind.example';

const train = (no = Math.floor(Math.random() * 1e6)) =>
  textReceipt({ merchant: 'Trainline', receiptNo: `TL-${no}`, date: ukDate(1), items: [['Off-peak return London Euston - Watford Junction', '42.10']], total: '42.10', paidWith: { card: '9911' } });
const costa = () =>
  textReceipt({ merchant: 'Costa Coffee', receiptNo: `C-${Math.floor(Math.random() * 1e6)}`, date: ukDate(1), items: [['Latte', '3.95'], ['Toastie', '4.45']], total: '8.40', paidWith: { card: '9911' } });
const PURPOSE = 'Coffee and lunch with the Acme site team during the install';

let dateCounter = 1760702400000;
const nextDate = () => (dateCounter += 1000);
let n = 0;
const nextGuid = () => `msg-${++n}-${randomUUID().slice(0, 8)}`;

class FakeBlueBubbles implements BlueBubblesClient {
  readonly files = new Map<string, BlueBubblesDownload>();
  readonly posts: { chatGuid: string; text: string }[] = [];
  messages: unknown[] = [];
  downloadError: Error | null = null;
  postError: Error | null = null;
  failQueries = 0;
  private att = 0;
  private sent = 0;

  addFile(content: string | Buffer, contentType = 'text/plain'): string {
    const guid = `att-${++this.att}`;
    this.files.set(guid, { bytes: Buffer.from(content), contentType });
    return guid;
  }
  async ping() {}
  async queryMessages({ afterMs }: { afterMs: number }): Promise<unknown[]> {
    if (this.failQueries > 0) {
      this.failQueries--;
      throw new BlueBubblesApiError('http_503', 'message/query');
    }
    return this.messages.filter((m) => typeof (m as { dateCreated?: unknown }).dateCreated === 'number' && (m as { dateCreated: number }).dateCreated > afterMs);
  }
  async downloadAttachment(guid: string): Promise<BlueBubblesDownload> {
    if (this.downloadError) throw this.downloadError;
    const f = this.files.get(guid);
    if (!f) throw new BlueBubblesApiError('http_404', 'attachment/download');
    return f;
  }
  async sendText(input: { chatGuid: string; text: string }): Promise<{ guid: string }> {
    if (this.postError) throw this.postError;
    this.posts.push(input);
    return { guid: `sent-${++this.sent}` };
  }
}

function bbMessage(over: Record<string, unknown> = {}) {
  return {
    guid: nextGuid(),
    text: '',
    dateCreated: nextDate(),
    isFromMe: false,
    service: 'iMessage',
    handle: { address: HANDLE },
    chats: [{ guid: CHAT, style: 43, participants: [{ address: HANDLE }] }],
    attachments: [],
    ...over,
  };
}

interface IMessageHarness {
  db: TestDatabase;
  deps: EngineDeps;
  org: SeededOrg;
  bb: FakeBlueBubbles;
  emailSink: MemorySink;
  imessageConnectionId: string;
  emailConnectionId: string;
  runner: JobRunner;
  drain(): Promise<void>;
  text(opts: { text: string; handle?: string | undefined }): Promise<Awaited<ReturnType<typeof receiveBlueBubblesMessage>>>;
  photo(opts: { receipt: string; text?: string | undefined; handle?: string | undefined }): Promise<Awaited<ReturnType<typeof receiveBlueBubblesMessage>>>;
  expenses(): Promise<{ id: string; ref: string; state: string; payment_type: string; merchant: string | null; amount_minor: number | null; business_purpose: string | null; flags: string[] }[]>;
  close(): Promise<void>;
}

function chatFor(handle: string): string {
  return `iMessage;-;${handle.replace(/[\s()-]/g, '')}`;
}

async function createIMessageHarness(): Promise<IMessageHarness> {
  const db = await createTestDatabase(30);
  const org = await seedDemoOrg(db.pool);
  const evidence = new MemoryEvidenceStore();
  const emailSink = new MemorySink();
  const bb = new FakeBlueBubbles();
  const deps: EngineDeps = {
    pool: db.pool,
    clock: { now: () => new Date() },
    extractor: new BaselineExtractor(),
    payouts: new MockPayProvider(db.pool),
    channels: channelRegistry([new FixtureEmailAdapter(evidence, emailSink), new BlueBubblesAdapter(evidence, bb)]),
    evidence,
    config: { appUrl: 'http://localhost:3000', cardFeedSecret: 'card-feed-secret-for-tests' },
  };
  const conn = async (channel: string, provider: string, address: string) =>
    (
      await db.pool.query<{ id: string }>(
        `INSERT INTO channel_connections (organisation_id, channel, provider, address, scopes, status, consented_by, consented_at)
         VALUES ($1, $2, $3, $4, $5, 'ACTIVE', $6, now()) RETURNING id`,
        [org.organisationId, channel, provider, address, ['test'], org.members.controller],
      )
    ).rows[0]!.id;
  const emailConnectionId = await conn('email', 'fixture', FINANCE);
  const imessageConnectionId = await conn('imessage', 'bluebubbles', BOT_LABEL);
  await db.pool.query(
    `INSERT INTO channel_identities (organisation_id, member_id, channel, channel_address, verification_method) VALUES ($1, $2, 'imessage', $3, 'demo_enrolment')`,
    [org.organisationId, org.members.employee, SAM_ADDRESS],
  );
  const runner = new JobRunner(db.pool, engineHandlers(deps), { backoffBaseMs: 5, backoffMaxMs: 20, batchSize: 10, onError: () => undefined });
  const drain = async () => {
    for (let i = 0; i < 500; i++) {
      const count = await runner.runOnce();
      if (count === 0) {
        const ready = await db.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM jobs WHERE state = 'QUEUED' AND run_at <= clock_timestamp() + interval '50 milliseconds'`);
        if (ready.rows[0]!.n === 0 && (await jobStats(db.pool)).RUNNING === 0) return;
        await new Promise((r) => setTimeout(r, 15));
      }
    }
    throw new Error('drain did not settle');
  };
  const send = (opts: { text: string; receipt?: string | undefined; handle?: string | undefined }) => {
    const handle = opts.handle ?? HANDLE;
    const message = bbMessage({
      text: opts.text,
      handle: { address: handle },
      chats: [{ guid: chatFor(handle), style: 43, participants: [{ address: handle }] }],
      ...(opts.receipt ? { attachments: [{ guid: bb.addFile(opts.receipt), mimeType: 'text/plain', transferName: 'receipt.txt' }] } : {}),
    });
    return receiveBlueBubblesMessage(deps, imessageConnectionId, message);
  };
  return {
    db, deps, org, bb, emailSink, imessageConnectionId, emailConnectionId, runner, drain,
    text: (opts) => send({ text: opts.text, handle: opts.handle }),
    photo: (opts) => send({ text: opts.text ?? '', receipt: opts.receipt, handle: opts.handle }),
    expenses: async () =>
      (await db.pool.query('SELECT id, ref, state, payment_type, merchant, amount_minor, business_purpose, flags FROM expenses ORDER BY created_at')).rows,
    close: () => db.drop(),
  };
}

let h: IMessageHarness;
beforeEach(async () => {
  h = await createIMessageHarness();
});
afterEach(async () => {
  const audit = await verifyAuditChain(h.db.pool, h.org.organisationId);
  expect(audit.ok, JSON.stringify(audit.problems)).toBe(true);
  await h.close();
});

const count = async (sql: string, params: unknown[] = []) => (await h.db.pool.query<{ n: number }>(sql, params)).rows[0]!.n;

describe('receipts over iMessage', () => {
  it('1. a receipt photo is decided by the engine and the reply lands in the same chat', async () => {
    const outcome = await h.photo({ receipt: train(), text: 'Train to the Watford site' });
    expect(outcome).toMatchObject({ status: 'ACCEPTED', duplicate: false });
    await h.drain();
    const [e] = await h.expenses();
    expect(e).toMatchObject({ state: 'EXPORTED', payment_type: 'PERSONAL', merchant: 'Trainline', amount_minor: 4210 });
    expect(h.bb.posts).toHaveLength(1);
    expect(h.bb.posts[0]!.chatGuid).toBe(CHAT);
    expect(h.bb.posts[0]!.text).toContain(e!.ref);
    expect(h.bb.posts[0]!.text).toContain('SYNTHETIC DEMO');
    const sent = (await h.db.pool.query(`SELECT delivery_state, provider_message_id, thread_id FROM outbound_messages WHERE channel = 'imessage'`)).rows;
    expect(sent).toEqual([{ delivery_state: 'SENT', provider_message_id: h.bb.posts[0] ? `sent-1` : null, thread_id: `imessage:${CHAT}` }]);
    expect(await count(`SELECT count(*)::int AS n FROM receipts WHERE source_kind = 'CHAT_MEDIA'`)).toBe(1);
    expect((await h.db.pool.query(`SELECT source_type, source_channel FROM expenses`)).rows).toEqual([{ source_type: 'CHAT', source_channel: 'imessage' }]);
  });

  it('2. a text answer to the chat’s single open question attaches to that expense', async () => {
    await h.photo({ receipt: costa() });
    await h.drain();
    expect((await h.expenses())[0]!.state).toBe('NEEDS_INFO');
    expect(h.bb.posts).toHaveLength(1);
    expect(h.bb.posts[0]!.text).toContain('What was the business purpose?');

    const reply = await h.text({ text: PURPOSE });
    expect(reply.status).toBe('ACCEPTED');
    await h.drain();
    const expenses = await h.expenses();
    expect(expenses).toHaveLength(1); // the answer did not create a new expense
    expect(expenses[0]).toMatchObject({ state: 'EXPORTED', business_purpose: PURPOSE });
    expect(await count(`SELECT count(*)::int AS n FROM open_questions WHERE status = 'ANSWERED'`)).toBe(1);
  });

  it('3. a new photo while a question is open becomes a new expense, not an answer', async () => {
    await h.photo({ receipt: costa() });
    await h.drain();
    await h.photo({ receipt: train() });
    await h.drain();
    const expenses = await h.expenses();
    expect(expenses).toHaveLength(2);
    expect(expenses.map((e) => e.state).sort()).toEqual(['EXPORTED', 'NEEDS_INFO']);
    expect(await count(`SELECT count(*)::int AS n FROM open_questions WHERE status = 'OPEN'`)).toBe(1);
  });
});

describe('intake safety', () => {
  it('the same message seen five times creates one expense', async () => {
    const message = bbMessage({ text: 'receipt', attachments: [{ guid: h.bb.addFile(train()), mimeType: 'text/plain', transferName: 'receipt.txt' }] });
    const outcomes = [];
    for (let i = 0; i < 5; i++) outcomes.push(await receiveBlueBubblesMessage(h.deps, h.imessageConnectionId, message));
    expect(outcomes.map((o) => (o.status === 'ACCEPTED' ? o.duplicate : 'x'))).toEqual([false, true, true, true, true]);
    await h.drain();
    expect(await h.expenses()).toHaveLength(1);
    expect(await count(`SELECT count(*)::int AS n FROM inbound_messages WHERE channel = 'imessage'`)).toBe(1);
    expect(h.bb.posts).toHaveLength(1);
  });

  it('an unknown sender is quarantined with at most one enrolment reply', async () => {
    await h.photo({ receipt: train(), handle: STRANGER_HANDLE });
    await h.photo({ receipt: train(), handle: STRANGER_HANDLE });
    await h.drain();
    expect(await h.expenses()).toHaveLength(0);
    expect((await h.db.pool.query(`SELECT processing_state FROM inbound_messages`)).rows.map((r) => r.processing_state)).toEqual(['QUARANTINED', 'QUARANTINED']);
    expect(await count(`SELECT count(*)::int AS n FROM outbound_messages WHERE template = 'enrolment'`)).toBe(1);
    expect(h.bb.posts).toHaveLength(1);
    expect(h.bb.posts[0]!.chatGuid).toBe(STRANGER_CHAT);
    expect(await count(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'inbound.quarantined'`)).toBe(2);
  });

  it('own messages, group chats, SMS and tapbacks create nothing, so our replies cannot loop', async () => {
    const ignored = [
      bbMessage({ isFromMe: true, text: 'SB-1001 cleared' }),
      bbMessage({ text: 'hi', chats: [{ guid: 'iMessage;+;chat999', style: 45, participants: [{ address: HANDLE }, { address: STRANGER_HANDLE }] }] }),
      bbMessage({ text: 'hi', service: 'SMS' }),
      bbMessage({ associatedMessageGuid: 'msg-1', associatedMessageType: 2000 }),
    ];
    for (const message of ignored) expect(await receiveBlueBubblesMessage(h.deps, h.imessageConnectionId, message)).toMatchObject({ status: 'IGNORED' });
    expect(await count(`SELECT count(*)::int AS n FROM inbound_messages`)).toBe(0);
  });

  it('a malformed message is rejected and audited, not ingested', async () => {
    const bad = await receiveBlueBubblesMessage(h.deps, h.imessageConnectionId, bbMessage({ text: 'hi', handle: { address: 42 } }));
    expect(bad).toEqual({ status: 'REJECTED', reason: 'MALFORMED' });
    expect(await count(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'inbound.rejected'`)).toBe(1);
    expect(await count(`SELECT count(*)::int AS n FROM inbound_messages`)).toBe(0);
  });

  it('a failed attachment download creates no inbound message and no expense, and is audited', async () => {
    h.bb.downloadError = new BlueBubblesApiError('attachment_download_returned_html', 'attachment/download');
    const message = bbMessage({ attachments: [{ guid: h.bb.addFile(train()), mimeType: 'text/plain', transferName: 'receipt.txt' }] });
    await expect(receiveBlueBubblesMessage(h.deps, h.imessageConnectionId, message)).rejects.toThrow('attachment_download_returned_html');
    expect(await count(`SELECT count(*)::int AS n FROM inbound_messages`)).toBe(0);
    expect(await h.expenses()).toHaveLength(0);
    expect(await count(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'inbound.failed'`)).toBe(1);
  });
});

describe('delivery failure', () => {
  it('a send failure leaves the message recorded as failed; the case stays decided and reviewable; it can be redelivered', async () => {
    h.bb.postError = new BlueBubblesApiError('http_500', 'message/text');
    await h.photo({ receipt: train() });
    await h.drain();
    expect((await h.expenses())[0]!.state).toBe('EXPORTED'); // the decision does not depend on the reply
    const [msg] = (await h.db.pool.query<{ id: string; delivery_state: string; last_error: string; attempts: number }>(`SELECT id, delivery_state, last_error, attempts FROM outbound_messages WHERE channel = 'imessage'`)).rows;
    expect(msg).toMatchObject({ delivery_state: 'FAILED', last_error: 'bluebubbles message/text failed: http_500' });
    expect(msg!.attempts).toBeGreaterThan(1);
    expect(h.bb.posts).toHaveLength(0);
    expect(await count(`SELECT count(*)::int AS n FROM jobs WHERE kind = 'deliver-outbound' AND state = 'DEAD'`)).toBe(1);

    h.bb.postError = null;
    expect(await deliverOutbound(h.deps, msg!.id)).toBe('SENT');
    expect(h.bb.posts).toHaveLength(1);
  });
});

describe('channel neutrality', () => {
  it('the same receipt via email and via iMessage reaches the same decision', async () => {
    const receipt = train();
    await h.photo({ receipt });
    await h.drain();
    const viaImessage = (await h.expenses()).map((e) => ({ state: e.state, payment_type: e.payment_type, merchant: e.merchant, amount_minor: e.amount_minor }));

    const h2 = await createIMessageHarness();
    try {
      await receiveInbound(h2.deps, h2.emailConnectionId, {
        body: buildEml({ from: 'sam.taylor@northwind.example', to: FINANCE, text: 'receipt', attachments: [{ filename: 'receipt.txt', mime: 'text/plain', content: receipt }] }),
        headers: {},
      });
      await h2.drain();
      const viaEmail = (await h2.expenses()).map((e) => ({ state: e.state, payment_type: e.payment_type, merchant: e.merchant, amount_minor: e.amount_minor }));
      expect(viaImessage).toEqual(viaEmail);
      expect(viaImessage).toEqual([{ state: 'EXPORTED', payment_type: 'PERSONAL', merchant: 'Trainline', amount_minor: 4210 }]);
    } finally {
      await h2.close();
    }
  });
});

describe('the poller', () => {
  const cursorPath = () => path.join(os.tmpdir(), `sb-imessage-cursor-${randomUUID()}.json`);
  const runFor = async (opts: { cursorFile: string }, ms: number) => {
    const abort = new AbortController();
    const done = runBlueBubblesPoller(h.deps, h.imessageConnectionId, h.bb, {
      signal: abort.signal,
      cursorFile: opts.cursorFile,
      pollIntervalMs: 5,
      retryBaseMs: 5,
      retryMaxMs: 20,
      log: () => undefined,
    });
    await new Promise((r) => setTimeout(r, ms));
    abort.abort();
    await done;
  };

  it('starts at "now" with no history, and resumes from the saved cursor after a restart', async () => {
    const old = bbMessage({ text: 'old history', dateCreated: Date.now() - 86_400_000 });
    const fresh = bbMessage({ text: 'hello', dateCreated: Date.now() + 60_000 });
    h.bb.messages = [old, fresh];
    const cursorFile = cursorPath();
    await runFor({ cursorFile }, 150);
    // Only the fresh message was ingested; history is never ingested.
    expect(await count(`SELECT count(*)::int AS n FROM inbound_messages WHERE channel = 'imessage'`)).toBe(1);

    // A restart resumes from the cursor: the fresh message is not ingested again.
    const newer = bbMessage({ text: 'hello again', dateCreated: Date.now() + 120_000 });
    h.bb.messages = [old, fresh, newer];
    await runFor({ cursorFile }, 150);
    expect(await count(`SELECT count(*)::int AS n FROM inbound_messages WHERE channel = 'imessage'`)).toBe(2);
    await h.drain();
    expect(await h.expenses()).toHaveLength(0); // text-only messages: no receipts
  });

  it('dedupes a message the server returns twice', async () => {
    const m = bbMessage({ text: 'receipt', dateCreated: Date.now() + 1000, attachments: [{ guid: h.bb.addFile(train()), mimeType: 'text/plain', transferName: 'r.txt' }] });
    h.bb.messages = [m, m];
    await runFor({ cursorFile: cursorPath() }, 150);
    await h.drain();
    expect(await count(`SELECT count(*)::int AS n FROM inbound_messages WHERE channel = 'imessage'`)).toBe(1);
    expect(await h.expenses()).toHaveLength(1);
  });

  it('survives a malformed message and a server outage', async () => {
    const good = bbMessage({ text: 'after the storm', dateCreated: Date.now() + 1000 });
    const malformed = bbMessage({ text: 'hi', handle: { address: 42 }, dateCreated: Date.now() + 500 });
    h.bb.failQueries = 2; // the first polls fail (server down)
    h.bb.messages = [malformed, good];
    await runFor({ cursorFile: cursorPath() }, 250);
    expect(await count(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'inbound.rejected'`)).toBe(1);
    expect(await count(`SELECT count(*)::int AS n FROM inbound_messages WHERE channel = 'imessage'`)).toBe(1);
  });
});
