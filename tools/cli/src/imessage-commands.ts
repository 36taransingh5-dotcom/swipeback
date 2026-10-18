import path from 'node:path';
import { parseArgs } from 'node:util';
import { BlueBubblesRestClient, imessageChannelAddress, type BlueBubblesClient } from '@swipeback/channels';
import { appendAudit, databaseUrl, isLocalDatabaseUrl, type Pool } from '@swipeback/db';
import { createRuntime, loadLocalEnv, runBlueBubblesPoller, type Runtime } from '@swipeback/engine';
import { DEMO_ORG_NAME } from './seed.ts';

/**
 * Developer console commands for the iMessage (BlueBubbles) channel. Enrolment here is an admin
 * DEMO shortcut: a real rollout would link handles through a verified channel and an admin approval.
 * Phone numbers and Apple ID emails are masked in all output.
 */

type Command = { describe: string; run: (args: string[]) => Promise<void> };

const IMESSAGE_SCOPES = ['bluebubbles:read', 'bluebubbles:send'];

/** Mask a phone number or Apple ID email for output: +44•••23, e•••@example.com. */
export function maskHandle(handle: string): string {
  const h = handle.trim();
  if (h.includes('@')) {
    const [user, domain] = h.split('@');
    return `${user?.[0] ?? ''}•••@${domain ?? ''}`;
  }
  const digits = h.replace(/\D/g, '');
  return `${h.startsWith('+') ? '+' : ''}${digits.slice(0, 2)}•••${digits.slice(-2)}`;
}

export function maskImessageAddress(channelAddress: string): string {
  if (!channelAddress.startsWith('imessage:')) return channelAddress;
  return `imessage:${maskHandle(channelAddress.slice('imessage:'.length))}`;
}

/** Idempotently record the bot's address as an ACTIVE iMessage connection for the organisation. */
export async function connectImessage(pool: Pool, organisationId: string, input: { address: string }): Promise<{ connectionId: string; created: boolean }> {
  const address = input.address.trim();
  if (!address) throw new Error('the BlueBubbles label (the bot’s Apple ID or number) is required');
  const existing = await pool.query<{ id: string }>(
    `SELECT id FROM channel_connections WHERE organisation_id = $1 AND channel = 'imessage' AND provider = 'bluebubbles' AND address = $2 AND status <> 'DISCONNECTED'`,
    [organisationId, address],
  );
  if (existing.rows[0]) {
    await pool.query(`UPDATE channel_connections SET status = 'ACTIVE', updated_at = clock_timestamp() WHERE id = $1`, [existing.rows[0].id]);
    return { connectionId: existing.rows[0].id, created: false };
  }
  const admin = await pool.query<{ id: string }>(`SELECT id FROM members WHERE organisation_id = $1 AND 'admin' = ANY(roles) LIMIT 1`, [organisationId]);
  const r = await pool.query<{ id: string }>(
    `INSERT INTO channel_connections (organisation_id, channel, provider, address, scopes, status, consented_by, consented_at)
     VALUES ($1, 'imessage', 'bluebubbles', $2, $3, 'ACTIVE', $4, now()) RETURNING id`,
    [organisationId, address, IMESSAGE_SCOPES, admin.rows[0]?.id ?? null],
  );
  const connectionId = r.rows[0]!.id;
  await appendAudit(pool, {
    organisationId, actorType: 'system', actorId: 'cli', action: 'connection.created', entityType: 'channel_connection', entityId: connectionId,
    after: { channel: 'imessage', provider: 'bluebubbles', address: maskHandle(address) },
  });
  return { connectionId, created: true };
}

export interface LinkImessageInput {
  organisationId: string;
  memberEmail: string;
  /** The employee's iPhone number or Apple ID email. */
  handle: string;
}

/**
 * Link an iMessage handle to a member (demo enrolment). Refuses non-local databases, like
 * `db:reset`. The address format is exactly the one the adapter emits: `imessage:<handle>`,
 * lower-cased, phone punctuation stripped.
 */
