import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyAuditChain } from '@swipeback/db';
import {
  dueTrueLayerSandboxConnections, enrolTrueLayerSandboxCard, finishTrueLayerSandboxConnect, loadCase, mapTrueLayerCardTransaction, pollTrueLayerSandboxConnection,
  receiveCardEvent, signCardEvent,
  startTrueLayerSandboxConnect, TokenCipher, TrueLayerSandboxTokens,
  trueLayerSandboxRuntimeFromEnv, trueLayerSandboxStatus, type SessionMember, type TrueLayerSandboxRuntime,
} from '@swipeback/engine';
import { casePage } from '../../../apps/web/src/views.ts';
import { createHarness, isoAt, type Harness } from './harness.ts';

let h: Harness;
let actor: SessionMember;
let runtime: TrueLayerSandboxRuntime;
let requests: string[];
let tokenExpiresIn: number;

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

beforeEach(async () => {
  h = await createHarness();
  const row = (await h.db.pool.query('SELECT id, organisation_id, email, display_name, roles FROM members WHERE id = $1', [h.org.members.controller])).rows[0];
  actor = { memberId: row.id, organisationId: row.organisation_id, email: row.email, displayName: row.display_name, roles: row.roles };
  requests = [];
  tokenExpiresIn = 3600;
  const mockFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push(url);
    if (url === 'https://auth.truelayer-sandbox.com/connect/token') {
      const form = new URLSearchParams(String(init?.body));
      expect(form.get('client_id')).toBe('sandbox-swipeback-a13286');
      expect(form.get('client_secret')).toBe('sandbox-test-secret');
      if (form.get('grant_type') === 'authorization_code') {
        expect(form.get('redirect_uri')).toBe('http://localhost:3000/callback');
        expect(form.get('code_verifier')).toMatch(/^[\w-]{43,128}$/);
      }
      return json({ access_token: 'mock-access-token', refresh_token: 'mock-refresh-token', expires_in: tokenExpiresIn,
        scope: 'cards transactions offline_access' });
    }
    expect(init?.headers).toMatchObject({ authorization: 'Bearer mock-access-token' });
    if (url === 'https://api.truelayer-sandbox.com/data/v1/cards') {
      return json({ results: [{ account_id: 'card-one', partial_card_number: '4242' }, { account_id: 'card-unknown', partial_card_number: '0044' }] });
    }
    if (url.includes('/cards/card-one/transactions')) {
      expect(url).toMatch(/\?from=\d{4}-\d\d-\d\d&to=\d{4}-\d\d-\d\d$/);
      return json({ results: [
        { transaction_id: 'variable-id', normalised_provider_transaction_id: 'stable-purchase', timestamp: isoAt(1),
          amount: 11.25, currency: 'GBP', description: 'PRET A MANGER LONDON GB', transaction_type: 'DEBIT' },
        { transaction_id: 'refund', timestamp: isoAt(1), amount: -3.5, currency: 'GBP', description: 'REFUND', transaction_type: 'CREDIT' },
      ] });
    }
    if (url.includes('/cards/card-unknown/transactions')) {
      return json({ results: [{ transaction_id: 'unknown-card', timestamp: isoAt(1), amount: 5, currency: 'GBP',
        description: 'MOCK CAFE', transaction_type: 'DEBIT' }] });
    }
    throw new Error(`Unexpected sandbox URL: ${url}`);
  });
  runtime = { clientId: 'sandbox-swipeback-a13286', clientSecret: 'sandbox-test-secret',
    redirectUri: 'http://localhost:3000/callback', cipher: new TokenCipher(randomBytes(32).toString('base64')), fetch: mockFetch as typeof fetch };
});

afterEach(async () => {
  expect((await verifyAuditChain(h.db.pool, h.org.organisationId)).ok).toBe(true);
  await h.close();
});

async function connect() {
  const auth = new URL(await startTrueLayerSandboxConnect(h.deps, runtime, actor));
  const state = auth.searchParams.get('state')!;
  const result = await finishTrueLayerSandboxConnect(h.deps, runtime, actor, { code: 'mock-code', state });
  expect(result.ok).toBe(true);
  return { auth, state, connectionId: (result as { connectionId: string }).connectionId };
}

