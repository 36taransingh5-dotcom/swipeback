import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FixtureEmailAdapter,
  MemoryEvidenceStore,
  MemorySink,
  SlackAdapter,
  SlackApiError,
  type SlackClient,
  type SlackDownload,
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
  questionTimeout,
  receiveInbound,
  receiveSlackEvent,
  runSlackSocket,
  slackAdapterFromEnv,
  type EngineDeps,
  type SocketLike,
} from '@swipeback/engine';
import { textReceipt } from '../../../test/fixtures/receipts.ts';
import { createTestDatabase, type TestDatabase } from '../../../test/support/db.ts';
import { ukDate } from './harness.ts';

/**
 * Slack end to end on real Postgres: a fake Slack API stands in for the network, everything else
 * (adapter, intake, jobs, policy, outbox) is the real engine.
 */

const TEAM = 'T0TEAM01';
const SAM = 'U0SAM0001';
const SAM_DM = 'D0SAM0001';
const SAM_ADDRESS = 'slack:t0team01:u0sam0001';
const STRANGER = 'U0STRNGR1';
const FINANCE = 'finance@northwind.example';

const train = (no = Math.floor(Math.random() * 1e6)) =>
  textReceipt({ merchant: 'Trainline', receiptNo: `TL-${no}`, date: ukDate(1), items: [['Off-peak return London Euston - Watford Junction', '42.10']], total: '42.10', paidWith: { card: '9911' } });
const costa = () =>
  textReceipt({ merchant: 'Costa Coffee', receiptNo: `C-${Math.floor(Math.random() * 1e6)}`, date: ukDate(1), items: [['Latte', '3.95'], ['Toastie', '4.45']], total: '8.40', paidWith: { card: '9911' } });
const PURPOSE = 'Coffee and lunch with the Acme site team during the install';

let tsCounter = 0;
const nextTs = () => `1760700000.${String(++tsCounter).padStart(6, '0')}`;

interface Post {
  channel: string;
  text: string;
  threadTs: string | undefined;
  ts: string;
}

class FakeSlack implements SlackClient {
  readonly files = new Map<string, SlackDownload>();
  readonly posts: Post[] = [];
  readonly order: string[] = [];
  postError: Error | null = null;
  /** Fail this many downloads before succeeding. */
  failDownloads = 0;
  private n = 0;

  addFile(content: string | Buffer, contentType = 'text/plain'): string {
    const url = `https://files.slack.com/files-pri/${TEAM}-F${++this.n}/download`;
    this.files.set(url, { bytes: Buffer.from(content), contentType });
    return url;
  }
  async authTest() {
    return { teamId: TEAM, team: 'Demo', userId: 'U0BOT0001', user: 'swipeback' };
  }
  async openConversation(userId: string) {
    return userId === SAM ? SAM_DM : `D${userId.slice(1)}`;
  }
  async postMessage(input: { channel: string; text: string; threadTs?: string | undefined }) {
    if (this.postError) throw this.postError;
    const post = { channel: input.channel, text: input.text, threadTs: input.threadTs, ts: nextTs() };
    this.posts.push(post);
    return { ts: post.ts, channel: post.channel };
  }
  async lookupUserByEmail() {
    return null;
  }
  async downloadFile(url: string): Promise<SlackDownload> {
    this.order.push('download');
    if (this.failDownloads > 0) {
      this.failDownloads--;
      throw new SlackApiError('http_503', 'files.download');
    }
    const f = this.files.get(url);
    if (!f) throw new SlackApiError('http_404', 'files.download');
    return f;
  }
}

interface SlackHarness {
  db: TestDatabase;
  deps: EngineDeps;
  org: SeededOrg;
  slack: FakeSlack;
  emailSink: MemorySink;
  slackConnectionId: string;
  emailConnectionId: string;
  runner: JobRunner;
  drain(): Promise<void>;
  /** The employee sends a DM. Returns the message ts and the Socket Mode envelope used. */
  dm(opts: { text?: string; receipt?: string; ts?: string; threadTs?: string; user?: string }): Promise<{ ts: string; envelope: unknown; outcome: Awaited<ReturnType<typeof receiveSlackEvent>> }>;
  expenses(): Promise<{ id: string; ref: string; state: string; payment_type: string; merchant: string | null; amount_minor: number | null; business_purpose: string | null; flags: string[] }[]>;
  close(): Promise<void>;
}