export async function linkImessageMember(pool: Pool, input: LinkImessageInput, dbUrl: string = databaseUrl()): Promise<{ channelAddress: string; created: boolean }> {
  if (!isLocalDatabaseUrl(dbUrl)) throw new Error('Refusing to create a demo enrolment on a non-local database.');
  const channelAddress = imessageChannelAddress(input.handle);
  if (channelAddress === 'imessage:') throw new Error('a handle (phone number or Apple ID email) is required');
  const member = await pool.query<{ id: string; status: string }>('SELECT id, status FROM members WHERE organisation_id = $1 AND lower(email) = lower($2)', [input.organisationId, input.memberEmail]);
  const m = member.rows[0];
  if (!m) throw new Error(`No member with email ${input.memberEmail} in this organisation.`);
  if (m.status !== 'ACTIVE') throw new Error(`Member ${input.memberEmail} is ${m.status}, not ACTIVE.`);
  const existing = await pool.query<{ member_id: string }>(
    `SELECT member_id FROM channel_identities WHERE organisation_id = $1 AND channel = 'imessage' AND lower(channel_address) = $2 AND status = 'ACTIVE'`,
    [input.organisationId, channelAddress],
  );
  if (existing.rows[0]) {
    if (existing.rows[0].member_id !== m.id) throw new Error(`${maskImessageAddress(channelAddress)} is already linked to a different member.`);
    return { channelAddress, created: false };
  }
  await pool.query(
    `INSERT INTO channel_identities (organisation_id, member_id, channel, channel_address, verification_method)
     VALUES ($1, $2, 'imessage', $3, 'demo_enrolment')`,
    [input.organisationId, m.id, channelAddress],
  );
  await appendAudit(pool, {
    organisationId: input.organisationId, actorType: 'system', actorId: 'cli', action: 'identity.linked', entityType: 'member', entityId: m.id,
    after: { channel: 'imessage', channelAddress: maskImessageAddress(channelAddress), verificationMethod: 'demo_enrolment', demo: true },
  });
  return { channelAddress, created: true };
}

export interface IMessageStatus {
  connections: { id: string; address: string; status: string; last_error: string | null }[];
  linked: { email: string; channel_address: string; verification_method: string }[];
  inbound: { received_at: Date; sender_address: string; processing_state: string; attachments: number }[];
  outbound: { created_at: Date; recipient_address: string; template: string; delivery_state: string; provider_message_id: string | null }[];
}

export async function imessageStatus(pool: Pool, organisationId: string): Promise<IMessageStatus> {
  const q = <T extends object>(sql: string) => pool.query<T>(sql, [organisationId]).then((r) => r.rows);
  return {
    connections: await q(`SELECT id, address, status, last_error FROM channel_connections WHERE organisation_id = $1 AND channel = 'imessage' ORDER BY created_at`),
    linked: await q(
      `SELECT m.email, ci.channel_address, ci.verification_method FROM channel_identities ci JOIN members m ON m.id = ci.member_id
        WHERE ci.organisation_id = $1 AND ci.channel = 'imessage' AND ci.status = 'ACTIVE' ORDER BY ci.created_at`,
    ),
    inbound: await q(
      `SELECT i.received_at, i.sender_address, i.processing_state, (SELECT count(*)::int FROM inbound_attachments a WHERE a.inbound_message_id = i.id) AS attachments
         FROM inbound_messages i WHERE i.organisation_id = $1 AND i.channel = 'imessage' ORDER BY i.received_at DESC LIMIT 5`,
    ),
    outbound: await q(
      `SELECT created_at, recipient_address, template, delivery_state, provider_message_id
         FROM outbound_messages WHERE organisation_id = $1 AND channel = 'imessage' ORDER BY created_at DESC LIMIT 5`,
    ),
  };
}

async function withImessageRuntime(fn: (rt: Runtime, org: { id: string }) => Promise<void>): Promise<void> {
  loadLocalEnv();
  const rt = createRuntime();
  try {
    const org = await rt.pool.query<{ id: string }>('SELECT id FROM organisations WHERE name = $1', [DEMO_ORG_NAME]);
    if (!org.rows[0]) throw new Error('Demo organisation not seeded. Run: corepack pnpm seed');
    await fn(rt, org.rows[0]);
  } finally {
    await rt.pool.end();
  }
}