describe('TrueLayer Data API sandbox card feed', () => {
  it('is strictly local and builds a sandbox-only auth link with PKCE and a single-use state', async () => {
    const env = { SB_APP_URL: 'http://localhost:3000', TRUELAYER_CLIENT_SECRET: 'test',
      SB_TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('base64') };
    expect(trueLayerSandboxRuntimeFromEnv(env)?.redirectUri).toBe('http://localhost:3000/callback');
    expect(trueLayerSandboxRuntimeFromEnv({ ...env, SB_APP_URL: 'https://swipeback-app.vercel.app' })).toBeNull();
    expect(trueLayerSandboxRuntimeFromEnv({ ...env, NODE_ENV: 'production' })).toBeNull();
    expect(trueLayerSandboxRuntimeFromEnv({ ...env, VERCEL: '1' })).toBeNull();

    const { auth, state } = await connect();
    expect(auth.origin).toBe('https://auth.truelayer-sandbox.com');
    expect(auth.searchParams.get('providers')).toBe('uk-cs-mock');
    expect(auth.searchParams.get('scope')).toBe('cards transactions offline_access');
    expect(auth.searchParams.get('code_challenge_method')).toBe('S256');
    expect(auth.searchParams.get('code_challenge')).toMatch(/^[\w-]{43}$/);
    expect(await finishTrueLayerSandboxConnect(h.deps, runtime, actor, { code: 'again', state })).toMatchObject({ ok: false });
    expect(await finishTrueLayerSandboxConnect(h.deps, runtime, actor, { code: 'forged', state: 'forged' })).toMatchObject({ ok: false });
    await expect(startTrueLayerSandboxConnect(h.deps, runtime, { ...actor, roles: ['reviewer'] })).rejects.toMatchObject({ status: 403 });
  });

  it('encrypts tokens, reads cards and settled debits, signs events for the existing intake, and deduplicates a second sync', async () => {
    const { connectionId } = await connect();
    const stored = (await h.db.pool.query('SELECT channel, provider, token_ciphertext, token_key_id FROM channel_connections WHERE id = $1', [connectionId])).rows[0];
    expect(stored).toMatchObject({ channel: 'card', provider: 'truelayer-sandbox', token_key_id: runtime.cipher.keyId });
    expect(stored.token_ciphertext).not.toContain('mock-access-token');
    expect(stored.token_ciphertext).not.toContain('mock-refresh-token');

    const tokens = new TrueLayerSandboxTokens(h.db.pool, runtime);
    expect(await dueTrueLayerSandboxConnections(h.db.pool)).toContain(connectionId);
    const first = await pollTrueLayerSandboxConnection(h.deps, runtime, tokens, connectionId);
    expect(first).toMatchObject({ status: 'OK', cards: 2, fetched: 3, accepted: 1, skipped: 1, unknownCards: 1 });
    const txn = (await h.db.pool.query('SELECT provider, provider_transaction_id, amount_minor, feed_event, is_synthetic FROM transactions')).rows[0];
    expect(txn.provider).toBe('truelayer-sandbox');
    expect(txn.provider_transaction_id).toMatch(/^tl-[a-f0-9]{64}$/);
    expect(txn.amount_minor).toBe(1125);
    expect(txn.feed_event).toMatchObject({ provider: 'truelayer-sandbox', synthetic: true });
    expect(txn.is_synthetic).toBe(true);
    expect(await dueTrueLayerSandboxConnections(h.db.pool)).not.toContain(connectionId);
    expect(await pollTrueLayerSandboxConnection(h.deps, runtime, tokens, connectionId)).toMatchObject({ accepted: 0, skipped: 2, unknownCards: 1 });
    expect((await h.db.pool.query('SELECT count(*)::int AS n FROM transactions')).rows[0].n).toBe(1);

    await h.drain();
    const expense = (await h.expenses())[0]!;
    expect(expense).toMatchObject({ payment_type: 'CORPORATE', state: 'NEEDS_MATCH' });
    const view = await loadCase(h.deps, actor, expense.id);
    expect(view.expense.matchedTransaction?.sandbox).toBe(true);
    expect(String(await casePage(view, { actor, review: null, payment: null }))).toContain('Sandbox');
    expect((await h.db.pool.query(`SELECT count(*)::int AS n FROM jobs WHERE kind = 'receipt-chase'`)).rows[0].n).toBe(1);

    // The simulator remains a separate provider at the same signed intake door.
    expect((await h.card({ transactionId: 'card-sim-still-works' })).status).toBe('ACCEPTED');
    expect((await h.db.pool.query(`SELECT count(*)::int AS n FROM transactions WHERE provider = 'card-sim'`)).rows[0].n).toBe(1);
    expect(requests.every((url) => url.includes('truelayer-sandbox.com'))).toBe(true);
  });

  it('refreshes the encrypted access token before reading card data', async () => {
    tokenExpiresIn = 1;
    const { connectionId } = await connect();
    const tokens = new TrueLayerSandboxTokens(h.db.pool, runtime);
    expect(await tokens.accessToken(connectionId)).toBe('mock-access-token');
    expect(requests.filter((url) => url.endsWith('/connect/token'))).toHaveLength(2);
  });

  it('lets an admin assign only a returned mock card to an employee, then imports its purchases', async () => {
    const { connectionId } = await connect();
    const tokens = new TrueLayerSandboxTokens(h.db.pool, runtime);
    await pollTrueLayerSandboxConnection(h.deps, runtime, tokens, connectionId);
    expect((await trueLayerSandboxStatus(h.db.pool, actor.organisationId))?.cards).toContainEqual({ last4: '0044', enrolledTo: null });
    await expect(enrolTrueLayerSandboxCard(h.deps, { ...actor, roles: ['reviewer'] }, { last4: '0044', memberId: h.org.members.employee })).rejects.toMatchObject({ status: 403 });
    await expect(enrolTrueLayerSandboxCard(h.deps, actor, { last4: '5555', memberId: h.org.members.employee })).rejects.toMatchObject({ status: 400 });
    await enrolTrueLayerSandboxCard(h.deps, actor, { last4: '0044', memberId: h.org.members.employee });
    expect((await trueLayerSandboxStatus(h.db.pool, actor.organisationId))?.cards.find((card) => card.last4 === '0044')?.enrolledTo).toMatch(/Sam Taylor/);
    expect(await pollTrueLayerSandboxConnection(h.deps, runtime, tokens, connectionId)).toMatchObject({ accepted: 1, unknownCards: 0 });
    expect((await h.db.pool.query(`SELECT count(*)::int AS n FROM transactions WHERE provider = 'truelayer-sandbox'`)).rows[0].n).toBe(2);
  });

  it('maps only valid purchases and keeps the stable provider id across changing response ids', () => {
    const card = { account_id: 'card-one', partial_card_number: '4242' };
    const input = { transaction_id: 'first', normalised_provider_transaction_id: 'stable', timestamp: isoAt(1),
      amount: 12.34, currency: 'GBP', description: 'MOCK SHOP', transaction_type: 'DEBIT' as const };
    expect(mapTrueLayerCardTransaction(card, input)?.transactionId).toBe(mapTrueLayerCardTransaction(card, { ...input, transaction_id: 'changed' })?.transactionId);
    expect(mapTrueLayerCardTransaction(card, { ...input, transaction_type: 'CREDIT' })).toBeNull();
    expect(mapTrueLayerCardTransaction(card, { ...input, amount: 1.234 })).toBeNull();
  });

  it('rejects even a signed sandbox event at the hosted card-event door', async () => {
    const event = mapTrueLayerCardTransaction({ account_id: 'card-one', partial_card_number: '4242' },
      { transaction_id: 'hosted', timestamp: isoAt(1), amount: 12.34, currency: 'GBP', description: 'MOCK SHOP', transaction_type: 'DEBIT' })!;
    const body = JSON.stringify(event);
    h.deps.config.appUrl = 'https://swipeback-app.vercel.app';
    const signature = signCardEvent(h.deps.config.cardFeedSecret, body, Math.floor(Date.now() / 1000));
    expect(await receiveCardEvent(h.deps, h.org.organisationId, body, signature)).toEqual({ status: 'REJECTED', reason: 'MALFORMED' });
  });
});
