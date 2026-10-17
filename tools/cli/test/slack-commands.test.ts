import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyAuditChain } from '@swipeback/db';
import { createTestDatabase, type TestDatabase } from '../../../test/support/db.ts';
import { seedDemoOrg, type SeededOrg } from '../src/seed.ts';
import { connectSlack, linkSlackUser, slackStatus } from '../src/slack-commands.ts';

const LOCAL = 'postgres://postgres:postgres@localhost:5432/swipeback';
const SAM = 'sam.taylor@northwind.example';

describe('slack CLI commands', () => {
  let db: TestDatabase;
  let org: SeededOrg;
  beforeAll(async () => {
    db = await createTestDatabase(4);
    org = await seedDemoOrg(db.pool);
  });
  afterAll(async () => {
    await db?.drop();
  });

  it('slack:connect creates one ACTIVE Slack connection per workspace and is idempotent', async () => {
    const first = await connectSlack(db.pool, org.organisationId, { teamId: 'T0TEAM01' });
    const again = await connectSlack(db.pool, org.organisationId, { teamId: 'T0TEAM01' });
    expect(first.created).toBe(true);
    expect(again).toEqual({ connectionId: first.connectionId, created: false });
    const rows = (await db.pool.query(`SELECT channel, provider, address, status FROM channel_connections WHERE channel = 'slack'`)).rows;
    expect(rows).toEqual([{ channel: 'slack', provider: 'slack-bot', address: 'T0TEAM01', status: 'ACTIVE' }]);
  });

  it('slack:link writes the identity in the exact lower-case format the adapter emits, labelled as demo enrolment and audited', async () => {
    const r = await linkSlackUser(db.pool, { organisationId: org.organisationId, memberEmail: SAM.toUpperCase(), teamId: 'T0TEAM01', slackUserId: 'u0sam0001' }, LOCAL);
    expect(r).toEqual({ channelAddress: 'slack:t0team01:u0sam0001', created: true });
    const rows = (await db.pool.query(`SELECT channel, channel_address, verification_method, status, member_id FROM channel_identities WHERE channel = 'slack'`)).rows;
    expect(rows).toEqual([{ channel: 'slack', channel_address: 'slack:t0team01:u0sam0001', verification_method: 'demo_enrolment', status: 'ACTIVE', member_id: org.members.employee }]);
    const audit = (await db.pool.query(`SELECT action, after FROM audit_events WHERE action = 'identity.linked'`)).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0].after).toMatchObject({ channelAddress: 'slack:t0team01:u0sam0001', verificationMethod: 'demo_enrolment', demo: true });
    expect((await verifyAuditChain(db.pool, org.organisationId)).ok).toBe(true);
  });

  it('slack:link is idempotent, and will not re-point an address at a different member', async () => {
    const same = await linkSlackUser(db.pool, { organisationId: org.organisationId, memberEmail: SAM, teamId: 'T0TEAM01', slackUserId: 'U0SAM0001' }, LOCAL);
    expect(same.created).toBe(false);
    await expect(
      linkSlackUser(db.pool, { organisationId: org.organisationId, memberEmail: 'alex.morgan@northwind.example', teamId: 'T0TEAM01', slackUserId: 'U0SAM0001' }, LOCAL),
    ).rejects.toThrow('already linked to a different member');
    expect(Number((await db.pool.query(`SELECT count(*) FROM channel_identities WHERE channel = 'slack'`)).rows[0].count)).toBe(1);
  });

  it('slack:link refuses non-local databases', async () => {
    await expect(
      linkSlackUser(db.pool, { organisationId: org.organisationId, memberEmail: 'alex.morgan@northwind.example', teamId: 'T0TEAM01', slackUserId: 'U0ALEX001' }, 'postgres://u:p@db.example.com:5432/prod'),
    ).rejects.toThrow('non-local database');
    expect(Number((await db.pool.query(`SELECT count(*) FROM channel_identities WHERE channel = 'slack'`)).rows[0].count)).toBe(1);
  });

  it('slack:link rejects malformed Slack ids and unknown members', async () => {
    await expect(linkSlackUser(db.pool, { organisationId: org.organisationId, memberEmail: SAM, teamId: 'T0TEAM01', slackUserId: 'sam' }, LOCAL)).rejects.toThrow('not a Slack user id');
    await expect(linkSlackUser(db.pool, { organisationId: org.organisationId, memberEmail: 'nobody@northwind.example', teamId: 'T0TEAM01', slackUserId: 'U0NOBODY1' }, LOCAL)).rejects.toThrow('No member');
  });

  it('slack:status reports the connection and linked users', async () => {
    const s = await slackStatus(db.pool, org.organisationId);
    expect(s.connections).toMatchObject([{ address: 'T0TEAM01', status: 'ACTIVE' }]);
    expect(s.linked).toEqual([{ email: SAM, channel_address: 'slack:t0team01:u0sam0001', verification_method: 'demo_enrolment' }]);
    expect(s.inbound).toEqual([]);
    expect(s.outbound).toEqual([]);
  });
});
