import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyAuditChain } from '@swipeback/db';
import { connectWhatsApp, linkWhatsAppNumber, normalisePhone, whatsappStatus } from '../src/whatsapp-commands.ts';
import { seedDemoOrg, type SeededOrg } from '../src/seed.ts';
import { createTestDatabase, type TestDatabase } from '../../../test/support/db.ts';

let db: TestDatabase;
let org: SeededOrg;

beforeAll(async () => {
  db = await createTestDatabase(5);
  org = await seedDemoOrg(db.pool);
}, 120_000);

afterAll(async () => {
  const audit = await verifyAuditChain(db.pool, org.organisationId);
  expect(audit.ok, JSON.stringify(audit.problems)).toBe(true);
  await db.drop();
});

describe('normalisePhone', () => {
  it('accepts international numbers in common spellings and returns strict E.164', () => {
    expect(normalisePhone('+447700900123')).toBe('+447700900123');
    expect(normalisePhone(' +44 (7700) 900-123 ')).toBe('+447700900123');
  });

  it('rejects national formats, short numbers and text', () => {
    for (const bad of ['07700900123', '447700900123', '+0447700900123', '+4477', 'sam', '']) expect(() => normalisePhone(bad)).toThrow(/E\.164/);
  });
});

describe('whatsapp:connect', () => {
  it('creates the connection once and is idempotent afterwards', async () => {
    const a = await connectWhatsApp(db.pool, org.organisationId, '106540352242922');
    const b = await connectWhatsApp(db.pool, org.organisationId, '106540352242922');
    expect(a.created).toBe(true);
    expect(b).toEqual({ id: a.id, created: false });
    expect((await db.pool.query(`SELECT count(*)::int AS n FROM channel_connections WHERE channel = 'whatsapp'`)).rows[0].n).toBe(1);
  });

  it('follows a changed phone number id instead of creating a second connection', async () => {
    const a = await connectWhatsApp(db.pool, org.organisationId, '106540352242922');
    const b = await connectWhatsApp(db.pool, org.organisationId, '106540352242999');
    expect(b.id).toBe(a.id);
    expect((await db.pool.query('SELECT address FROM channel_connections WHERE id = $1', [a.id])).rows[0].address).toBe('106540352242999');
    await connectWhatsApp(db.pool, org.organisationId, '106540352242922');
  });

  it('rejects a non-numeric phone number id', async () => {
    await expect(connectWhatsApp(db.pool, org.organisationId, 'abc')).rejects.toThrow(/numeric/);
  });
});

describe('whatsapp:link', () => {
  const EMAIL = 'sam.taylor@northwind.example';

  it('links a number as a labelled demo enrolment, audited, and is idempotent', async () => {
    const a = await linkWhatsAppNumber(db.pool, org.organisationId, EMAIL, '+44 7700 900123');
    expect(a).toMatchObject({ created: true, address: '+447700900123' });
    const row = (await db.pool.query('SELECT channel, channel_address, verification_method FROM channel_identities WHERE id = $1', [a.id])).rows[0];
    expect(row).toEqual({ channel: 'whatsapp', channel_address: '+447700900123', verification_method: 'demo_enrolment' });
    expect(await linkWhatsAppNumber(db.pool, org.organisationId, EMAIL.toUpperCase(), '+447700900123')).toMatchObject({ id: a.id, created: false });
    expect((await db.pool.query(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'channel_identity.linked'`)).rows[0].n).toBe(1);
  });

  it('refuses to move a number that belongs to another member, an unknown member, and a bad number', async () => {
    await expect(linkWhatsAppNumber(db.pool, org.organisationId, 'alex.morgan@northwind.example', '+447700900123')).rejects.toThrow(/already linked/);
    await expect(linkWhatsAppNumber(db.pool, org.organisationId, 'nobody@northwind.example', '+447700900555')).rejects.toThrow(/no member/);
    await expect(linkWhatsAppNumber(db.pool, org.organisationId, EMAIL, '07700900555')).rejects.toThrow(/E\.164/);
  });
});

describe('whatsapp:status', () => {
  it('reports the connection and linked numbers', async () => {
    const s = await whatsappStatus(db.pool, org.organisationId);
    expect(s.connection).toHaveLength(1);
    expect(s.linked).toEqual([{ channel_address: '+447700900123', email: 'sam.taylor@northwind.example', verification_method: 'demo_enrolment' }]);
    expect(s.inbound).toEqual([]);
    expect(s.outbound).toEqual([]);
  });
});
