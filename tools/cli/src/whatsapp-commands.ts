import { parseArgs } from 'node:util';
import { appendAudit, createPool, databaseUrl, isLocalDatabaseUrl, type Queryable } from '@swipeback/db';
import { loadLocalEnv } from '@swipeback/engine';
import { DEMO_ORG_NAME } from './seed.ts';

/**
 * Developer console commands for the WhatsApp channel. Linking a phone number here is a labelled
 * DEMO enrolment: real enrolment would verify the number with a code sent to the work email.
 * Secrets are never printed.
 */

type Command = { describe: string; run: (args: string[]) => Promise<void> };

/** `+44 7700 900123` -> `+447700900123`. Strict E.164: a leading `+`, 8-15 digits, no leading zero. */
export function normalisePhone(input: string): string {
  const compact = input.trim().replace(/[\s().-]/g, '');
  if (!/^\+[1-9]\d{7,14}$/.test(compact)) throw new Error(`"${input}" is not an international number; use E.164, e.g. +447700900123`);
  return compact;
}

/** Create (idempotently) the org's WhatsApp connection for a phone number id. */
export async function connectWhatsApp(q: Queryable, organisationId: string, phoneNumberId: string): Promise<{ id: string; created: boolean }> {
  if (!/^\d{5,32}$/.test(phoneNumberId)) throw new Error('SB_WHATSAPP_PHONE_NUMBER_ID must be the numeric phone number ID from Meta');
  const existing = await q.query<{ id: string; address: string }>(
    `SELECT id, address FROM channel_connections WHERE organisation_id = $1 AND channel = 'whatsapp' AND provider = 'whatsapp-cloud' AND status = 'ACTIVE'`,
    [organisationId],
  );
  const found = existing.rows[0];
  if (found) {
    if (found.address !== phoneNumberId) await q.query('UPDATE channel_connections SET address = $2 WHERE id = $1', [found.id, phoneNumberId]);
    return { id: found.id, created: false };
  }
  const admin = await q.query<{ id: string }>(`SELECT id FROM members WHERE organisation_id = $1 AND 'admin' = ANY(roles) ORDER BY created_at LIMIT 1`, [organisationId]);
  const r = await q.query<{ id: string }>(
    `INSERT INTO channel_connections (organisation_id, channel, provider, address, scopes, status, consented_by, consented_at)
     VALUES ($1, 'whatsapp', 'whatsapp-cloud', $2, $3, 'ACTIVE', $4, now()) RETURNING id`,
    [organisationId, phoneNumberId, ['whatsapp:messages'], admin.rows[0]?.id ?? null],
  );
  await appendAudit(q, {
    organisationId, actorType: 'system', actorId: 'cli', action: 'channel_connection.created', entityType: 'channel_connection',
    entityId: r.rows[0]!.id, after: { channel: 'whatsapp', provider: 'whatsapp-cloud', address: phoneNumberId },
  });
  return { id: r.rows[0]!.id, created: true };
}

/** Link a phone number to a member as a DEMO enrolment. Refuses to steal a number from another member. */
export async function linkWhatsAppNumber(q: Queryable, organisationId: string, memberEmail: string, phone: string): Promise<{ id: string; created: boolean; address: string }> {
  const address = normalisePhone(phone);
  const member = await q.query<{ id: string; status: string }>('SELECT id, status FROM members WHERE organisation_id = $1 AND email = lower($2)', [organisationId, memberEmail.trim()]);
  const m = member.rows[0];
  if (!m) throw new Error(`no member with email ${memberEmail} in the demo organisation`);
  if (m.status !== 'ACTIVE') throw new Error(`member ${memberEmail} is disabled`);
  const existing = await q.query<{ id: string; member_id: string }>(
    `SELECT id, member_id FROM channel_identities WHERE organisation_id = $1 AND channel = 'whatsapp' AND lower(channel_address) = lower($2) AND status = 'ACTIVE'`,
    [organisationId, address],
  );
  const found = existing.rows[0];
  if (found) {
    if (found.member_id !== m.id) throw new Error(`${address} is already linked to a different member`);
    return { id: found.id, created: false, address };
  }
  const r = await q.query<{ id: string }>(
    `INSERT INTO channel_identities (organisation_id, member_id, channel, channel_address, verification_method)
     VALUES ($1, $2, 'whatsapp', $3, 'demo_enrolment') RETURNING id`,
    [organisationId, m.id, address],
  );
  await appendAudit(q, {
    organisationId, actorType: 'system', actorId: 'cli', action: 'channel_identity.linked', entityType: 'channel_identity', entityId: r.rows[0]!.id,
    after: { channel: 'whatsapp', channelAddress: address, memberId: m.id, verificationMethod: 'demo_enrolment', note: 'DEMO enrolment, number not verified' },
  });
  return { id: r.rows[0]!.id, created: true, address };
}