function socketEnvelope(event: unknown, team = TEAM) {
  return { type: 'events_api', envelope_id: randomUUID(), payload: { team_id: team, event_id: `Ev${randomUUID().slice(0, 8)}`, event } };
}

async function createSlackHarness(): Promise<SlackHarness> {
  const db = await createTestDatabase(30);
  const org = await seedDemoOrg(db.pool);
  const evidence = new MemoryEvidenceStore();
  const emailSink = new MemorySink();
  const slack = new FakeSlack();
  const deps: EngineDeps = {
    pool: db.pool,
    clock: { now: () => new Date() },
    extractor: new BaselineExtractor(),
    payouts: new MockPayProvider(db.pool),
    channels: channelRegistry([new FixtureEmailAdapter(evidence, emailSink), new SlackAdapter(evidence, slack, '')]),
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
  const slackConnectionId = await conn('slack', 'slack-bot', TEAM);
  await db.pool.query(
    `INSERT INTO channel_identities (organisation_id, member_id, channel, channel_address, verification_method) VALUES ($1, $2, 'slack', $3, 'demo_enrolment')`,
    [org.organisationId, org.members.employee, SAM_ADDRESS],
  );
  const runner = new JobRunner(db.pool, engineHandlers(deps), { backoffBaseMs: 5, backoffMaxMs: 20, batchSize: 10, onError: () => undefined });
  const drain = async () => {
    for (let i = 0; i < 500; i++) {
      const n = await runner.runOnce();
      if (n === 0) {
        const ready = await db.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM jobs WHERE state = 'QUEUED' AND run_at <= clock_timestamp() + interval '50 milliseconds'`);
        if (ready.rows[0]!.n === 0 && (await jobStats(db.pool)).RUNNING === 0) return;
        await new Promise((r) => setTimeout(r, 15));
      }
    }
    throw new Error('drain did not settle');
  };
  return {
    db, deps, org, slack, emailSink, slackConnectionId, emailConnectionId, runner, drain,
    dm: async ({ text = '', receipt, ts = nextTs(), threadTs, user = SAM }) => {
      const event = {
        type: 'message', ...(receipt ? { subtype: 'file_share' } : {}), user, channel: user === SAM ? SAM_DM : `D${user.slice(1)}`, channel_type: 'im', ts, ...(threadTs ? { thread_ts: threadTs } : {}), text,
        files: receipt ? [{ id: 'F0001', name: 'receipt.txt', mimetype: 'text/plain', url_private_download: slack.addFile(receipt) }] : [],
      };
      const envelope = socketEnvelope(event);
      return { ts, envelope, outcome: await receiveSlackEvent(deps, slackConnectionId, envelope) };
    },
    expenses: async () =>
      (await db.pool.query('SELECT id, ref, state, payment_type, merchant, amount_minor, business_purpose, flags FROM expenses ORDER BY created_at')).rows,
    close: () => db.drop(),
  };
}

let h: SlackHarness;
beforeEach(async () => {
  h = await createSlackHarness();
});
afterEach(async () => {
  const audit = await verifyAuditChain(h.db.pool, h.org.organisationId);
  expect(audit.ok, JSON.stringify(audit.problems)).toBe(true);
  await h.close();
});

const count = async (sql: string, params: unknown[] = []) => (await h.db.pool.query<{ n: number }>(sql, params)).rows[0]!.n;

describe('threading (docs/slack/CLAUDE.md §4.6)', () => {
  it('1. a receipt in a DM is auto-cleared and the reply appears in that message’s thread', async () => {
    const { ts, outcome } = await h.dm({ receipt: train(), text: 'Train to the Watford site' });
    expect(outcome).toMatchObject({ status: 'ACCEPTED', duplicate: false });
    await h.drain();
    const [e] = await h.expenses();
    expect(e).toMatchObject({ state: 'EXPORTED', payment_type: 'PERSONAL', merchant: 'Trainline', amount_minor: 4210 });
    expect(h.slack.posts).toHaveLength(1);
    expect(h.slack.posts[0]).toMatchObject({ channel: SAM_DM, threadTs: ts });
    expect(h.slack.posts[0]!.text).toContain(e!.ref);
    expect(h.slack.posts[0]!.text).toContain('SYNTHETIC DEMO');
    const sent = (await h.db.pool.query(`SELECT delivery_state, provider_message_id, thread_id FROM outbound_messages WHERE channel = 'slack'`)).rows;
    expect(sent).toEqual([{ delivery_state: 'SENT', provider_message_id: h.slack.posts[0]!.ts, thread_id: `slack:${SAM_DM}:${ts}` }]);
    expect(await count(`SELECT count(*)::int AS n FROM receipts WHERE source_kind = 'CHAT_MEDIA'`)).toBe(1);
    expect((await h.db.pool.query(`SELECT source_type, source_channel FROM expenses`)).rows).toEqual([{ source_type: 'CHAT', source_channel: 'slack' }]);
  });

  it('2. receipt, one question, answer in the thread: the answer attaches to that expense', async () => {
    const { ts } = await h.dm({ receipt: costa() });
    await h.drain();
    expect((await h.expenses())[0]!.state).toBe('NEEDS_INFO');
    expect(h.slack.posts).toHaveLength(1);
    expect(h.slack.posts[0]).toMatchObject({ threadTs: ts });
    expect(h.slack.posts[0]!.text).toContain('What was the business purpose?');
    expect(h.slack.posts[0]!.text).toContain('Reply in this thread.');

    const reply = await h.dm({ text: PURPOSE, threadTs: ts });
    expect(reply.outcome.status).toBe('ACCEPTED');
    await h.drain();
    const expenses = await h.expenses();
    expect(expenses).toHaveLength(1); // the answer did not create a new expense
    expect(expenses[0]).toMatchObject({ state: 'EXPORTED', business_purpose: PURPOSE });
    expect(await count(`SELECT count(*)::int AS n FROM open_questions WHERE status = 'ANSWERED'`)).toBe(1);
    expect(h.slack.posts.at(-1)!.threadTs).toBe(ts);
  });

  it('3. a new top-level receipt while a question is open becomes a new expense, not an answer', async () => {
    const first = await h.dm({ receipt: costa() });
    await h.drain();
    const second = await h.dm({ receipt: train() });
    await h.drain();
    const expenses = await h.expenses();
    expect(expenses).toHaveLength(2);
    expect(expenses.map((e) => e.state).sort()).toEqual(['EXPORTED', 'NEEDS_INFO']);
    expect(await count(`SELECT count(*)::int AS n FROM open_questions WHERE status = 'OPEN'`)).toBe(1);
    // Each receipt got its own thread.
    expect(h.slack.posts.map((p) => p.threadTs).sort()).toEqual([first.ts, second.ts].sort());
  });

  it('4. an answer posted at top level instead of in the thread is not attached to a guess: the question stays open and finance sees it on expiry', async () => {
    const { ts } = await h.dm({ receipt: costa() });
    await h.drain();
    const stray = await h.dm({ text: PURPOSE }); // top level, no thread_ts
    expect(stray.outcome.status).toBe('ACCEPTED');
    await h.drain();
    const [e, ...rest] = await h.expenses();
    expect(rest).toHaveLength(0); // no new expense from the stray message
    expect(e).toMatchObject({ state: 'NEEDS_INFO', business_purpose: null }); // not answered, not cleared
    expect(await count(`SELECT count(*)::int AS n FROM open_questions WHERE status = 'OPEN'`)).toBe(1);
    expect(await count(`SELECT count(*)::int AS n FROM reimbursements`)).toBe(0);
    expect((await h.db.pool.query(`SELECT processing_state FROM inbound_messages ORDER BY received_at DESC LIMIT 1`)).rows[0].processing_state).toBe('PROCESSED');

    // The existing question lifecycle then hands it to finance: reminder in the original thread, then expiry escalates.
    const token = (await h.db.pool.query(`SELECT correlation_token FROM open_questions`)).rows[0].correlation_token;
    expect(await questionTimeout(h.deps, token, 'REMIND')).toBe('reminded');
    await h.db.pool.query(`DELETE FROM jobs WHERE kind = 'question-timeout'`);
    await h.drain();
    expect(h.slack.posts.at(-1)).toMatchObject({ threadTs: ts });
    expect(await questionTimeout(h.deps, token, 'EXPIRE')).toBe('expired');
    await h.drain();
    expect((await h.expenses())[0]!.state).toBe('REVIEW_REQUIRED');
  });
});

describe('intake safety', () => {
  it('the same envelope delivered five times creates one expense', async () => {
    const first = await h.dm({ receipt: train() });
    const outcomes = [first.outcome];
    for (let i = 0; i < 4; i++) outcomes.push(await receiveSlackEvent(h.deps, h.slackConnectionId, first.envelope));
    expect(outcomes.map((o) => (o.status === 'ACCEPTED' ? o.duplicate : 'x'))).toEqual([false, true, true, true, true]);
    await h.drain();
    expect(await h.expenses()).toHaveLength(1);
    expect(await count(`SELECT count(*)::int AS n FROM inbound_messages WHERE channel = 'slack'`)).toBe(1);
    expect(h.slack.posts).toHaveLength(1);
  });

  it('an unknown Slack user is quarantined with at most one enrolment reply', async () => {
    await h.dm({ receipt: train(), user: STRANGER });
    await h.dm({ receipt: train(), user: STRANGER });
    await h.drain();
    expect(await h.expenses()).toHaveLength(0);
    expect((await h.db.pool.query(`SELECT processing_state FROM inbound_messages`)).rows.map((r) => r.processing_state)).toEqual(['QUARANTINED', 'QUARANTINED']);
    expect(await count(`SELECT count(*)::int AS n FROM outbound_messages WHERE template = 'enrolment'`)).toBe(1);
    expect(h.slack.posts).toHaveLength(1);
    expect(await count(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'inbound.quarantined'`)).toBe(2);
  });

  it('events from another workspace are ignored; malformed messages are rejected and audited', async () => {
    const other = await receiveSlackEvent(h.deps, h.slackConnectionId, socketEnvelope({ type: 'message', user: SAM, channel: SAM_DM, channel_type: 'im', ts: nextTs(), text: 'hi' }, 'T0OTHER99'));
    expect(other).toEqual({ status: 'IGNORED', reason: 'NOT_ADDRESSED_TO_CONNECTION' });
    const bad = await receiveSlackEvent(h.deps, h.slackConnectionId, socketEnvelope({ type: 'message', user: 'nope', channel: SAM_DM, channel_type: 'im', ts: nextTs(), text: 'hi' }));
    expect(bad).toEqual({ status: 'REJECTED', reason: 'MALFORMED' });
    expect(await count(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'inbound.rejected'`)).toBe(1);
    expect(await count(`SELECT count(*)::int AS n FROM inbound_messages`)).toBe(0);
  });

  it('bot posts, edits and non-DM events create nothing, so our own replies cannot loop', async () => {
    const ignored = [
      { type: 'message', bot_id: 'B0001', user: SAM, channel: SAM_DM, channel_type: 'im', ts: nextTs(), text: 'SB-1001 cleared' },
      { type: 'message', subtype: 'message_changed', channel: SAM_DM, channel_type: 'im', message: {} },
      { type: 'message', user: SAM, channel: 'C0PUBLIC1', channel_type: 'channel', ts: nextTs(), text: 'hi' },
      { type: 'reaction_added', user: SAM, reaction: 'eyes' },
    ];
    for (const event of ignored) expect(await receiveSlackEvent(h.deps, h.slackConnectionId, socketEnvelope(event))).toMatchObject({ status: 'IGNORED' });
    expect(await count(`SELECT count(*)::int AS n FROM inbound_messages`)).toBe(0);
  });

  it('a failed file download creates no inbound message and no expense', async () => {
    h.slack.failDownloads = 1;
    await expect(h.dm({ receipt: train() })).rejects.toThrow('http_503');
    expect(await count(`SELECT count(*)::int AS n FROM inbound_messages`)).toBe(0);
    expect(await h.expenses()).toHaveLength(0);
  });
});

describe('delivery failure', () => {
  it('a Slack send failure leaves the message undelivered and recorded; the case stays decided and reviewable; it can be redelivered', async () => {
    h.slack.postError = new SlackApiError('not_in_channel', 'chat.postMessage');
    await h.dm({ receipt: train() });
    await h.drain();
    expect((await h.expenses())[0]!.state).toBe('EXPORTED'); // the decision does not depend on the reply
    const [msg] = (await h.db.pool.query<{ id: string; delivery_state: string; last_error: string; attempts: number }>(`SELECT id, delivery_state, last_error, attempts FROM outbound_messages WHERE channel = 'slack'`)).rows;
    expect(msg).toMatchObject({ delivery_state: 'FAILED', last_error: 'slack chat.postMessage failed: not_in_channel' });
    expect(msg!.attempts).toBeGreaterThan(1);
    expect(h.slack.posts).toHaveLength(0);
    expect(await count(`SELECT count(*)::int AS n FROM jobs WHERE kind = 'deliver-outbound' AND state = 'DEAD'`)).toBe(1);

    h.slack.postError = null;
    expect(await deliverOutbound(h.deps, msg!.id)).toBe('SENT');
    expect(h.slack.posts).toHaveLength(1);
  });
});

describe('channel neutrality', () => {
  const emailAttachments = (text: string) => [{ filename: 'receipt.txt', mime: 'text/plain', content: text }];
  const summarise = async (x: SlackHarness) => ({
    expenses: (await x.expenses()).map((e) => ({ state: e.state, payment_type: e.payment_type, merchant: e.merchant, amount_minor: e.amount_minor, flags: e.flags })),
    decisions: (await x.db.pool.query<{ outcome: string; reason_codes: string[] }>('SELECT outcome, reason_codes FROM policy_decisions ORDER BY decided_at')).rows,
    ledger: await x.db.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM reimbursements').then((r) => r.rows[0]!.n),
  });

  it.each([
    ['an in-policy personal receipt', train(424242)],
    ['a receipt that needs one question', costa()],
  ])('the same receipt via email and via Slack gives the same decision: %s', async (_name, receipt) => {
    // Slack on the harness database.
    await h.dm({ receipt });
    await h.drain();
    const viaSlack = await summarise(h);

    // Email on a fresh database, so duplicate detection cannot see the Slack copy.
    const email = await createSlackHarness();
    try {
      await receiveInbound(email.deps, email.emailConnectionId, {
        body: buildEml({ from: 'sam.taylor@northwind.example', to: FINANCE, attachments: emailAttachments(receipt) }),
        headers: {},
      });
      await email.drain();
      expect(await summarise(email)).toEqual(viaSlack);
    } finally {
      await email.close();
    }
  });
});

describe('configuration', () => {
  it('registers the Slack adapter only when SB_SLACK_BOT_TOKEN is set', () => {
    const evidence = new MemoryEvidenceStore();
    expect(slackAdapterFromEnv({}, evidence)).toBeNull();
    expect(slackAdapterFromEnv({ SB_SLACK_SIGNING_SECRET: 'only-a-secret' }, evidence)).toBeNull();
    expect(slackAdapterFromEnv({ SB_SLACK_BOT_TOKEN: 'xoxb-test' }, evidence)).toBeInstanceOf(SlackAdapter);
  });
});

/** A WebSocket the test drives by hand. */
class FakeSocket implements SocketLike {
  readonly sent: string[] = [];
  closed = false;
  private readonly listeners: Record<string, ((ev: { data?: unknown }) => void)[]> = {};
  constructor(private readonly onSend: (data: string) => void) {}
  send(data: string): void {
    this.sent.push(data);
    this.onSend(data);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit('close', {});
  }
  addEventListener(type: string, listener: (ev: { data?: unknown }) => void): void {
    (this.listeners[type] ??= []).push(listener);
  }
  emit(type: string, ev: { data?: unknown }): void {
    for (const l of this.listeners[type] ?? []) l(ev);
  }
  receive(frame: unknown): void {
    this.emit('message', { data: typeof frame === 'string' ? frame : JSON.stringify(frame) });
  }
}

async function waitFor(check: () => Promise<boolean> | boolean, what: string, ms = 5000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe('Socket Mode loop', () => {
  const start = () => {
    const sockets: FakeSocket[] = [];
    const logs: string[] = [];
    const abort = new AbortController();
    const done = runSlackSocket(h.deps, h.slackConnectionId, 'xapp-test', {
      signal: abort.signal,
      openUrl: async () => 'wss://fake.slack.test/link',
      connect: () => {
        const s = new FakeSocket((data) => h.slack.order.push(`ack:${(JSON.parse(data) as { envelope_id: string }).envelope_id}`));
        sockets.push(s);
        return s;
      },
      log: (m) => logs.push(m),
      retryBaseMs: 1,
      retryMaxMs: 5,
      eventRetryMs: 1,
    });
    return { sockets, logs, abort, done };
  };
  const eventFrame = (receipt: string, envelopeId: string) => {
    const e = socketEnvelope({
      type: 'message', subtype: 'file_share', user: SAM, channel: SAM_DM, channel_type: 'im', ts: nextTs(), text: '',
      files: [{ id: 'F1', name: 'receipt.txt', mimetype: 'text/plain', url_private_download: h.slack.addFile(receipt) }],
    });
    return { ...e, envelope_id: envelopeId };
  };
  const inbound = () => count(`SELECT count(*)::int AS n FROM inbound_messages`);

  it('acknowledges each envelope before processing it, survives malformed frames, and stops cleanly on abort', async () => {
    const { sockets, logs, abort, done } = start();
    await waitFor(() => sockets.length === 1, 'the first connection');
    const ws = sockets[0]!;
    ws.receive({ type: 'hello' });
    ws.receive('this is not json{');
    ws.receive('42');
    ws.receive(eventFrame(train(), 'env-1'));
    await waitFor(async () => (await inbound()) === 1, 'the first event to be ingested');
    // Ack was sent before the file was even downloaded.
    expect(h.slack.order).toEqual(['ack:env-1', 'download']);
    expect(ws.sent).toEqual([JSON.stringify({ envelope_id: 'env-1' })]);
    expect(logs.filter((l) => l.includes('malformed frame'))).toHaveLength(2);

    // The loop is still alive after the bad frames, and a bad event does not stop it.
    ws.receive(socketEnvelope({ type: 'message', user: 'bad', channel: SAM_DM, channel_type: 'im', ts: nextTs(), text: 'x' }));
    ws.receive(eventFrame(train(), 'env-3'));
    await waitFor(async () => (await inbound()) === 2, 'the second event to be ingested');
    expect(ws.sent.map((s) => (JSON.parse(s) as { envelope_id: string }).envelope_id)).toEqual(['env-1', expect.any(String), 'env-3']);

    abort.abort();
    await done;
    expect(ws.closed).toBe(true);
  });

  it('reconnects after a disconnect frame and after the socket drops', async () => {
    const { sockets, abort, done } = start();
    await waitFor(() => sockets.length === 1, 'the first connection');
    sockets[0]!.receive({ type: 'hello' });
    sockets[0]!.receive({ type: 'disconnect', reason: 'refresh_requested' });
    await waitFor(() => sockets.length === 2, 'a reconnect after disconnect');
    sockets[1]!.receive({ type: 'hello' });
    sockets[1]!.close();
    await waitFor(() => sockets.length === 3, 'a reconnect after a dropped socket');
    abort.abort();
    await done;
  });

  it('retries a transient failure while processing, since Slack will not redeliver an acknowledged envelope', async () => {
    const { sockets, logs, abort, done } = start();
    await waitFor(() => sockets.length === 1, 'the first connection');
    h.slack.failDownloads = 2;
    sockets[0]!.receive(eventFrame(train(), 'env-retry'));
    await waitFor(async () => (await inbound()) === 1, 'the retried event to be ingested');
    expect(logs.filter((l) => l.includes('event failed'))).toHaveLength(2);
    await h.drain();
    expect(await h.expenses()).toHaveLength(1);
    abort.abort();
    await done;
  });

  it('keeps running after giving up on one event', async () => {
    const { sockets, logs, abort, done } = start();
    await waitFor(() => sockets.length === 1, 'the first connection');
    h.slack.failDownloads = 99;
    sockets[0]!.receive(eventFrame(train(), 'env-poison'));
    await waitFor(() => logs.filter((l) => l.includes('event failed')).length === 3, 'the retries to be exhausted');
    h.slack.failDownloads = 0;
    sockets[0]!.receive(eventFrame(train(), 'env-after'));
    await waitFor(async () => (await inbound()) === 1, 'the next event to be ingested');
    abort.abort();
    await done;
  });
});
