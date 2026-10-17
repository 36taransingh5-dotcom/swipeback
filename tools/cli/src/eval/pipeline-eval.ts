import { createHash, randomBytes } from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import pg from 'pg';
import { FixtureEmailAdapter, MemoryEvidenceStore, MemorySink, type SentRecord } from '@swipeback/channels';
import { buildEml, buildReplyEml } from '@swipeback/channels/testing';
import { createPool, JobRunner, jobStats, migrate, verifyAuditChain, type Pool } from '@swipeback/db';
import { merchantSimilarity } from '@swipeback/domain';
import { channelRegistry, engineHandlers, receiveCardEvent, receiveInbound, signCardEvent, type EngineDeps } from '@swipeback/engine';
import { TransientExtractionError, type Extractor } from '@swipeback/extraction';
import { MockPayProvider } from '@swipeback/payouts';
import { receiptText } from '../receipts.ts';
import { seedDemoOrg } from '../seed.ts';
import { loadDataset } from './benchmark.ts';
import { docLabel, type Doc, type Outcome, type PipelineCase, type Who } from './pipeline-cases.ts';

/**
 * Plays evaluation cases through the real engine: each case gets a fresh database cloned from a
 * migrated template, the seeded synthetic organisation, the fixture email transport, the signed
 * card simulator and MockPay — the same job pipeline the worker runs. Nothing is stubbed except
 * the transports (and, for the outage case, the model provider).
 */

/** Cases are evaluated "as of" this instant so the frozen receipts never age out of the claim window. */
export const EVAL_NOW = Date.parse('2026-10-17T18:00:00Z');

const FINANCE = 'finance@northwind.example';
const ADDRESS: Record<Who, string> = {
  sam: 'sam.taylor@northwind.example',
  alex: 'alex.morgan@northwind.example',
  stranger: 'stranger@northwind.example',
};
const CARD_SECRET = 'eval-card-feed-secret';
const FOLLOW_UP_TEMPLATES = ['question', 'receipt-request'];

export interface EvalDatabase {
  adminUrl: string;
  templateDb: string;
}

const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

// ---------------------------------------------------------------------------------------------
// Infrastructure
// ---------------------------------------------------------------------------------------------

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      srv.close(() => (typeof addr === 'object' && addr ? resolve(addr.port) : reject(new Error('no port'))));
    });
  });
}

/** A throwaway embedded Postgres with a migrated template database. */
export async function startEvalDatabase(): Promise<EvalDatabase & { stop(): Promise<void> }> {
  const { startEmbeddedPostgres } = await import('@swipeback/db/embedded');
  const dataDir = path.resolve('.data/eval', `pg-${process.pid}-${randomBytes(3).toString('hex')}`);
  const cluster = await startEmbeddedPostgres({ dataDir, port: await freePort(), persistent: false, fast: true, quiet: true });
  const templateDb = 'sb_eval_template';
  await cluster.createDatabase(templateDb);
  const pool = createPool(cluster.url(templateDb), 2);
  try {
    await migrate(pool);
  } finally {
    await pool.end();
  }
  return { adminUrl: cluster.url('postgres'), templateDb, stop: () => cluster.stop() };
}

