import { createHash, randomBytes } from 'node:crypto';
import {
  exchangeCode,
  GMAIL_SCOPES,
  GmailApi,
  GmailApiError,
  googleAuthUrl,
  pkcePair,
  ReconnectRequiredError,
  refreshAccessToken,
  revokeToken,
  type Fetch,
  type GoogleOAuthConfig,
  type TokenSet,
} from '@swipeback/channels';
import { appendAudit, withTransaction, type Pool } from '@swipeback/db';
import type { SessionMember } from './auth.ts';
import type { EngineDeps } from './deps.ts';
import { receiveInbound } from './inbound.ts';
import { ReviewError } from './review.ts';
import type { TokenCipher } from './secrets.ts';

/**
 * Connected finance mailbox (Gmail). An admin connects the organisation's *designated* mailbox
 * with explicit consent; Swipeback then polls only that mailbox's inbox and replies in-thread.
 * Tokens are encrypted at rest; a revoked grant flips the connection to RECONNECT_REQUIRED.
 */

export interface GmailRuntime {
  oauth: GoogleOAuthConfig;
  cipher: TokenCipher;
  fetch: Fetch;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

// ---- token storage ------------------------------------------------------------------------

interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
}

export class GmailTokens {
  private readonly cache = new Map<string, { token: string; expiresAt: number }>();
  constructor(
    private readonly pool: Pool,
    private readonly g: GmailRuntime,
  ) {}

  async accessToken(connectionId: string, forceRefresh = false): Promise<string> {
    const cached = this.cache.get(connectionId);
    if (!forceRefresh && cached && cached.expiresAt - Date.now() > 60_000) return cached.token;
    const r = await this.pool.query<{ token_ciphertext: string | null; status: string; organisation_id: string }>(
      'SELECT token_ciphertext, status, organisation_id FROM channel_connections WHERE id = $1',
      [connectionId],
    );
    const row = r.rows[0];
    if (!row?.token_ciphertext || row.status !== 'ACTIVE') throw new ReconnectRequiredError('mailbox is not connected');
    const stored = JSON.parse(this.g.cipher.decrypt(row.token_ciphertext, connectionId)) as StoredTokens;
    if (!forceRefresh && Date.parse(stored.expiresAt) - Date.now() > 60_000) {
      this.cache.set(connectionId, { token: stored.accessToken, expiresAt: Date.parse(stored.expiresAt) });
      return stored.accessToken;
    }
    try {
      const fresh = await refreshAccessToken(this.g.fetch, this.g.oauth, stored.refreshToken);
      await this.save(connectionId, { accessToken: fresh.accessToken, refreshToken: fresh.refreshToken ?? stored.refreshToken, expiresAt: fresh.expiresAt.toISOString() });
      this.cache.set(connectionId, { token: fresh.accessToken, expiresAt: fresh.expiresAt.getTime() });
      return fresh.accessToken;
    } catch (err) {
      if (err instanceof ReconnectRequiredError) await markReconnectRequired(this.pool, connectionId, row.organisation_id, err.message);
      throw err;
    }
  }

  async save(connectionId: string, t: StoredTokens): Promise<void> {
    await this.pool.query(
      'UPDATE channel_connections SET token_ciphertext = $2, token_key_id = $3, access_expires_at = $4, updated_at = clock_timestamp() WHERE id = $1',
      [connectionId, this.g.cipher.encrypt(JSON.stringify(t), connectionId), this.g.cipher.keyId, t.expiresAt],
    );
  }

  api(connectionId: string): GmailApi {
    return new GmailApi((force) => this.accessToken(connectionId, force), this.g.fetch);
  }
}

async function markReconnectRequired(pool: Pool, connectionId: string, organisationId: string, reason: string): Promise<void> {
  const r = await pool.query(
    `UPDATE channel_connections SET status = 'RECONNECT_REQUIRED', last_error = $2, updated_at = clock_timestamp()
      WHERE id = $1 AND status = 'ACTIVE'`,
    [connectionId, reason.slice(0, 300)],
  );
  if (r.rowCount) {
    await appendAudit(pool, { organisationId, actorType: 'system', action: 'channel.reconnect_required', entityType: 'channel_connection', entityId: connectionId, after: { reason: reason.slice(0, 300) } });
  }
}

