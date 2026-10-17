import { parseArgs } from 'node:util';
import { SlackWebClient, slackChannelAddress, type SlackClient, type SlackIdentity } from '@swipeback/channels';
import { appendAudit, databaseUrl, isLocalDatabaseUrl, type Pool } from '@swipeback/db';
import { createRuntime, loadLocalEnv, runSlackSocket, type Runtime } from '@swipeback/engine';
import { DEMO_ORG_NAME } from './seed.ts';

/**
 * Developer console commands for the Slack channel. Enrolment here is an admin DEMO shortcut: a real
 * rollout would link Slack users through their verified work email and an admin approval.
 */

type Command = { describe: string; run: (args: string[]) => Promise<void> };

const SLACK_SCOPES = ['chat:write', 'im:history', 'im:read', 'im:write', 'files:read', 'users:read', 'users:read.email'];
const SLACK_USER_RE = /^[UW][A-Z0-9]{2,31}$/;

/** Idempotently record the workspace as an ACTIVE Slack connection for the organisation. */
export async function connectSlack(pool: Pool, organisationId: string, identity: Pick<SlackIdentity, 'teamId'>): Promise<{ connectionId: string; created: boolean }> {
  const address = identity.teamId.toUpperCase();
  const existing = await pool.query<{ id: string }>(
    `SELECT id FROM channel_connections WHERE organisation_id = $1 AND channel = 'slack' AND provider = 'slack-bot' AND address = $2 AND status <> 'DISCONNECTED'`,
    [organisationId, address],
  );
  if (existing.rows[0]) {
    await pool.query(`UPDATE channel_connections SET status = 'ACTIVE', updated_at = clock_timestamp() WHERE id = $1`, [existing.rows[0].id]);
    return { connectionId: existing.rows[0].id, created: false };
  }
  const admin = await pool.query<{ id: string }>(`SELECT id FROM members WHERE organisation_id = $1 AND 'admin' = ANY(roles) LIMIT 1`, [organisationId]);
  const r = await pool.query<{ id: string }>(
    `INSERT INTO channel_connections (organisation_id, channel, provider, address, scopes, status, consented_by, consented_at)
     VALUES ($1, 'slack', 'slack-bot', $2, $3, 'ACTIVE', $4, now()) RETURNING id`,
    [organisationId, address, SLACK_SCOPES, admin.rows[0]?.id ?? null],
  );
  const connectionId = r.rows[0]!.id;
  await appendAudit(pool, {
    organisationId, actorType: 'system', actorId: 'cli', action: 'connection.created', entityType: 'channel_connection', entityId: connectionId,
    after: { channel: 'slack', provider: 'slack-bot', workspace: address },
  });
  return { connectionId, created: true };
}

export interface LinkSlackInput {
  organisationId: string;
  memberEmail: string;
  teamId: string;
  slackUserId: string;
}

/**
 * Link a Slack user to a member (demo enrolment). Refuses non-local databases, like `db:reset`.
 * The address format is exactly the one the adapter emits: `slack:<team>:<user>`, lower-case.
 */