export async function whatsappStatus(q: Queryable, organisationId: string) {
  const connection = (await q.query(`SELECT id, address, status, created_at FROM channel_connections WHERE organisation_id = $1 AND channel = 'whatsapp' ORDER BY created_at`, [organisationId])).rows;
  const linked = (
    await q.query(
      `SELECT ci.channel_address, m.email, ci.verification_method FROM channel_identities ci JOIN members m ON m.id = ci.member_id
        WHERE ci.organisation_id = $1 AND ci.channel = 'whatsapp' AND ci.status = 'ACTIVE' ORDER BY ci.created_at`,
      [organisationId],
    )
  ).rows;
  const inbound = (
    await q.query(
      `SELECT received_at, sender_address, processing_state, processing_note, provider_event_id FROM inbound_messages
        WHERE organisation_id = $1 AND channel = 'whatsapp' ORDER BY received_at DESC LIMIT 5`,
      [organisationId],
    )
  ).rows;
  const outbound = (
    await q.query(
      `SELECT created_at, recipient_address, template, delivery_state, provider_message_id, attempts, last_error FROM outbound_messages
        WHERE organisation_id = $1 AND channel = 'whatsapp' ORDER BY created_at DESC LIMIT 5`,
      [organisationId],
    )
  ).rows;
  return { connection, linked, inbound, outbound };
}

async function withOrg(fn: (pool: ReturnType<typeof createPool>, orgId: string) => Promise<void>): Promise<void> {
  loadLocalEnv();
  const pool = createPool(databaseUrl(), 2);
  try {
    const org = await pool.query<{ id: string }>('SELECT id FROM organisations WHERE name = $1', [DEMO_ORG_NAME]);
    if (!org.rows[0]) throw new Error('Demo organisation not seeded. Run: corepack pnpm seed');
    await fn(pool, org.rows[0].id);
  } finally {
    await pool.end();
  }
}

export const whatsappCommands: Record<string, Command> = {
  'whatsapp:connect': {
    describe: 'Create the WhatsApp connection (idempotent) and print the webhook callback URL for Meta',
    run: async () =>
      withOrg(async (pool, orgId) => {
        const phoneNumberId = process.env.SB_WHATSAPP_PHONE_NUMBER_ID ?? '';
        if (!phoneNumberId) throw new Error('Set SB_WHATSAPP_PHONE_NUMBER_ID in .env.local (Meta: WhatsApp > API setup > Phone number ID)');
        const c = await connectWhatsApp(pool, orgId, phoneNumberId);
        const base = (process.env.SB_PUBLIC_BASE_URL ?? '').replace(/\/+$/, '') || '<your public tunnel URL>';
        console.log(`${c.created ? 'Created' : 'Already connected:'} WhatsApp connection ${c.id} for phone number id ${phoneNumberId}`);
        console.log(`Callback URL for Meta: ${base}/api/whatsapp/${c.id}`);
        console.log(`Verify token: the value of SB_WHATSAPP_VERIFY_TOKEN (${process.env.SB_WHATSAPP_VERIFY_TOKEN ? 'set' : 'NOT SET: set it before saving the webhook in Meta'}). Subscribe to the "messages" field.`);
        for (const name of ['SB_WHATSAPP_ACCESS_TOKEN', 'SB_WHATSAPP_APP_SECRET']) if (!process.env[name]) console.log(`Warning: ${name} is not set, so the adapter will not start.`);
      }),
  },
  'whatsapp:link': {
    describe: 'DEMO enrolment: link a phone to an employee: sb whatsapp:link --member-email <addr> --phone +44... (local database only)',
    run: async (args) => {
      const { values } = parseArgs({ args, options: { 'member-email': { type: 'string' }, phone: { type: 'string' } } });
      if (!values['member-email'] || !values.phone) throw new Error('usage: sb whatsapp:link --member-email <addr> --phone +447700900123');
      if (!isLocalDatabaseUrl(databaseUrl())) throw new Error('Refusing to create a demo enrolment in a non-local database.');
      await withOrg(async (pool, orgId) => {
        const r = await linkWhatsAppNumber(pool, orgId, values['member-email']!, values.phone!);
        console.log(`${r.created ? 'Linked' : 'Already linked:'} ${r.address} to ${values['member-email']} (DEMO enrolment: number not verified)`);
      });
    },
  },
  'whatsapp:status': {
    describe: 'Show the WhatsApp connection, linked numbers and the latest inbound/outbound messages',
    run: async () =>
      withOrg(async (pool, orgId) => {
        const s = await whatsappStatus(pool, orgId);
        console.log('Connections:'); console.table(s.connection);
        console.log('Linked numbers (DEMO enrolment):'); console.table(s.linked);
        console.log('Last inbound:'); console.table(s.inbound);
        console.log('Last outbound:'); console.table(s.outbound);
      }),
  },
};
