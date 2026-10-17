import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { buildEml } from '@swipeback/channels/testing';
import { JobRunner, jobStats } from '@swipeback/db';
import { createRuntime, engineHandlers, loadLocalEnv, receiveCardEvent, receiveInbound, signCardEvent, type Runtime } from '@swipeback/engine';
import { DEMO_ORG_NAME } from './seed.ts';

/**
 * Developer console commands for the offline pipeline (fixture email transport + card simulator).
 * Everything here is labelled synthetic; replayed email is never presented as live mail.
 */

type Command = { describe: string; run: (args: string[]) => Promise<void> };

async function withRuntime(fn: (rt: Runtime, org: { id: string; designated_address: string }) => Promise<void>): Promise<void> {
  loadLocalEnv();
  const rt = createRuntime();
  try {
    const org = await rt.pool.query<{ id: string; designated_address: string }>('SELECT id, designated_address FROM organisations WHERE name = $1', [DEMO_ORG_NAME]);
    if (!org.rows[0]) throw new Error('Demo organisation not seeded. Run: corepack pnpm seed');
    await fn(rt, org.rows[0]);
  } finally {
    await rt.pool.end();
  }
}

async function ensureConnection(rt: Runtime, orgId: string, channel: string, provider: string, address: string): Promise<string> {
  const existing = await rt.pool.query<{ id: string }>(
    `SELECT id FROM channel_connections WHERE organisation_id = $1 AND channel = $2 AND provider = $3 AND status = 'ACTIVE'`,
    [orgId, channel, provider],
  );
  if (existing.rows[0]) return existing.rows[0].id;
  const admin = await rt.pool.query<{ id: string }>(`SELECT id FROM members WHERE organisation_id = $1 AND 'admin' = ANY(roles) LIMIT 1`, [orgId]);
  const r = await rt.pool.query<{ id: string }>(
    `INSERT INTO channel_connections (organisation_id, channel, provider, address, scopes, status, consented_by, consented_at)
     VALUES ($1,$2,$3,$4,$5,'ACTIVE',$6,now()) RETURNING id`,
    [orgId, channel, provider, address, [`${provider}:replay`], admin.rows[0]?.id ?? null],
  );
  return r.rows[0]!.id;
}

async function drain(rt: Runtime): Promise<void> {
  const runner = new JobRunner(rt.pool, engineHandlers(rt.deps), { workerId: 'cli', onError: (j, e) => console.error(`  job ${j.kind} failed: ${(e as Error).message}`) });
  for (let i = 0; i < 200; i++) if ((await runner.runOnce()) === 0) break;
}

export const pipelineCommands: Record<string, Command> = {
  'connect:fixture': {
    describe: 'Create the offline (fixture) email connection and the synthetic chat connection for the demo org',
    run: async () =>
      withRuntime(async (rt, org) => {
        const email = await ensureConnection(rt, org.id, 'email', 'fixture', org.designated_address);
        const chat = await ensureConnection(rt, org.id, 'synthetic', 'synthetic-chat', 'swipeback-bot');
        console.log(`fixture email connection ${email} (${org.designated_address}); synthetic chat connection ${chat}`);
      }),
  },
  replay: {
    describe: 'Ingest an .eml file through the fixture email transport, then run jobs: sb replay <file.eml> [--no-run]',
    run: async (args) =>
      withRuntime(async (rt, org) => {
        const { positionals, values } = parseArgs({ args, allowPositionals: true, options: { 'no-run': { type: 'boolean' } } });
        if (!positionals[0]) throw new Error('usage: sb replay <file.eml>');
        const conn = await ensureConnection(rt, org.id, 'email', 'fixture', org.designated_address);
        const r = await receiveInbound(rt.deps, conn, { body: await readFile(positionals[0]), headers: {} });
        console.log('replayed (fixture transport):', r);
        if (!values['no-run']) await drain(rt);
        console.log(`outbound messages written to ${rt.outboxDir}`);
      }),
  },
  email: {
    describe: 'Compose a synthetic email and ingest it: sb email --from <addr> [--text ..] [--attach file] [--subject ..]',
    run: async (args) =>
      withRuntime(async (rt, org) => {
        const { values } = parseArgs({
          args,
          options: { from: { type: 'string' }, text: { type: 'string' }, attach: { type: 'string', multiple: true }, subject: { type: 'string' }, 'no-run': { type: 'boolean' } },
        });
        if (!values.from) throw new Error('--from is required');
        const attachments = await Promise.all(
          (values.attach ?? []).map(async (f) => ({ filename: path.basename(f), mime: mimeFor(f), content: await readFile(f) })),
        );
        const raw = buildEml({ from: values.from, to: org.designated_address, subject: values.subject ?? 'Receipt', text: values.text ?? '', attachments });
        const conn = await ensureConnection(rt, org.id, 'email', 'fixture', org.designated_address);
        console.log('ingested (fixture transport):', await receiveInbound(rt.deps, conn, { body: raw, headers: {} }));
        if (!values['no-run']) await drain(rt);
      }),
  },
  'card-sim': {
    describe: 'Emit a signed SYNTHETIC company-card transaction: sb card-sim --amount 11.25 --merchant "PRET A MANGER" [--card 4242]',
    run: async (args) =>
      withRuntime(async (rt, org) => {
        const { values } = parseArgs({
          args,
          options: { amount: { type: 'string' }, merchant: { type: 'string' }, card: { type: 'string' }, currency: { type: 'string' }, at: { type: 'string' }, id: { type: 'string' }, 'no-run': { type: 'boolean' } },
        });
        if (!values.amount || !values.merchant) throw new Error('--amount and --merchant are required');
        const amountMinor = Math.round(Number(values.amount) * 100);
        const body = JSON.stringify({
          provider: 'card-sim',
          transactionId: values.id ?? `sim-${randomUUID().slice(0, 12)}`,
          cardLast4: values.card ?? '4242',
          amountMinor,
          currency: values.currency ?? 'GBP',
          merchantDescriptor: values.merchant.toUpperCase(),
          transactedAt: values.at ?? new Date().toISOString(),
          synthetic: true,
        });
        const sig = signCardEvent(rt.deps.config.cardFeedSecret, body, Math.floor(Date.now() / 1000));
        console.log('card event (SYNTHETIC):', await receiveCardEvent(rt.deps, org.id, body, sig));
        if (!values['no-run']) await drain(rt);
      }),
  },
  'run-jobs': {
    describe: 'Run all ready jobs once (instead of a long-running worker)',
    run: async () =>
      withRuntime(async (rt) => {
        await drain(rt);
        console.log(await jobStats(rt.pool));
      }),
  },
  expenses: {
    describe: 'List expenses with state, payment type and the latest decision',
    run: async () =>
      withRuntime(async (rt, org) => {
        const r = await rt.pool.query(
          `SELECT e.ref, e.state, e.payment_type, e.merchant, e.amount_minor, e.currency, d.outcome, d.reason_codes, r.state AS payout, r.simulated_payout_ref
             FROM expenses e LEFT JOIN policy_decisions d ON d.id = e.last_decision_id
             LEFT JOIN reimbursements r ON r.expense_id = e.id AND r.state <> 'CANCELED'
            WHERE e.organisation_id = $1 ORDER BY e.created_at`,
          [org.id],
        );
        console.table(r.rows);
      }),
  },
};

function mimeFor(file: string): string {
  const ext = path.extname(file).toLowerCase();
  return ({ '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.txt': 'text/plain', '.html': 'text/html' } as Record<string, string>)[ext] ?? 'application/octet-stream';
}