// ---- connect / disconnect -----------------------------------------------------------------

const isAdmin = (a: SessionMember) => a.roles.includes('admin');

/** Start consent: returns the Google URL. State and PKCE verifier stay server-side, single use. */
export async function startGmailConnect(deps: EngineDeps, g: GmailRuntime, actor: SessionMember): Promise<string> {
  if (!isAdmin(actor)) throw new ReviewError(403, 'Only an admin can connect the finance mailbox');
  const org = await deps.pool.query<{ designated_address: string | null }>('SELECT designated_address FROM organisations WHERE id = $1', [actor.organisationId]);
  const state = randomBytes(24).toString('base64url');
  const { verifier, challenge } = pkcePair();
  await deps.pool.query(
    `INSERT INTO oauth_states (organisation_id, member_id, provider, state_hash, verifier_encrypted, expires_at)
     VALUES ($1, $2, 'gmail', $3, $4, clock_timestamp() + interval '10 minutes')`,
    [actor.organisationId, actor.memberId, sha(state), g.cipher.encrypt(verifier, `oauth:${sha(state)}`)],
  );
  return googleAuthUrl(g.oauth, { state, codeChallenge: challenge, ...(org.rows[0]?.designated_address ? { loginHint: org.rows[0].designated_address } : {}) });
}

export type ConnectOutcome = { ok: true; address: string; connectionId: string } | { ok: false; reason: string };

/** Finish consent: verify state, exchange the code, and accept only the designated mailbox. */
export async function finishGmailConnect(deps: EngineDeps, g: GmailRuntime, actor: SessionMember, p: { code: string; state: string }): Promise<ConnectOutcome> {
  if (!isAdmin(actor)) return { ok: false, reason: 'Only an admin can connect the finance mailbox.' };
  const st = await deps.pool.query<{ verifier_encrypted: string }>(
    `UPDATE oauth_states SET consumed_at = clock_timestamp()
      WHERE state_hash = $1 AND member_id = $2 AND organisation_id = $3 AND consumed_at IS NULL AND expires_at > clock_timestamp()
      RETURNING verifier_encrypted`,
    [sha(p.state), actor.memberId, actor.organisationId],
  );
  if (!st.rows[0]) return { ok: false, reason: 'This connection attempt expired or was already used. Start again.' };
  const verifier = g.cipher.decrypt(st.rows[0].verifier_encrypted, `oauth:${sha(p.state)}`);

  let tokens: TokenSet;
  try {
    tokens = await exchangeCode(g.fetch, g.oauth, p.code, verifier);
  } catch (err) {
    return { ok: false, reason: `Google did not complete the connection (${(err as Error).message}).` };
  }
  const missing = GMAIL_SCOPES.filter((s) => !tokens.scopes.includes(s));
  if (missing.length) {
    await revokeToken(g.fetch, tokens.accessToken);
    return { ok: false, reason: `Swipeback needs permission to read and send for this mailbox; Google did not grant: ${missing.join(', ')}.` };
  }
  if (!tokens.refreshToken) return { ok: false, reason: 'Google did not return a refresh token; remove Swipeback from the account permissions and connect again.' };

  const profile = await new GmailApi(async () => tokens.accessToken, g.fetch).profile();
  const org = await deps.pool.query<{ designated_address: string | null }>('SELECT designated_address FROM organisations WHERE id = $1', [actor.organisationId]);
  const designated = org.rows[0]?.designated_address?.toLowerCase();
  if (!designated || profile.emailAddress.toLowerCase() !== designated) {
    // Never ingest someone's personal inbox by mistake: only the designated finance mailbox is accepted.
    await revokeToken(g.fetch, tokens.refreshToken);
    return { ok: false, reason: `You signed in as ${profile.emailAddress}, but this workspace's finance mailbox is ${designated ?? '(not set)'}. Nothing was connected.` };
  }

  const connectionId = await withTransaction(deps.pool, async (c) => {
    const existing = await c.query<{ id: string }>(
      `SELECT id FROM channel_connections WHERE organisation_id = $1 AND channel = 'email' AND provider = 'gmail' AND address = $2 ORDER BY created_at DESC LIMIT 1`,
      [actor.organisationId, designated],
    );
    const id =
      existing.rows[0]?.id ??
      (
        await c.query<{ id: string }>(
          `INSERT INTO channel_connections (organisation_id, channel, provider, address, status) VALUES ($1, 'email', 'gmail', $2, 'PENDING') RETURNING id`,
          [actor.organisationId, designated],
        )
      ).rows[0]!.id;
    // Other email transports (e.g. the offline fixture) stop being the organisation's mailbox.
    await c.query(
      `UPDATE channel_connections SET status = 'DISCONNECTED', updated_at = clock_timestamp()
        WHERE organisation_id = $1 AND channel = 'email' AND id <> $2 AND status <> 'DISCONNECTED'`,
      [actor.organisationId, id],
    );
    const sealed = g.cipher.encrypt(JSON.stringify({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken!, expiresAt: tokens.expiresAt.toISOString() } satisfies StoredTokens), id);
    await c.query(
      `UPDATE channel_connections SET status = 'ACTIVE', scopes = $2, token_ciphertext = $3, token_key_id = $4, access_expires_at = $5,
              cursor = $6, consented_by = $7, consented_at = clock_timestamp(), last_error = NULL, updated_at = clock_timestamp()
        WHERE id = $1`,
      [id, tokens.scopes, sealed, g.cipher.keyId, tokens.expiresAt, profile.historyId, actor.memberId],
    );
    await appendAudit(c, {
      organisationId: actor.organisationId, actorType: 'member', actorId: actor.memberId, action: 'channel.connected', entityType: 'channel_connection', entityId: id,
      after: { provider: 'gmail', address: designated, scopes: tokens.scopes, startHistoryId: profile.historyId },
    });
    return id;
  });
  return { ok: true, address: designated, connectionId };
}

