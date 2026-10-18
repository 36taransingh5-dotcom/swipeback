import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '@swipeback/web';
import { createHarness, type Harness } from '../../../packages/engine/test/harness.ts';

let h: Harness;
let app: ReturnType<typeof createApp>;
const email = 'new.person@example.com';

beforeAll(async () => {
  h = await createHarness();
  app = createApp(h.deps, { secureCookies: false, signupSenderConnectionId: h.emailConnectionId });
});
afterAll(async () => { await h.close(); });

const request = (path: string, init: RequestInit = {}) => app.request(`http://localhost:3000${path}`, init);

describe('email-first onboarding', () => {
  it('shows email and channels in the same flow, then creates a verified preview workspace', async () => {
    const start = await request('/start');
    expect(start.status).toBe(200);
    const html = await start.text();
    expect(html).toContain('Continue with email');
    expect(html).toContain('Connect Slack');
    expect(html).toContain('Connect iMessage');

    const sent = await request('/start', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email }) });
    expect(sent.status).toBe(200);
    expect(await sent.text()).toContain('Check your inbox');
    expect((await h.db.pool.query('SELECT count(*)::int AS n FROM organisations')).rows[0].n).toBe(1);

    const message = h.sentTo(email).at(-1)!;
    const token = /\/start\/callback\?t=([\w-]+)/.exec(message.envelope.text)![1]!;
    const callback = await request(`/start/callback?t=${token}`);
    expect(callback.status).toBe(303);
    expect(callback.headers.get('location')).toBe('/start');
    const cookie = callback.headers.get('set-cookie')!.split(';')[0]!;
    const channels = await request('/start', { headers: { cookie } });
    expect(channels.status).toBe(200);
    expect(await channels.text()).toContain('new.person@example.com');

    const org = (await h.db.pool.query(`SELECT o.designated_address, p.rules FROM organisations o
      JOIN policy_versions p ON p.id = o.active_policy_version_id WHERE o.designated_address = $1`, [email])).rows[0];
    expect(org.designated_address).toBe(email);
    expect(org.rules.autoReimbursement.enabled).toBe(false);
    expect(org.rules.reviewAboveMinor.amountMinor).toBe(0);
    expect((await h.db.pool.query('SELECT count(*)::int AS n FROM organisations')).rows[0].n).toBe(2);
    expect((await request(`/start/callback?t=${token}`)).status).toBe(401);
  });

  it('does not claim to send a link when the signup mailbox is unavailable', async () => {
    const unavailable = createApp(h.deps, { secureCookies: false });
    const response = await unavailable.request('http://localhost:3000/start', { method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email: 'other@example.com' }) });
    expect(response.status).toBe(503);
    expect(await response.text()).toContain('Email is unavailable');
  });
});
