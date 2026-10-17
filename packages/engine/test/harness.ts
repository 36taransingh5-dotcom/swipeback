import { randomUUID } from 'node:crypto';
import { randomBytes } from 'node:crypto';
import {
  FixtureEmailAdapter,
  GmailAdapter,
  MemoryEvidenceStore,
  MemorySink,
  SIGNATURE_HEADER,
  signSyntheticRequest,
  SyntheticChatAdapter,
} from '@swipeback/channels';
import { buildEml, buildReplyEml, type EmlSpec } from '@swipeback/channels/testing';
import { JobRunner, jobStats } from '@swipeback/db';
import { BaselineExtractor, type Extractor } from '@swipeback/extraction';
import { MockPayProvider } from '@swipeback/payouts';
import { seedDemoOrg, type SeededOrg } from '@swipeback/cli/seed';
import {
  CARD_SIGNATURE_HEADER,
  channelRegistry,
  GmailTokens,
  TokenCipher,
  type GmailRuntime,
  engineHandlers,
  receiveCardEvent,
  receiveInbound,
  signCardEvent,
  type EngineDeps,
} from '@swipeback/engine';
import { createTestDatabase, type TestDatabase } from '../../../test/support/db.ts';

export const FINANCE = 'finance@northwind.example';
export const SAM = 'sam.taylor@northwind.example';
export const ALEX = 'alex.morgan@northwind.example';
export const CONTROLLER = 'finance.controller@northwind.example';
export const CHAT_SECRET = 'synthetic-chat-secret-for-tests';
export const CARD_SECRET = 'card-feed-secret-for-tests';

export interface Harness {
  db: TestDatabase;
  deps: EngineDeps;
  org: SeededOrg;
  sink: MemorySink;
  payouts: MockPayProvider;
  emailConnectionId: string;
  chatConnectionId: string;
  clock: { offsetMs: number; now(): Date };
  runner: JobRunner;
  drain(): Promise<void>;
  email(spec: Partial<EmlSpec> & { text?: string; attachments?: EmlSpec['attachments'] }): Promise<Awaited<ReturnType<typeof receiveInbound>>>;
  emailRaw(raw: Buffer): Promise<Awaited<ReturnType<typeof receiveInbound>>>;
  reply(to: { raw: string; to: string }, spec: Partial<EmlSpec>): Promise<Awaited<ReturnType<typeof receiveInbound>>>;
  chat(payload: Record<string, unknown>): Promise<Awaited<ReturnType<typeof receiveInbound>>>;
  card(event: Partial<CardEventInput>): Promise<Awaited<ReturnType<typeof receiveCardEvent>>>;
  expenses(): Promise<ExpenseView[]>;
  sentTo(address: string, template?: string): ReturnType<MemorySink['to']>;
  outbound(template?: string): Promise<{ template: string; recipient_address: string; delivery_state: string }[]>;
  close(): Promise<void>;
  gmail: (GmailRuntime & { tokens: GmailTokens }) | null;
}

export interface ExpenseView {
  id: string;
  ref: string;
  state: string;
  member_id: string;
  payment_type: string;
  merchant: string | null;
  amount_minor: number | null;
  matched_transaction_id: string | null;
  flags: string[];
  policy_version_id: string | null;
  business_purpose: string | null;
}

export interface CardEventInput {
  transactionId: string;
  cardLast4: string;
  amountMinor: number;
  currency: string;
  merchantDescriptor: string;
  transactedAt: string;
}

/** Calendar dates relative to "now" so fixtures never age out of the claim window. */
export function ukDate(daysAgo: number): string {
  const d = new Date(Date.now() - daysAgo * 86_400_000);
  return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;
}
export function isoAt(daysAgo: number, hourUtc = 12): string {
  const d = new Date(Date.now() - daysAgo * 86_400_000);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d.toISOString();
}