export async function disconnectGmail(deps: EngineDeps, g: GmailRuntime, actor: SessionMember): Promise<void> {
  if (!isAdmin(actor)) throw new ReviewError(403, 'Only an admin can disconnect the finance mailbox');
  const r = await deps.pool.query<{ id: string; token_ciphertext: string | null }>(
    `SELECT id, token_ciphertext FROM channel_connections WHERE organisation_id = $1 AND provider = 'gmail' AND status <> 'DISCONNECTED'`,
    [actor.organisationId],
  );
  for (const row of r.rows) {
    if (row.token_ciphertext) {
      try {
        const t = JSON.parse(g.cipher.decrypt(row.token_ciphertext, row.id)) as StoredTokens;
        await revokeToken(g.fetch, t.refreshToken);
      } catch {
        // already unusable: still disconnect locally
      }
    }
    await deps.pool.query(`UPDATE channel_connections SET status = 'DISCONNECTED', token_ciphertext = NULL, updated_at = clock_timestamp() WHERE id = $1`, [row.id]);
    await appendAudit(deps.pool, { organisationId: actor.organisationId, actorType: 'member', actorId: actor.memberId, action: 'channel.disconnected', entityType: 'channel_connection', entityId: row.id });
  }
}

export async function mailboxStatus(deps: Pick<EngineDeps, 'pool'>, organisationId: string) {
  const r = await deps.pool.query<{ id: string; provider: string; address: string; status: string; scopes: string[]; last_sync_at: Date | null; last_error: string | null; consented_at: Date | null }>(
    `SELECT id, provider, address, status, scopes, last_sync_at, last_error, consented_at FROM channel_connections
      WHERE organisation_id = $1 AND channel = 'email' AND status <> 'DISCONNECTED' ORDER BY created_at DESC`,
    [organisationId],
  );
  const designated = await deps.pool.query<{ designated_address: string | null }>('SELECT designated_address FROM organisations WHERE id = $1', [organisationId]);
  return { designatedAddress: designated.rows[0]?.designated_address ?? null, connections: r.rows };
}

