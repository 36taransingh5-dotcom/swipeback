import { createHash, randomBytes } from 'node:crypto';
import { pkcePair } from '@swipeback/channels';
import { appendAudit, withTransaction, type Pool } from '@swipeback/db';
import { z } from 'zod';
import { receiveCardEvent, signCardEvent } from './card-feed.ts';
import type { SessionMember } from './auth.ts';
import type { EngineDeps } from './deps.ts';
import { ReviewError } from './review.ts';
import { TokenCipher } from './secrets.ts';

const AUTH_ORIGIN = 'https://auth.truelayer-sandbox.com';
const DATA_ORIGIN = 'https://api.truelayer-sandbox.com';
const PROVIDER = 'truelayer-sandbox';
const SCOPES = ['cards', 'transactions', 'offline_access'] as const;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

export interface TrueLayerSandboxRuntime {
  clientId: string;
  clientSecret: string;
  redirectUri: 'http://localhost:3000/callback';
  cipher: TokenCipher;
  fetch: typeof fetch;
}

/** This adapter cannot be enabled on a hosted or production app. */
export function trueLayerSandboxRuntimeFromEnv(env: NodeJS.ProcessEnv): TrueLayerSandboxRuntime | null {
  if (!env.TRUELAYER_CLIENT_SECRET) return null;
  if (env.SB_APP_URL !== 'http://localhost:3000' || env.NODE_ENV === 'production' || env.VERCEL) return null;
  if (!env.SB_TOKEN_ENCRYPTION_KEY) throw new Error('SB_TOKEN_ENCRYPTION_KEY is required for TrueLayer sandbox tokens');
  return {
    clientId: 'sandbox-swipeback-a13286', clientSecret: env.TRUELAYER_CLIENT_SECRET,
    redirectUri: 'http://localhost:3000/callback', cipher: new TokenCipher(env.SB_TOKEN_ENCRYPTION_KEY), fetch,
  };
}

const tokensSchema = z.object({
  access_token: z.string().min(1), refresh_token: z.string().min(1).optional(), expires_in: z.number().positive(),
  scope: z.string().optional(),
});
type StoredTokens = { accessToken: string; refreshToken: string; expiresAt: string };

const cardsSchema = z.object({ results: z.array(z.object({
  account_id: z.string().min(1), partial_card_number: z.string().regex(/^\d{4}$/),
})) });
const transactionsSchema = z.object({ results: z.array(z.object({
  transaction_id: z.string().min(1), normalised_provider_transaction_id: z.string().optional(),
  provider_transaction_id: z.string().optional(), timestamp: z.string().min(10),
  amount: z.number(), currency: z.string().regex(/^[A-Z]{3}$/),
  description: z.string().optional(), merchant_name: z.string().optional(),
  transaction_type: z.enum(['DEBIT', 'CREDIT']),
})) });

