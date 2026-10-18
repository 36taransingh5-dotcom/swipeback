import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyAuditChain } from '@swipeback/db';
import { createTestDatabase, type TestDatabase } from '../../../test/support/db.ts';
import { seedDemoOrg, type SeededOrg } from '../src/seed.ts';
import { connectImessage, imessageStatus, linkImessageMember, maskHandle, maskImessageAddress } from '../src/imessage-commands.ts';

const LOCAL = 'postgres://postgres:postgres@localhost:5432/swipeback';
const SAM = 'sam.taylor@northwind.example';

describe('imessage CLI commands', () => {
  let db: TestDatabase;
  let org: SeededOrg;
  beforeAll(async () => {
    db = await createTestDatabase(4);
    org = await seedDemoOrg(db.pool);
  });
  afterAll(async () => {
    await db?.drop();
  });

  it('masks phone numbers and Apple ID emails', () => {
    expect(maskHandle('+447700900123')).toBe('+44•••23');
    expect(maskHandle('employee@example.com')).toBe('e•••@example.com');
    expect(maskImessageAddress('imessage:+447700900123')).toBe('imessage:+44•••23');
    expect(maskImessageAddress('imessage:+447700900123')).not.toContain('900123');
  });

  it('imessage:connect creates one ACTIVE iMessage connection per bot address and is idempotent', async () => {
    const first = await connectImessage(db.pool, org.organisationId, { address: 'swipeback-demo-bot@example.com' });
    const again = await connectImessage(db.pool, org.organisationId, { address: 'swipeback-demo-bot@example.com' });
    expect(first.created).toBe(true);
    expect(again).toEqual({ connectionId: first.connectionId, created: false });
    const rows = (await db.pool.query(`SELECT channel, provider, address, status FROM channel_connections WHERE channel = 'imessage'`)).rows;
    expect(rows).toEqual([{ channel: 'imessage', provider: 'bluebubbles', address: 'swipeback-demo-bot@example.com', status: 'ACTIVE' }]);
  });

  it('imessage:link writes the identity in the exact format the adapter emits, labelled as demo enrolment and audited (masked)', async () => {
    const r = await linkImessageMember(db.pool, { organisationId: org.organisationId, memberEmail: SAM.toUpperCase(), handle: '+44 7700 900123' }, LOCAL);
    expect(r).toEqual({ channelAddress: 'imessage:+447700900123', created: true });
    const rows = (await db.pool.query(`SELECT channel, channel_address, verification_method, status, member_id FROM channel_identities WHERE channel = 'imessage'`)).rows;
    expect(rows).toEqual([{ channel: 'imessage', channel_address: 'imessage:+447700900123', verification_method: 'demo_enrolment', status: 'ACTIVE', member_id: org.members.employee }]);
    const audit = (await db.pool.query<{ action: string; after: Record<string, unknown> }>(`SELECT action, after FROM audit_events WHERE action = 'identity.linked'`)).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0]!.after).toMatchObject({ channelAddress: 'imessage:+44•••23', verificationMethod: 'demo_enrolment', demo: true });
    expect(JSON.stringify(audit[0]!.after)).not.toContain('900123');
    expect((await verifyAuditChain(db.pool, org.organisationId)).ok).toBe(true);
  });

  it('imessage:link is idempotent, and will not re-point a handle at a different member', async () => {
    const same = await linkImessageMember(db.pool, { organisationId: org.organisationId, memberEmail: SAM, handle: '+447700900123' }, LOCAL);
    expect(same.created).toBe(false);
    await expect(
      linkImessageMember(db.pool, { organisationId: org.organisationId, memberEmail: 'alex.morgan@northwind.example', handle: '+447700900123' }, LOCAL),
    ).rejects.toThrow('already linked to a different member');
    expect(Number((await db.pool.query(`SELECT count(*) FROM channel_identities WHERE channel = 'imessage'`)).rows[0].count)).toBe(1);
  });

  it('imessage:link refuses non-local databases', async () => {
    await expect(
      linkImessageMember(db.pool, { organisationId: org.organisationId, memberEmail: 'alex.morgan@northwind.example', handle: '+447700900456' }, 'postgres://u:p@db.example.com:5432/prod'),
    ).rejects.toThrow('non-local database');
    expect(Number((await db.pool.query(`SELECT count(*) FROM channel_identities WHERE channel = 'imessage'`)).rows[0].count)).toBe(1);
  });

  it('imessage:link rejects unknown members and empty handles', async () => {
    await expect(linkImessageMember(db.pool, { organisationId: org.organisationId, memberEmail: 'nobody@northwind.example', handle: '+447700900456' }, LOCAL)).rejects.toThrow('No member');
    await expect(linkImessageMember(db.pool, { organisationId: org.organisationId, memberEmail: SAM, handle: '   ' }, LOCAL)).rejects.toThrow('handle');
  });

  it('imessage:status reports the connection and linked handles', async () => {
    const s = await imessageStatus(db.pool, org.organisationId);
    expect(s.connections).toMatchObject([{ address: 'swipeback-demo-bot@example.com', status: 'ACTIVE' }]);
    expect(s.linked).toEqual([{ email: SAM, channel_address: 'imessage:+447700900123', verification_method: 'demo_enrolment' }]);
    expect(s.inbound).toEqual([]);
    expect(s.outbound).toEqual([]);
  });
});