export async function linkSlackUser(pool: Pool, input: LinkSlackInput, dbUrl: string = databaseUrl()): Promise<{ channelAddress: string; created: boolean }> {
  if (!isLocalDatabaseUrl(dbUrl)) throw new Error('Refusing to create a demo enrolment on a non-local database.');
  const userId = input.slackUserId.trim().toUpperCase();
  if (!SLACK_USER_RE.test(userId)) throw new Error(`"${input.slackUserId}" is not a Slack user id (expected something like U0123ABCD).`);
  const member = await pool.query<{ id: string; status: string }>('SELECT id, status FROM members WHERE organisation_id = $1 AND lower(email) = lower($2)', [input.organisationId, input.memberEmail]);
  const m = member.rows[0];
  if (!m) throw new Error(`No member with email ${input.memberEmail} in this organisation.`);
  if (m.status !== 'ACTIVE') throw new Error(`Member ${input.memberEmail} is ${m.status}, not ACTIVE.`);
  const channelAddress = slackChannelAddress(input.teamId, userId);
  const existing = await pool.query<{ member_id: string }>(
    `SELECT member_id FROM channel_identities WHERE organisation_id = $1 AND channel = 'slack' AND lower(channel_address) = $2 AND status = 'ACTIVE'`,
    [input.organisationId, channelAddress],
  );
  if (existing.rows[0]) {
    if (existing.rows[0].member_id !== m.id) throw new Error(`${channelAddress} is already linked to a different member.`);
    return { channelAddress, created: false };
  }
  await pool.query(
    `INSERT INTO channel_identities (organisation_id, member_id, channel, channel_address, verification_method)
     VALUES ($1, $2, 'slack', $3, 'demo_enrolment')`,
    [input.organisationId, m.id, channelAddress],
  );
  await appendAudit(pool, {
    organisationId: input.organisationId, actorType: 'system', actorId: 'cli', action: 'identity.linked', entityType: 'member', entityId: m.id,
    after: { channel: 'slack', channelAddress, verificationMethod: 'demo_enrolment', demo: true },
  });
  return { channelAddress, created: true };
}

export interface SlackStatus {
  connections: { id: string; address: string; status: string; last_error: string | null }[];
  linked: { email: string; channel_address: string; verification_method: string }[];
  inbound: { received_at: Date; sender_address: string; processing_state: string; attachments: number }[];
  outbound: { created_at: Date; recipient_address: string; template: string; delivery_state: string; provider_message_id: string | null }[];
}

export async function slackStatus(pool: Pool, organisationId: string): Promise<SlackStatus> {
  const q = <T extends object>(sql: string) => pool.query<T>(sql, [organisationId]).then((r) => r.rows);
  return {
    connections: await q(`SELECT id, address, status, last_error FROM channel_connections WHERE organisation_id = $1 AND channel = 'slack' ORDER BY created_at`),
    linked: await q(
      `SELECT m.email, ci.channel_address, ci.verification_method FROM channel_identities ci JOIN members m ON m.id = ci.member_id
        WHERE ci.organisation_id = $1 AND ci.channel = 'slack' AND ci.status = 'ACTIVE' ORDER BY ci.created_at`,
    ),
    inbound: await q(
      `SELECT i.received_at, i.sender_address, i.processing_state, (SELECT count(*)::int FROM inbound_attachments a WHERE a.inbound_message_id = i.id) AS attachments
         FROM inbound_messages i WHERE i.organisation_id = $1 AND i.channel = 'slack' ORDER BY i.received_at DESC LIMIT 5`,
    ),
    outbound: await q(
      `SELECT created_at, recipient_address, template, delivery_state, provider_message_id
         FROM outbound_messages WHERE organisation_id = $1 AND channel = 'slack' ORDER BY created_at DESC LIMIT 5`,
    ),
  };
}

