import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyAuditChain } from '@swipeback/db';
import { TokenCipher } from '@swipeback/engine';
import { createTestDatabase, type TestDatabase } from '../../../test/support/db.ts';
import { resetDemo } from '../src/demo.ts';
import { seedDemoOrg } from '../src/seed.ts';

const FINANCE = 'swipeback.finance@example.com';

describe('demo:reset', () => {
  let db: TestDatabase;
  let dataDir: string;
  beforeAll(async () => {
    db = await createTestDatabase(4);
    dataDir = await mkdtemp(path.join(tmpdir(), 'sb-demo-'));
  });
  afterAll(async () => {
    await db?.drop();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('wipes demo data and keeps the consented Gmail mailbox usable, in well under 10 s', async () => {
    const cipher = new TokenCipher(randomBytes(32).toString('base64'));
    const org = await seedDemoOrg(db.pool, { financeMailbox: FINANCE });
    const conn = await db.pool.query<{ id: string }>(
      `INSERT INTO channel_connections (organisation_id, channel, provider, address, scopes, status, cursor, consented_by, consented_at)
       VALUES ($1, 'email', 'gmail', $2, $3, 'ACTIVE', 'history-981', $4, now()) RETURNING id`,
      [org.organisationId, FINANCE, ['gmail.readonly', 'gmail.send'], org.members.controller],
    );
    const id = conn.rows[0]!.id;
    await db.pool.query('UPDATE channel_connections SET token_ciphertext = $2 WHERE id = $1', [id, cipher.encrypt('{"refreshToken":"r-1"}', id)]);
    await db.pool.query(
      `INSERT INTO channel_connections (organisation_id, channel, provider, address, status) VALUES ($1, 'email', 'gmail', 'someone.else@example.com', 'PENDING')`,
      [org.organisationId],
    );
    await mkdir(path.join(dataDir, 'outbox'), { recursive: true });
    await writeFile(path.join(dataDir, 'outbox', 'old.eml'), 'x');

    const r = await resetDemo(db.pool, { financeMailbox: FINANCE, dataDir });

    expect(r.ms).toBeLessThan(10_000);
    expect(r.organisationId).not.toBe(org.organisationId);
    expect(r.keptMailboxes).toEqual([FINANCE]);
    const rows = await db.pool.query<{ id: string; organisation_id: string; cursor: string; token_ciphertext: string; status: string }>('SELECT * FROM channel_connections');
    expect(rows.rows).toHaveLength(1);
    const kept = rows.rows[0]!;
    expect(kept).toMatchObject({ id, organisation_id: r.organisationId, cursor: 'history-981', status: 'ACTIVE' });
    expect(cipher.decrypt(kept.token_ciphertext, kept.id)).toBe('{"refreshToken":"r-1"}');
    expect((await db.pool.query('SELECT 1 FROM expenses')).rowCount).toBe(0);
    expect((await db.pool.query('SELECT 1 FROM organisations')).rowCount).toBe(1);
    expect((await verifyAuditChain(db.pool, r.organisationId)).ok).toBe(true);
    expect(await readdir(dataDir)).toEqual([]);
  });

  it('works on an empty database and with no mailbox to keep', async () => {
    const r = await resetDemo(db.pool, {});
    expect(r.keptMailboxes).toEqual([]);
    expect((await db.pool.query('SELECT 1 FROM channel_connections')).rowCount).toBe(0);
  });
});
