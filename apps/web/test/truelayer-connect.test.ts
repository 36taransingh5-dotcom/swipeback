import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TokenCipher, TrueLayerSandboxTokens, type TrueLayerSandboxRuntime } from '@swipeback/engine';
import { createApp } from '@swipeback/web';
import { createHarness, isoAt, type Harness } from '../../../packages/engine/test/harness.ts';

let h: Harness;
let app: ReturnType<typeof createApp>;
let cookie: string;

beforeAll(async () => {
  h = await createHarness();
  const sessionToken = randomBytes(32).toString('base64url');
  await h.db.pool.query(
    `INSERT INTO sessions (member_id, token_hash, expires_at) VALUES ($1,$2,clock_timestamp() + interval '1 hour')`,
    [h.org.members.controller, createHash('sha256').update(sessionToken).digest('hex')],
  );
  cookie = `sb_session=${sessionToken}`;
  const sandboxFetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === 'https://auth.truelayer-sandbox.com/connect/token') {
      expect(new URLSearchParams(String(init?.body)).get('code')).toBe('test-code');
      return Response.json({ access_token: 'web-test-token', refresh_token: 'web-test-refresh', expires_in: 3600,
        scope: 'cards transactions offline_access' });
    }
    if (url === 'https://api.truelayer-sandbox.com/data/v1/cards') {
      return Response.json({ results: [{ account_id: 'mock-card', partial_card_number: '0044' }] });
    }
    if (url.includes('/cards/mock-card/transactions')) {
      return Response.json({ results: [{ transaction_id: 'web-purchase', timestamp: isoAt(1), amount: 8.4,
        currency: 'GBP', description: 'MOCK CAFE', transaction_type: 'DEBIT' }] });
    }
    throw new Error(`Unexpected sandbox URL ${url}`);
  };
  const runtime: TrueLayerSandboxRuntime = { clientId: 'sandbox-swipeback-a13286', clientSecret: 'test',
    redirectUri: 'http://localhost:3000/callback', cipher: new TokenCipher(randomBytes(32).toString('base64')),
    fetch: sandboxFetch as typeof fetch };
  app = createApp(h.deps, { secureCookies: false, truelayer: { ...runtime, tokens: new TrueLayerSandboxTokens(h.db.pool, runtime) } });
});

afterAll(async () => { await h.close(); });

const request = (path: string, init: RequestInit = {}) => app.request(`http://localhost:3000${path}`, {
  ...init, headers: { cookie, ...init.headers },
});

describe('local sandbox connect routes', () => {
  it('connects via the auth link and callback, then assigns a mock card and syncs its purchase', async () => {
    const page = await request('/connect');
    expect(await page.text()).toContain('TrueLayer sandbox');

    const started = await request('/connect/truelayer', { method: 'POST' });
    expect(started.status).toBe(303);
    const auth = new URL(started.headers.get('location')!);
    expect(auth.origin).toBe('https://auth.truelayer-sandbox.com');
    expect(auth.searchParams.get('redirect_uri')).toBe('http://localhost:3000/callback');
    const done = await request(`/callback?code=test-code&state=${auth.searchParams.get('state')}`);
    expect(done.status).toBe(303);
    expect(done.headers.get('location')).toContain('card-connected=1');
    expect((await h.db.pool.query('SELECT count(*)::int AS n FROM transactions')).rows[0].n).toBe(0); // unknown card

    const connected = await request('/connect');
    expect(await connected.text()).toContain('Card ••0044');
    const assigned = await request('/connect/truelayer/card', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ last4: '0044', memberId: h.org.members.employee }),
    });
    expect(assigned.status).toBe(303);
    const synced = await request('/connect/truelayer/sync', { method: 'POST' });
    expect(synced.status).toBe(303);
    expect((await h.db.pool.query('SELECT count(*)::int AS n FROM transactions WHERE provider = $1', ['truelayer-sandbox'])).rows[0].n).toBe(1);
  });
});