async function tokenRequest(t: TrueLayerSandboxRuntime, values: Record<string, string>) {
  const response = await t.fetch(`${AUTH_ORIGIN}/connect/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: t.clientId, client_secret: t.clientSecret, ...values }),
  });
  if (!response.ok) throw new Error(`TrueLayer sandbox token request failed (${response.status})`);
  return tokensSchema.parse(await response.json());
}

async function dataGet(t: TrueLayerSandboxRuntime, accessToken: string, path: string): Promise<unknown> {
  const response = await t.fetch(`${DATA_ORIGIN}${path}`, {
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`TrueLayer sandbox data request failed (${response.status})`);
  return response.json();
}

const admin = (actor: SessionMember) => actor.roles.includes('admin');

export async function startTrueLayerSandboxConnect(deps: EngineDeps, t: TrueLayerSandboxRuntime, actor: SessionMember): Promise<string> {
  if (!admin(actor)) throw new ReviewError(403, 'Only an admin can connect the sandbox card feed');
  const state = randomBytes(24).toString('base64url');
  const { verifier, challenge } = pkcePair();
  await deps.pool.query(
    `INSERT INTO oauth_states (organisation_id, member_id, provider, state_hash, verifier_encrypted, expires_at)
     VALUES ($1,$2,$3,$4,$5,clock_timestamp() + interval '10 minutes')`,
    [actor.organisationId, actor.memberId, PROVIDER, sha(state), t.cipher.encrypt(verifier, `oauth:${sha(state)}`)],
  );
  const url = new URL(AUTH_ORIGIN);
  url.search = new URLSearchParams({
    response_type: 'code', client_id: t.clientId, redirect_uri: t.redirectUri,
    scope: SCOPES.join(' '), state, code_challenge: challenge, code_challenge_method: 'S256',
    providers: 'uk-cs-mock',
  }).toString();
  return url.toString();
}

export type TrueLayerConnectOutcome = { ok: true; connectionId: string } | { ok: false; reason: string };

export async function finishTrueLayerSandboxConnect(
  deps: EngineDeps, t: TrueLayerSandboxRuntime, actor: SessionMember, p: { code: string; state: string },
): Promise<TrueLayerConnectOutcome> {
  if (!admin(actor)) return { ok: false, reason: 'Only an admin can connect the sandbox card feed.' };
  if (!p.code || !p.state) return { ok: false, reason: 'TrueLayer did not return a connection code and state.' };
  const stateHash = sha(p.state);
  const r = await deps.pool.query<{ verifier_encrypted: string }>(
    `UPDATE oauth_states SET consumed_at = clock_timestamp()
      WHERE provider = $1 AND state_hash = $2 AND organisation_id = $3 AND member_id = $4
        AND consumed_at IS NULL AND expires_at > clock_timestamp()
      RETURNING verifier_encrypted`,
    [PROVIDER, stateHash, actor.organisationId, actor.memberId],
  );
  if (!r.rows[0]) return { ok: false, reason: 'This sandbox connection attempt expired or was already used. Start again.' };
  const verifier = t.cipher.decrypt(r.rows[0].verifier_encrypted, `oauth:${stateHash}`);
  let result: z.infer<typeof tokensSchema>;
  try {
    result = await tokenRequest(t, { grant_type: 'authorization_code', code: p.code, redirect_uri: t.redirectUri, code_verifier: verifier });
  } catch {
    return { ok: false, reason: 'TrueLayer sandbox could not complete the connection. Start again.' };
  }
  if (result.scope && !SCOPES.every((scope) => result.scope!.split(' ').includes(scope))) {
    return { ok: false, reason: 'TrueLayer did not grant card transactions and ongoing access.' };
  }
  if (!result.refresh_token) return { ok: false, reason: 'TrueLayer did not grant ongoing access. Reconnect with offline access.' };
  const refreshToken = result.refresh_token;
  const expiresAt = new Date(Date.now() + result.expires_in * 1000).toISOString();
  const connectionId = await withTransaction(deps.pool, async (c) => {
    const existing = await c.query<{ id: string }>(
      `SELECT id FROM channel_connections WHERE organisation_id = $1 AND channel = 'card' AND provider = $2 AND status <> 'DISCONNECTED' FOR UPDATE`,
      [actor.organisationId, PROVIDER],
    );
    const id = existing.rows[0]?.id ?? (await c.query<{ id: string }>(
      `INSERT INTO channel_connections (organisation_id, channel, provider, address, status)
       VALUES ($1,'card',$2,'sandbox','PENDING') RETURNING id`, [actor.organisationId, PROVIDER],
    )).rows[0]!.id;
    const stored: StoredTokens = { accessToken: result.access_token, refreshToken, expiresAt };
    await c.query(
      `UPDATE channel_connections SET status = 'ACTIVE', scopes = $2, token_ciphertext = $3, token_key_id = $4,
         access_expires_at = $5, consented_by = $6, consented_at = clock_timestamp(), last_error = NULL, updated_at = clock_timestamp()
       WHERE id = $1`,
      [id, [...SCOPES], t.cipher.encrypt(JSON.stringify(stored), id), t.cipher.keyId, expiresAt, actor.memberId],
    );
    await appendAudit(c, { organisationId: actor.organisationId, actorType: 'member', actorId: actor.memberId,
      action: 'channel.connected', entityType: 'channel_connection', entityId: id,
      after: { provider: PROVIDER, sandbox: true, scopes: [...SCOPES] } });
    return id;
  });
  return { ok: true, connectionId };
}

export class TrueLayerSandboxTokens {
  constructor(private readonly pool: Pool, private readonly runtime: TrueLayerSandboxRuntime) {}

  async accessToken(connectionId: string): Promise<string> {
    const r = await this.pool.query<{ organisation_id: string; status: string; token_ciphertext: string | null }>(
      `SELECT organisation_id, status, token_ciphertext FROM channel_connections WHERE id = $1 AND provider = $2`,
      [connectionId, PROVIDER],
    );
    const row = r.rows[0];
    if (!row || row.status !== 'ACTIVE' || !row.token_ciphertext) throw new Error('Sandbox card feed is not connected');
    const stored = JSON.parse(this.runtime.cipher.decrypt(row.token_ciphertext, connectionId)) as StoredTokens;
    if (Date.parse(stored.expiresAt) - Date.now() > 60_000) return stored.accessToken;
    let fresh: z.infer<typeof tokensSchema>;
    try {
      fresh = await tokenRequest(this.runtime, { grant_type: 'refresh_token', refresh_token: stored.refreshToken });
    } catch (err) {
      if (/\(400\)|\(401\)/.test((err as Error).message)) {
        await this.pool.query(`UPDATE channel_connections SET status = 'RECONNECT_REQUIRED', last_error = 'Sandbox consent expired; reconnect the card feed', updated_at = clock_timestamp() WHERE id = $1`, [connectionId]);
        await appendAudit(this.pool, { organisationId: row.organisation_id, actorType: 'system', action: 'channel.reconnect_required', entityType: 'channel_connection', entityId: connectionId });
      }
      throw err;
    }
    const next: StoredTokens = {
      accessToken: fresh.access_token, refreshToken: fresh.refresh_token ?? stored.refreshToken,
      expiresAt: new Date(Date.now() + fresh.expires_in * 1000).toISOString(),
    };
    await this.pool.query(
      `UPDATE channel_connections SET token_ciphertext = $2, token_key_id = $3, access_expires_at = $4, updated_at = clock_timestamp() WHERE id = $1`,
      [connectionId, this.runtime.cipher.encrypt(JSON.stringify(next), connectionId), this.runtime.cipher.keyId, next.expiresAt],
    );
    return next.accessToken;
  }
}

export function mapTrueLayerCardTransaction(card: { account_id: string; partial_card_number: string }, input: z.infer<typeof transactionsSchema>['results'][number]) {
  if (input.transaction_type !== 'DEBIT' || input.amount <= 0) return null; // refunds and credits are not expenses
  const amountMinor = Math.round(input.amount * 100);
  if (!Number.isSafeInteger(amountMinor) || Math.abs(input.amount * 100 - amountMinor) > 0.00001) return null;
  const descriptor = (input.description || input.merchant_name || '').trim();
  if (!descriptor) return null;
  const timestamp = /(?:Z|[+-]\d\d:\d\d)$/.test(input.timestamp) ? input.timestamp : `${input.timestamp}Z`;
  if (Number.isNaN(Date.parse(timestamp))) return null;
  const stableId = input.normalised_provider_transaction_id || input.provider_transaction_id || input.transaction_id;
  return {
    provider: PROVIDER, transactionId: `tl-${sha(`${card.account_id}:${stableId}`)}`, cardLast4: card.partial_card_number,
    amountMinor, currency: input.currency, merchantDescriptor: descriptor.slice(0, 100),
    transactedAt: new Date(timestamp).toISOString(), synthetic: true,
  } as const;
}

export interface TrueLayerPollResult {
  status: 'OK' | 'BUSY' | 'NOT_ACTIVE'; cards: number; fetched: number; accepted: number; skipped: number; unknownCards: number;
}

const POLL_LOCK = 7_342_101;
export async function pollTrueLayerSandboxConnection(
  deps: EngineDeps, t: TrueLayerSandboxRuntime, tokens: TrueLayerSandboxTokens, connectionId: string,
): Promise<TrueLayerPollResult> {
  const lockClient = await deps.pool.connect();
  const result: TrueLayerPollResult = { status: 'OK', cards: 0, fetched: 0, accepted: 0, skipped: 0, unknownCards: 0 };
  let locked = false;
  try {
    locked = !!(await lockClient.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1, hashtext($2)) AS ok', [POLL_LOCK, connectionId])).rows[0]?.ok;
    if (!locked) return { ...result, status: 'BUSY' };
    const conn = await deps.pool.query<{ organisation_id: string; status: string }>(
      `SELECT organisation_id, status FROM channel_connections WHERE id = $1 AND provider = $2`, [connectionId, PROVIDER],
    );
    if (conn.rows[0]?.status !== 'ACTIVE') return { ...result, status: 'NOT_ACTIVE' };
    const organisationId = conn.rows[0].organisation_id;
    const accessToken = await tokens.accessToken(connectionId);
    const cards = cardsSchema.parse(await dataGet(t, accessToken, '/data/v1/cards')).results;
    result.cards = cards.length;
    const today = deps.clock.now();
    const from = new Date(today.getTime() - 89 * 86_400_000).toISOString().slice(0, 10);
    const to = today.toISOString().slice(0, 10);
    for (const card of cards) {
      const url = `/data/v1/cards/${encodeURIComponent(card.account_id)}/transactions?from=${from}&to=${to}`;
      const transactions = transactionsSchema.parse(await dataGet(t, accessToken, url)).results;
      for (const transaction of transactions) {
        result.fetched++;
        const event = mapTrueLayerCardTransaction(card, transaction);
        if (!event) { result.skipped++; continue; }
        const body = JSON.stringify(event);
        const outcome = await receiveCardEvent(deps, organisationId, body,
          signCardEvent(deps.config.cardFeedSecret, body, Math.floor(deps.clock.now().getTime() / 1000)));
        if (outcome.status === 'ACCEPTED' && !outcome.duplicate) result.accepted++;
        else if (outcome.status === 'REJECTED' && outcome.reason === 'UNKNOWN_CARD') result.unknownCards++;
        else result.skipped++;
      }
    }
    await deps.pool.query(`UPDATE channel_connections SET cursor = $2, last_sync_at = clock_timestamp(), last_error = NULL WHERE id = $1`,
      [connectionId, JSON.stringify(cards.map((card) => ({ last4: card.partial_card_number })))]);
    return result;
  } catch (err) {
    await deps.pool.query(`UPDATE channel_connections SET last_error = $2 WHERE id = $1`, [connectionId, (err as Error).message.slice(0, 300)]).catch(() => undefined);
    throw err;
  } finally {
    if (locked) await lockClient.query('SELECT pg_advisory_unlock($1, hashtext($2))', [POLL_LOCK, connectionId]).catch(() => undefined);
    lockClient.release();
  }
}

/** Background checks stay within the common four-unattended-calls-per-day provider limit. */
export async function dueTrueLayerSandboxConnections(pool: Pool, intervalSeconds = 28_800): Promise<string[]> {
  return (await pool.query<{ id: string }>(
    `SELECT id FROM channel_connections WHERE channel = 'card' AND provider = $1 AND status = 'ACTIVE'
       AND (last_sync_at IS NULL OR last_sync_at < clock_timestamp() - ($2::int * interval '1 second'))`,
    [PROVIDER, intervalSeconds],
  )).rows.map((row) => row.id);
}

export async function trueLayerSandboxStatus(pool: Pool, organisationId: string) {
  const row = (await pool.query<{ id: string; status: string; last_sync_at: Date | null; last_error: string | null; cursor: string | null }>(
    `SELECT id, status, last_sync_at, last_error, cursor FROM channel_connections
      WHERE organisation_id = $1 AND channel = 'card' AND provider = $2 AND status <> 'DISCONNECTED' ORDER BY created_at DESC LIMIT 1`,
    [organisationId, PROVIDER],
  )).rows[0];
  if (!row) return null;
  const listed = z.array(z.object({ last4: z.string().regex(/^\d{4}$/) })).catch([]).parse(JSON.parse(row.cursor || '[]'));
  const enrolled = await pool.query<{ last4: string; member_name: string }>(
    `SELECT c.last4, m.display_name AS member_name FROM cards c JOIN members m ON m.id = c.member_id
      WHERE c.organisation_id = $1 AND c.status = 'ACTIVE'`, [organisationId],
  );
  const byLast4 = new Map(enrolled.rows.map((card) => [card.last4, card.member_name]));
  return { id: row.id, status: row.status, last_sync_at: row.last_sync_at, last_error: row.last_error,
    cards: listed.map((card) => ({ last4: card.last4, enrolledTo: byLast4.get(card.last4) ?? null })) };
}

export async function trueLayerSandboxMembers(pool: Pool, organisationId: string) {
  return (await pool.query<{ id: string; name: string }>(
    `SELECT id, display_name AS name FROM members WHERE organisation_id = $1 AND 'employee' = ANY(roles) ORDER BY display_name`, [organisationId],
  )).rows;
}

export async function enrolTrueLayerSandboxCard(deps: EngineDeps, actor: SessionMember, p: { last4: string; memberId: string }): Promise<void> {
  if (!admin(actor)) throw new ReviewError(403, 'Only an admin can assign a sandbox card');
  if (!/^\d{4}$/.test(p.last4) || !/^[0-9a-f-]{36}$/.test(p.memberId)) throw new ReviewError(400, 'Choose a listed card and employee');
  await withTransaction(deps.pool, async (c) => {
    const connection = (await c.query<{ cursor: string | null }>(
      `SELECT cursor FROM channel_connections WHERE organisation_id = $1 AND channel = 'card' AND provider = $2 AND status = 'ACTIVE' FOR UPDATE`,
      [actor.organisationId, PROVIDER],
    )).rows[0];
    const listed = z.array(z.object({ last4: z.string() })).catch([]).parse(JSON.parse(connection?.cursor || '[]'));
    if (!listed.some((card) => card.last4 === p.last4)) throw new ReviewError(400, 'That card was not returned by the connected mock bank');
    const member = (await c.query<{ id: string }>(
      `SELECT id FROM members WHERE id = $1 AND organisation_id = $2 AND 'employee' = ANY(roles)`, [p.memberId, actor.organisationId],
    )).rows[0];
    if (!member) throw new ReviewError(400, 'Choose an employee in this organisation');
    const exists = (await c.query(`SELECT 1 FROM cards WHERE organisation_id = $1 AND last4 = $2 AND status = 'ACTIVE'`, [actor.organisationId, p.last4])).rowCount;
    if (exists) throw new ReviewError(409, 'This card is already assigned');
    const card = (await c.query<{ id: string }>(
      `INSERT INTO cards (organisation_id, member_id, last4, label, is_synthetic)
       VALUES ($1,$2,$3,'TrueLayer mock bank card (SANDBOX)',true) RETURNING id`,
      [actor.organisationId, p.memberId, p.last4],
    )).rows[0]!;
    await appendAudit(c, { organisationId: actor.organisationId, actorType: 'member', actorId: actor.memberId,
      action: 'card.sandbox_assigned', entityType: 'card', entityId: card.id,
      after: { last4: p.last4, memberId: p.memberId, provider: PROVIDER } });
  });
}