async function withSlackRuntime(fn: (rt: Runtime, org: { id: string }) => Promise<void>): Promise<void> {
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

function botClient(): SlackClient {
  const token = process.env.SB_SLACK_BOT_TOKEN;
  if (!token) throw new Error('SB_SLACK_BOT_TOKEN is not set (see docs/slack/SETUP.md).');
  return new SlackWebClient(token);
}

export const slackCommands: Record<string, Command> = {
  'slack:connect': {
    describe: 'Check the Slack bot token (auth.test) and create the Slack connection for the demo org (idempotent)',
    run: async () =>
      withSlackRuntime(async (rt, org) => {
        const identity = await botClient().authTest();
        const { connectionId, created } = await connectSlack(rt.pool, org.id, identity);
        console.log(`${created ? 'Created' : 'Already connected'}: workspace "${identity.team}" (${identity.teamId}), bot user @${identity.user} (${identity.userId})`);
        console.log(`Slack connection id: ${connectionId}`);
      }),
  },
  'slack:link': {
    describe: 'Link a Slack user to a member (DEMO enrolment, local DB only): sb slack:link --member-email <addr> (--slack-user U… | --lookup)',
    run: async (args) =>
      withSlackRuntime(async (rt, org) => {
        const { values } = parseArgs({ args, options: { 'member-email': { type: 'string' }, 'slack-user': { type: 'string' }, lookup: { type: 'boolean' } } });
        const email = values['member-email'];
        if (!email) throw new Error('--member-email is required');
        if (!!values['slack-user'] === !!values.lookup) throw new Error('give exactly one of --slack-user U… or --lookup');
        const client = botClient();
        const identity = await client.authTest();
        let slackUserId = values['slack-user'];
        if (values.lookup) {
          const found = await client.lookupUserByEmail(email);
          if (!found) throw new Error(`No Slack user with email ${email}. The Slack account's email must match; or pass --slack-user U….`);
          slackUserId = found.id;
        }
        const r = await linkSlackUser(rt.pool, { organisationId: org.id, memberEmail: email, teamId: identity.teamId, slackUserId: slackUserId! });
        console.log(`${r.created ? 'Linked' : 'Already linked'} ${email} -> ${r.channelAddress} (DEMO enrolment, not verified identity proof)`);
      }),
  },
  'slack:listen': {
    describe: 'Run the Slack Socket Mode listener until Ctrl+C (run the worker alongside it)',
    run: async () =>
      withSlackRuntime(async (rt, org) => {
        const appToken = process.env.SB_SLACK_APP_TOKEN;
        if (!appToken) throw new Error('SB_SLACK_APP_TOKEN is not set (see docs/slack/SETUP.md).');
        const conn = await rt.pool.query<{ id: string }>(
          `SELECT id FROM channel_connections WHERE organisation_id = $1 AND channel = 'slack' AND provider = 'slack-bot' AND status = 'ACTIVE' ORDER BY created_at LIMIT 1`,
          [org.id],
        );
        if (!conn.rows[0]) throw new Error('No active Slack connection. Run: corepack pnpm sb slack:connect');
        const abort = new AbortController();
        const stop = () => abort.abort();
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
        console.log('Listening for Slack DMs over Socket Mode (Ctrl+C to stop). Make sure the worker is running: corepack pnpm worker');
        await runSlackSocket(rt.deps, conn.rows[0].id, appToken, { signal: abort.signal });
        console.log('Stopped.');
      }),
  },
  'slack:status': {
    describe: 'Show the Slack connection, linked users and the latest Slack messages in and out',
    run: async () =>
      withSlackRuntime(async (rt, org) => {
        const s = await slackStatus(rt.pool, org.id);
        console.log(s.connections.length ? s.connections.map((c) => `connection ${c.id}: workspace ${c.address}, ${c.status}${c.last_error ? `, last error: ${c.last_error}` : ''}`).join('\n') : 'No Slack connection. Run: corepack pnpm sb slack:connect');
        console.log(`Linked users (${s.linked.length}):${s.linked.map((l) => `\n  ${l.email} -> ${l.channel_address} (${l.verification_method})`).join('')}`);
        console.log(`Latest inbound:${s.inbound.length ? '' : ' none'}${s.inbound.map((i) => `\n  ${i.received_at.toISOString()} ${i.sender_address} ${i.processing_state.toLowerCase()}, ${i.attachments} attachment(s)`).join('')}`);
        console.log(`Latest outbound:${s.outbound.length ? '' : ' none'}${s.outbound.map((o) => `\n  ${o.created_at.toISOString()} ${o.template} -> ${o.recipient_address} ${o.delivery_state.toLowerCase()}${o.provider_message_id ? ` (ts ${o.provider_message_id})` : ''}`).join('')}`);
      }),
  },
};