async function cloneDatabase(db: EvalDatabase): Promise<{ pool: Pool; drop(): Promise<void> }> {
  const name = `sb_eval_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: db.adminUrl });
  await admin.connect();
  try {
    for (let i = 0; ; i++) {
      try {
        await admin.query(`CREATE DATABASE "${name}" TEMPLATE "${db.templateDb}"`);
        break;
      } catch (err) {
        if (i >= 30 || !/being accessed by other users/.test((err as Error).message)) throw err;
        await new Promise((r) => setTimeout(r, 50 + Math.random() * 100));
      }
    }
  } finally {
    await admin.end();
  }
  const pool = createPool(db.adminUrl.replace(/\/postgres$/, `/${name}`), 10);
  return {
    pool,
    async drop() {
      await pool.end();
      const c = new pg.Client({ connectionString: db.adminUrl });
      await c.connect();
      try {
        await c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      } finally {
        await c.end();
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------------------------

export interface Attachment {
  filename: string;
  mime: string;
  content: Buffer;
}

export class DocumentStore {
  private constructor(private readonly heldout: Map<string, { bytes: Buffer; mime: string }>) {}

  static async load(): Promise<DocumentStore> {
    const { entries } = await loadDataset(); // verifies every frozen image against its checksum
    return new DocumentStore(new Map(entries.map((e) => [e.id, { bytes: e.bytes, mime: e.mime }])));
  }

  attachment(d: Doc): Attachment {
    if (d.kind === 'malformed') return { filename: 'receipt.pdf', mime: 'application/pdf', content: Buffer.from('this is not a pdf') };
    if (d.kind === 'text') return { filename: 'receipt.txt', mime: 'text/plain', content: Buffer.from(receiptText(d.spec), 'utf8') };
    const f = this.heldout.get(d.id);
    if (!f) throw new Error(`held-out image ${d.id} not loaded`);
    return { filename: `receipt.${f.mime === 'image/png' ? 'png' : 'jpg'}`, mime: f.mime, content: f.bytes };
  }
}

/** Fails like a provider outage for the designated documents; everything else goes to the real extractor. */
function withOutages(inner: Extractor, outageHashes: Set<string>): Extractor {
  return {
    name: inner.name,
    extract: async (source, ctx) => {
      if (outageHashes.has(source.sha256)) throw new TransientExtractionError('503 service unavailable (simulated outage)');
      return inner.extract(source, ctx);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Running one case
// ---------------------------------------------------------------------------------------------

export interface MeasuredExpense {
  ref: string;
  sourceType: string;
  state: string;
  paymentType: string;
  outcome: Outcome;
  matchedSwipe: string | null;
  amountMinor: number | null;
  currency: string | null;
  reasons: string[];
  flags: string[];
  reimbursement: { state: string; amountMinor: number } | null;
}

export interface ExtractionScore {
  docLabelled: boolean;
  status: string;
  /** Replay mode had no recorded model response for this document (not a model result). */
  missingRecording: boolean;
  merchant: boolean;
  amount: boolean;
  currency: boolean;
  date: boolean;
}

export interface CaseRun {
  id: string;
  split: string;
  scenario: string;
  title: string;
  expenses: MeasuredExpense[];
  quarantined: number;
  followUps: number;
  reminders: number;
  payouts: { amountMinor: number; ref: string }[];
  extractions: ExtractionScore[];
  llm: { calls: number; costMicros: number; unknownCost: number; latencyMs: number };
  auditOk: boolean;
  wallMs: number;
  error: string | null;
}

export async function runCase(db: EvalDatabase, docs: DocumentStore, c: PipelineCase, extractor: Extractor): Promise<CaseRun> {
  const started = Date.now();
  const offset = EVAL_NOW - started;
  const clock = { now: () => new Date(Date.now() + offset) };
  const { pool, drop } = await cloneDatabase(db);
  const run: CaseRun = {
    id: c.id, split: c.split, scenario: c.scenario, title: c.title, expenses: [], quarantined: 0, followUps: 0, reminders: 0, payouts: [],
    extractions: [], llm: { calls: 0, costMicros: 0, unknownCost: 0, latencyMs: 0 }, auditOk: false, wallMs: 0, error: null,
  };
  try {
    const org = await seedDemoOrg(pool);
    const evidence = new MemoryEvidenceStore();
    const sink = new MemorySink();
    const outages = new Set<string>();
    const labels = new Map<string, ReturnType<typeof docLabel>>();
    const attachmentFor = (d: Doc) => {
      const a = docs.attachment(d);
      const h = sha256(a.content);
      labels.set(h, docLabel(d));
      if (d.kind === 'text' && d.outage) outages.add(h);
      return a;
    };
    const deps: EngineDeps = {
      pool,
      clock,
      extractor: withOutages(extractor, outages),
      payouts: new MockPayProvider(pool),
      channels: channelRegistry([new FixtureEmailAdapter(evidence, sink)]),
      evidence,
      config: { appUrl: 'http://localhost:3000', cardFeedSecret: CARD_SECRET },
    };
    const connectionId = (
      await pool.query<{ id: string }>(
        `INSERT INTO channel_connections (organisation_id, channel, provider, address, scopes, status, consented_by, consented_at)
         VALUES ($1, 'email', 'fixture', $2, $3, 'ACTIVE', $4, now()) RETURNING id`,
        [org.organisationId, FINANCE, ['fixture:read', 'fixture:send'], org.members.controller],
      )
    ).rows[0]!.id;
    const runner = new JobRunner(pool, engineHandlers(deps), { backoffBaseMs: 5, backoffMaxMs: 20, batchSize: 10, onError: () => undefined });
    const drain = async () => {
      for (let i = 0; i < 500; i++) {
        if ((await runner.runOnce()) > 0) continue;
        const ready = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM jobs WHERE state = 'QUEUED' AND run_at <= clock_timestamp() + interval '50 milliseconds'`);
        if (ready.rows[0]!.n === 0 && (await jobStats(pool)).RUNNING === 0) return;
        await new Promise((r) => setTimeout(r, 15));
      }
      throw new Error('job queue did not settle');
    };
    const elapse = async (kind: string) => {
      await pool.query(`UPDATE jobs SET run_at = clock_timestamp() WHERE kind = $1 AND state = 'QUEUED'`, [kind]);
      await drain();
    };
    const deliver = (raw: Buffer) => receiveInbound(deps, connectionId, { body: raw, headers: {} });

    const sentEmails = new Map<string, Buffer>();
    const swipes = new Map<string, { descriptor: string }>();
    for (const step of c.steps) {
      switch (step.do) {
        case 'swipe': {
          const body = JSON.stringify({
            provider: 'card-sim', transactionId: `${c.id}-${step.id}`, cardLast4: step.last4 ?? '4242', amountMinor: Math.round(Number(step.amount) * 100),
            currency: 'GBP', merchantDescriptor: step.descriptor, transactedAt: step.at, synthetic: true,
          });
          const r = await receiveCardEvent(deps, org.organisationId, body, signCardEvent(CARD_SECRET, body, Math.floor(clock.now().getTime() / 1000)));
          if (r.status !== 'ACCEPTED') throw new Error(`swipe ${step.id} rejected: ${r.reason}`);
          swipes.set(step.id, { descriptor: step.descriptor });
          break;
        }
        case 'email': {
          const doc = step.doc ? attachmentFor(step.doc) : null;
          const inline = step.doc?.kind === 'text' && step.doc.inline;
          const raw = buildEml({
            from: ADDRESS[step.from ?? 'sam'], to: FINANCE, subject: step.subject ?? 'Receipt', auth: step.auth ?? 'pass',
            text: inline ? `${step.body ? `${step.body}\n\n` : ''}${doc!.content.toString('utf8')}` : (step.body ?? ''),
            ...(doc && !inline ? { attachments: [doc] } : {}),
          });
          if (step.id) sentEmails.set(step.id, raw);
          await deliver(raw);
          break;
        }
        case 'redeliver': {
          const raw = sentEmails.get(step.id);
          if (!raw) throw new Error(`no email ${step.id} to redeliver`);
          for (let i = 0; i < step.times; i++) await deliver(raw);
          break;
        }
        case 'reply': {
          const to = ADDRESS[step.from ?? 'sam'];
          const asked = sink.to(to).filter((s) => FOLLOW_UP_TEMPLATES.some((t) => s.envelope.idempotencyKey.startsWith(`${t}:`))).at(-1);
          if (!asked) throw new Error('reply step: no question or receipt request was sent to reply to');
          let text = step.body ?? '';
          if (step.pick) text = pickOption(asked, swipes.get(step.pick)?.descriptor ?? step.pick);
          const doc = step.doc ? attachmentFor(step.doc) : null;
          await deliver(buildReplyEml({ raw: asked.raw, to }, { from: to, text, ...(doc ? { attachments: [doc] } : {}) }));
          break;
        }
        case 'chase':
          await elapse('receipt-chase');
          break;
        case 'expire':
          for (let i = 0; i < 2; i++) await elapse('question-timeout');
          break;
      }
      await drain();
    }

    run.expenses = await measureExpenses(pool, c.id);
    run.quarantined = (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM inbound_messages WHERE processing_state = 'QUARANTINED'`)).rows[0]!.n;
    const out = (await pool.query<{ template: string }>(`SELECT template FROM outbound_messages WHERE recipient_member_id IS DISTINCT FROM $1`, [org.members.controller])).rows;
    run.followUps = out.filter((o) => FOLLOW_UP_TEMPLATES.includes(o.template)).length;
    run.reminders = out.filter((o) => o.template === 'question-reminder').length;
    run.payouts = (await pool.query<{ amount_minor: string; simulated_payout_ref: string }>(`SELECT amount_minor, simulated_payout_ref FROM reimbursements WHERE state = 'SIMULATED_PAID'`)).rows.map((r) => ({
      amountMinor: Number(r.amount_minor), ref: r.simulated_payout_ref,
    }));
    run.extractions = (await pool.query<{ file_hash: string; status: string; error: string | null; fields: { facts?: { merchant: string | null; amount: { amountMinor: number; currency: string } | null; date: string | null } } }>(
      `SELECT r.file_hash, x.status, x.error, x.fields FROM extractions x JOIN receipts r ON r.id = x.receipt_id ORDER BY x.created_at`,
    )).rows.map((x) => {
      const label = labels.get(x.file_hash) ?? null;
      const f = x.fields.facts;
      return {
        docLabelled: !!label,
        status: x.status,
        missingRecording: /no recorded \w+ response/.test(x.error ?? ''),
        merchant: !!label && !!f?.merchant && merchantSimilarity(f.merchant, label.merchant) >= 0.75,
        amount: !!label && f?.amount?.amountMinor === label.totalMinor,
        currency: !!label && f?.amount?.currency === label.currency,
        date: !!label && f?.date === label.date,
      };
    });
    const llm = (await pool.query<{ calls: number; cost: string | null; unknown: number; latency: string | null }>(
      `SELECT count(*)::int AS calls, sum(cost_micros) AS cost, count(*) FILTER (WHERE cost_micros IS NULL)::int AS unknown, sum(latency_ms) AS latency FROM llm_calls`,
    )).rows[0]!;
    run.llm = { calls: llm.calls, costMicros: Number(llm.cost ?? 0), unknownCost: llm.unknown, latencyMs: Number(llm.latency ?? 0) };
    run.auditOk = (await verifyAuditChain(pool, org.organisationId)).ok;
  } catch (err) {
    run.error = (err as Error).message;
  } finally {
    await drop();
    run.wallMs = Date.now() - started;
  }
  return run;
}

/** Answer a match-confirmation question with the option that names the given card descriptor. */
function pickOption(question: SentRecord, descriptor: string): string {
  for (const line of question.envelope.text.split('\n')) {
    const m = /Reply (\d+)\s+—\s+(.*)$/.exec(line);
    if (m && m[2]!.includes(descriptor)) return m[1]!;
  }
  throw new Error(`no option for ${descriptor} in the question`);
}

async function measureExpenses(pool: Pool, caseId: string): Promise<MeasuredExpense[]> {
  const rows = (await pool.query<{
    ref: string; source_type: string; state: string; payment_type: string; provider_transaction_id: string | null; amount_minor: string | null;
    currency: string | null; flags: string[]; reasons: string[] | null; r_state: string | null; r_amount: string | null;
  }>(
    `SELECT e.ref, e.source_type, e.state, e.payment_type, t.provider_transaction_id, e.amount_minor, e.currency, e.flags,
            d.reason_codes AS reasons, r.state AS r_state, r.amount_minor AS r_amount
       FROM expenses e
       LEFT JOIN policy_decisions d ON d.id = e.last_decision_id
       -- a receipt-to-transaction match as decided, not a card-led expense's link to its own swipe
       LEFT JOIN transactions t ON e.receipt_id IS NOT NULL AND d.sources->'match'->>'status' = 'MATCHED' AND t.id = (d.sources->'match'->>'transactionId')::uuid
       LEFT JOIN reimbursements r ON r.expense_id = e.id AND r.state <> 'CANCELED'
      WHERE e.state <> 'MERGED'
      ORDER BY e.created_at, e.ref`,
  )).rows;
  return rows.map((e) => {
    const reimbursement = e.r_state ? { state: e.r_state, amountMinor: Number(e.r_amount) } : null;
    return {
      ref: e.ref,
      sourceType: e.source_type,
      state: e.state,
      paymentType: e.payment_type,
      outcome: classify(e.state, e.payment_type, reimbursement?.state ?? null),
      matchedSwipe: e.provider_transaction_id ? e.provider_transaction_id.slice(caseId.length + 1) : null,
      amountMinor: e.amount_minor === null ? null : Number(e.amount_minor),
      currency: e.currency,
      reasons: e.reasons ?? [],
      flags: e.flags,
      reimbursement,
    };
  });
}

export function classify(state: string, paymentType: string, reimbursementState: string | null): Outcome {
  if (state === 'AUTO_CLEARED' || state === 'EXPORTED' || state === 'APPROVED') {
    if (paymentType === 'CORPORATE') return 'CLEARED_CARD';
    return reimbursementState === 'SIMULATED_PAID' ? 'CLEARED_PAID' : 'CLEARED_AWAITING_PAYMENT_APPROVAL';
  }
  if (state === 'REVIEW_REQUIRED') return 'REVIEW';
  if (state === 'REJECTED') return 'REJECTED';
  return 'WAITING';
}