function serverClient(): { client: BlueBubblesClient; label: string } {
  const url = process.env.SB_BLUEBUBBLES_URL;
  const password = process.env.SB_BLUEBUBBLES_PASSWORD;
  if (!url || !password) throw new Error('SB_BLUEBUBBLES_URL and SB_BLUEBUBBLES_PASSWORD must be set (see docs/imessage/SETUP.md).');
  const label = process.env.SB_BLUEBUBBLES_LABEL;
  if (!label) throw new Error('SB_BLUEBUBBLES_LABEL must be set to the bot’s Apple ID or number (see docs/imessage/SETUP.md).');
  return { client: new BlueBubblesRestClient(url, password), label };
}

export const imessageCommands: Record<string, Command> = {
  'imessage:connect': {
    describe: 'Ping the BlueBubbles server and create the iMessage connection for the demo org (idempotent)',
    run: async () =>
      withImessageRuntime(async (rt, org) => {
        const { client, label } = serverClient();
        await client.ping();
        const { connectionId, created } = await connectImessage(rt.pool, org.id, { address: label });
        console.log(`${created ? 'Created' : 'Already connected'}: BlueBubbles server reachable, bot ${maskHandle(label)}`);
        console.log(`iMessage connection id: ${connectionId}`);
      }),
  },
  'imessage:link': {
    describe: 'Link an iMessage handle to a member (DEMO enrolment, local DB only): sb imessage:link --member-email <addr> --handle <number-or-apple-id>',
    run: async (args) =>
      withImessageRuntime(async (rt, org) => {
        const { values } = parseArgs({ args, options: { 'member-email': { type: 'string' }, handle: { type: 'string' } } });
        if (!values['member-email'] || !values.handle) throw new Error('--member-email and --handle are required');
        const r = await linkImessageMember(rt.pool, { organisationId: org.id, memberEmail: values['member-email'], handle: values.handle });
        console.log(`${r.created ? 'Linked' : 'Already linked'} ${values['member-email']} -> ${maskImessageAddress(r.channelAddress)} (DEMO enrolment, not verified identity proof)`);
      }),
  },
  'imessage:listen': {
    describe: 'Poll the BlueBubbles server for new iMessages until Ctrl+C (run the worker alongside it)',
    run: async () =>
      withImessageRuntime(async (rt, org) => {
        const { client } = serverClient();
        const conn = await rt.pool.query<{ id: string }>(
          `SELECT id FROM channel_connections WHERE organisation_id = $1 AND channel = 'imessage' AND provider = 'bluebubbles' AND status = 'ACTIVE' ORDER BY created_at LIMIT 1`,
          [org.id],
        );
        if (!conn.rows[0]) throw new Error('No active iMessage connection. Run: corepack pnpm sb imessage:connect');
        const cursorFile = path.join(path.resolve(process.env.SB_DATA_DIR ?? '.data'), 'imessage-cursor.json');
        const abort = new AbortController();
        const stop = () => abort.abort();
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
        console.log('Polling the BlueBubbles server for new iMessages (Ctrl+C to stop). Make sure the worker is running: corepack pnpm worker');
        await runBlueBubblesPoller(rt.deps, conn.rows[0].id, client, { signal: abort.signal, cursorFile });
        console.log('Stopped.');
      }),
  },
  'imessage:status': {
    describe: 'Show the iMessage connection, linked handles (masked) and the latest iMessages in and out',
    run: async () =>
      withImessageRuntime(async (rt, org) => {
        const s = await imessageStatus(rt.pool, org.id);
        console.log(s.connections.length ? s.connections.map((c) => `connection ${c.id}: bot ${maskHandle(c.address)}, ${c.status}${c.last_error ? `, last error: ${c.last_error}` : ''}`).join('\n') : 'No iMessage connection. Run: corepack pnpm sb imessage:connect');
        console.log(`Linked handles (${s.linked.length}):${s.linked.map((l) => `\n  ${l.email} -> ${maskImessageAddress(l.channel_address)} (${l.verification_method})`).join('')}`);
        console.log(`Latest inbound:${s.inbound.length ? '' : ' none'}${s.inbound.map((i) => `\n  ${i.received_at.toISOString()} ${maskImessageAddress(i.sender_address)} ${i.processing_state.toLowerCase()}, ${i.attachments} attachment(s)`).join('')}`);
        console.log(`Latest outbound:${s.outbound.length ? '' : ' none'}${s.outbound.map((o) => `\n  ${o.created_at.toISOString()} ${o.template} -> ${maskImessageAddress(o.recipient_address)} ${o.delivery_state.toLowerCase()}`).join('')}`);
      }),
  },
};