// ---- polling ------------------------------------------------------------------------------

export interface PollResult {
  fetched: number;
  accepted: number;
  skipped: number;
  resynced: boolean;
  status: 'OK' | 'RECONNECT_REQUIRED' | 'BUSY' | 'NOT_ACTIVE';
}

const POLL_LOCK = 7_342_100;

/**
 * Pull new inbox messages since the stored history cursor and hand each to the shared intake.
 * Idempotent end to end: the cursor only advances after messages are ingested, and every message
 * is deduplicated by its Gmail id, so a crash or overlap can repeat work but never duplicate it.
 */
export async function pollGmailConnection(deps: EngineDeps, tokens: GmailTokens, connectionId: string): Promise<PollResult> {
  const lockClient = await deps.pool.connect();
  const result: PollResult = { fetched: 0, accepted: 0, skipped: 0, resynced: false, status: 'OK' };
  try {
    const lock = await lockClient.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1, hashtext($2)) AS ok', [POLL_LOCK, connectionId]);
    if (!lock.rows[0]!.ok) return { ...result, status: 'BUSY' };
    const conn = await deps.pool.query<{ status: string; cursor: string | null; organisation_id: string }>('SELECT status, cursor, organisation_id FROM channel_connections WHERE id = $1', [connectionId]);
    if (conn.rows[0]?.status !== 'ACTIVE') return { ...result, status: 'NOT_ACTIVE' };
    const gmail = tokens.api(connectionId);

    const ingest = async (m: { id: string; threadId: string }) => {
      result.fetched++;
      const msg = await gmail.getRaw(m.id);
      // Only mail that arrived in the inbox; never our own sent copies or drafts.
      if (!msg.labelIds.includes('INBOX') || msg.labelIds.includes('SENT') || msg.labelIds.includes('DRAFT')) {
        result.skipped++;
        return;
      }
      const r = await receiveInbound(deps, connectionId, { body: msg.raw, headers: {}, providerMessageId: msg.id, providerThreadId: msg.threadId });
      if (r.status === 'ACCEPTED' && !r.duplicate) result.accepted++;
      else result.skipped++; // duplicate, not addressed to the mailbox, or rejected
    };

    try {
      let cursor = conn.rows[0].cursor;
      if (!cursor) cursor = (await gmail.profile()).historyId;
      let pageToken: string | undefined;
      let latest = cursor;
      try {
        do {
          const page = await gmail.history(cursor, pageToken);
          for (const m of page.messageIds) await ingest(m);
          latest = page.historyId;
          pageToken = page.nextPageToken ?? undefined;
        } while (pageToken);
      } catch (err) {
        if (!(err instanceof GmailApiError && err.status === 404)) throw err;
        // History cursor too old: bounded resync of recent inbox mail (dedupe makes this safe).
        result.resynced = true;
        for (const m of await gmail.listRecent('in:inbox newer_than:2d', 50)) await ingest(m);
        latest = (await gmail.profile()).historyId;
      }
      await deps.pool.query('UPDATE channel_connections SET cursor = $2, last_sync_at = clock_timestamp(), last_error = NULL WHERE id = $1', [connectionId, latest]);
      return result;
    } catch (err) {
      if (err instanceof ReconnectRequiredError) return { ...result, status: 'RECONNECT_REQUIRED' };
      await deps.pool.query('UPDATE channel_connections SET last_error = $2 WHERE id = $1', [connectionId, (err as Error).message.slice(0, 300)]);
      throw err;
    }
  } finally {
    await lockClient.query('SELECT pg_advisory_unlock($1, hashtext($2))', [POLL_LOCK, connectionId]).catch(() => undefined);
    lockClient.release();
  }
}

export async function activeGmailConnections(pool: Pool): Promise<string[]> {
  return (await pool.query<{ id: string }>(`SELECT id FROM channel_connections WHERE provider = 'gmail' AND status = 'ACTIVE'`)).rows.map((r) => r.id);
}