export async function createHarness(opts: { extractor?: Extractor; gmailFetch?: typeof fetch } = {}): Promise<Harness> {
  const db = await createTestDatabase(30);
  const org = await seedDemoOrg(db.pool);
  const evidence = new MemoryEvidenceStore();
  const sink = new MemorySink();
  const payouts = new MockPayProvider(db.pool);
  const clock = { offsetMs: 0, now: () => new Date(Date.now() + clock.offsetMs) };
  const gmailRuntime: GmailRuntime | null = opts.gmailFetch
    ? { oauth: { clientId: 'test-client.apps.googleusercontent.com', clientSecret: 'test-secret', redirectUri: 'http://localhost:3000/api/oauth/google/callback' }, cipher: new TokenCipher(randomBytes(32).toString('base64')), fetch: opts.gmailFetch }
    : null;
  const gmail = gmailRuntime ? { ...gmailRuntime, tokens: new GmailTokens(db.pool, gmailRuntime) } : null;
  const deps: EngineDeps = {
    pool: db.pool,
    clock,
    extractor: opts.extractor ?? new BaselineExtractor(),
    payouts,
    channels: channelRegistry([
      new FixtureEmailAdapter(evidence, sink),
      new SyntheticChatAdapter(evidence, sink, CHAT_SECRET),
      ...(gmail ? [new GmailAdapter(evidence, async (id) => gmail.tokens.api(id))] : []),
    ]),
    evidence,
    config: { appUrl: 'http://localhost:3000', cardFeedSecret: CARD_SECRET },
  };
  const conn = async (channel: string, provider: string, address: string) =>
    (
      await db.pool.query<{ id: string }>(
        `INSERT INTO channel_connections (organisation_id, channel, provider, address, scopes, status, consented_by, consented_at)
         VALUES ($1, $2, $3, $4, $5, 'ACTIVE', $6, now()) RETURNING id`,
        [org.organisationId, channel, provider, address, ['fixture:read', 'fixture:send'], org.members.controller],
      )
    ).rows[0]!.id;
  const emailConnectionId = await conn('email', 'fixture', FINANCE);
  const chatConnectionId = await conn('synthetic', 'synthetic-chat', 'swipeback-bot');
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
    db, deps, org, sink, payouts, emailConnectionId, chatConnectionId, clock, runner, drain, gmail,
    email: (spec) => receiveInbound(deps, emailConnectionId, { body: buildEml({ from: SAM, to: FINANCE, ...spec }), headers: {} }),
    emailRaw: (raw) => receiveInbound(deps, emailConnectionId, { body: raw, headers: {} }),
    reply: (to, spec) => receiveInbound(deps, emailConnectionId, { body: buildReplyEml(to, { from: SAM, ...spec }), headers: {} }),
    chat: (payload) => {
      const body = JSON.stringify({ eventId: randomUUID(), from: 'chat:sam.taylor', sentAt: new Date().toISOString(), ...payload });
      return receiveInbound(deps, chatConnectionId, { body: Buffer.from(body), headers: { [SIGNATURE_HEADER]: signSyntheticRequest(CHAT_SECRET, body, Math.floor(Date.now() / 1000)) } });
    },
    card: (e) => {
      const body = JSON.stringify({
        provider: 'card-sim', transactionId: `txn-${randomUUID().slice(0, 8)}`, cardLast4: '4242', amountMinor: 1125, currency: 'GBP',
        merchantDescriptor: 'PRET A MANGER LONDON GB', transactedAt: isoAt(1), synthetic: true, ...e,
      });
      return receiveCardEvent(deps, org.organisationId, body, signCardEvent(CARD_SECRET, body, Math.floor(Date.now() / 1000)));
    },
    expenses: async () =>
      (await db.pool.query<ExpenseView>('SELECT id, ref, state, member_id, payment_type, merchant, amount_minor, matched_transaction_id, flags, policy_version_id, business_purpose FROM expenses ORDER BY created_at')).rows,
    sentTo: (address, template) => sink.to(address).filter((s) => !template || s.envelope.idempotencyKey.startsWith(`${template}:`)),
    outbound: async (template) =>
      (await db.pool.query(`SELECT template, recipient_address, delivery_state FROM outbound_messages ${template ? 'WHERE template = $1' : ''} ORDER BY created_at`, template ? [template] : [])).rows,
    close: () => db.drop(),
  };
}

export const CARD_EVENT_HEADER = CARD_SIGNATURE_HEADER;
