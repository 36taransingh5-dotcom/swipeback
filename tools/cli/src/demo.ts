import { rm } from 'node:fs/promises';
import path from 'node:path';
import { appendAudit, migrate, resetSchema, withTransaction, type Pool } from '@swipeback/db';
import { seedDemoOrg, type SeedOptions } from './seed.ts';

interface KeptConnection {
  id: string;
  provider: string;
  address: string;
  scopes: string[];
  token_ciphertext: string;
  token_key_id: string | null;
  cursor: string | null;
  consented_at: Date | null;
  access_expires_at: Date | null;
  last_sync_at: Date | null;
}

export interface DemoResetResult {
  organisationId: string;
  keptMailboxes: string[];
  ms: number;
}

/**
 * Wipe all demo data and re-seed, keeping a connected Gmail mailbox so the demo does not need a
 * new Google consent. The connection keeps its id (the token ciphertext is bound to it) and its
 * history cursor (mail received before the reset is not re-ingested). Local databases only.
 */
export async function resetDemo(pool: Pool, opts: SeedOptions & { dataDir?: string } = {}): Promise<DemoResetResult> {
  const started = Date.now();
  const kept = await pool
    .query<KeptConnection>(
      `SELECT c.id, c.provider, c.address, c.scopes, c.token_ciphertext, c.token_key_id, c.cursor, c.consented_at, c.access_expires_at, c.last_sync_at
         FROM channel_connections c
        WHERE c.channel = 'email' AND c.provider = 'gmail' AND c.status = 'ACTIVE' AND c.token_ciphertext IS NOT NULL`,
    )
    .then((r) => r.rows)
    .catch((err: { code?: string }) => {
      if (err.code === '42P01') return [];
      throw err;
    });

  await resetSchema(pool);
  await migrate(pool);
  const org = await seedDemoOrg(pool, opts);

  const keptMailboxes: string[] = [];
  await withTransaction(pool, async (c) => {
    const designated = (await c.query<{ designated_address: string }>('SELECT designated_address FROM organisations WHERE id = $1', [org.organisationId])).rows[0]!.designated_address;
    for (const k of kept) {
      // Only the mailbox the seeded organisation designates; anything else would need a fresh consent.
      if (k.address.toLowerCase() !== designated.toLowerCase()) continue;
      await c.query(
        `INSERT INTO channel_connections (id, organisation_id, channel, provider, address, scopes, token_ciphertext, token_key_id, status, cursor,
                                          consented_by, consented_at, access_expires_at, last_sync_at)
         VALUES ($1, $2, 'email', $3, $4, $5, $6, $7, 'ACTIVE', $8, $9, $10, $11, $12)`,
        [k.id, org.organisationId, k.provider, k.address, k.scopes, k.token_ciphertext, k.token_key_id, k.cursor, org.members.controller, k.consented_at, k.access_expires_at, k.last_sync_at],
      );
      await appendAudit(c, {
        organisationId: org.organisationId,
        actorType: 'system',
        actorId: 'demo:reset',
        action: 'channel.connection_kept',
        entityType: 'channel_connection',
        entityId: k.id,
        after: { provider: k.provider, address: k.address, scopes: k.scopes, reason: 'demo reset keeps the consented mailbox' },
      });
      keptMailboxes.push(k.address);
    }
  });

  if (opts.dataDir) {
    for (const dir of ['outbox', 'evidence']) await rm(path.join(opts.dataDir, dir), { recursive: true, force: true });
  }
  return { organisationId: org.organisationId, keptMailboxes, ms: Date.now() - started };
}
