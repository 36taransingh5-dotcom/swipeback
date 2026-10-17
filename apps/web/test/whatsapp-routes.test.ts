import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { WHATSAPP_SIGNATURE_HEADER, WhatsAppCloudAdapter, WhatsAppGraphError, signWhatsAppBody, type WhatsAppGraphClient } from '@swipeback/channels';
import { channelRegistry, type EngineDeps } from '@swipeback/engine';
import { createApp } from '@swipeback/web';
import { createHarness, type Harness } from '../../../packages/engine/test/harness.ts';

/** The Meta webhook endpoints: verification handshake and signed POST delivery. */

const APP_SECRET = 'whatsapp-app-secret-for-tests-0123';
const VERIFY_TOKEN = 'verify-token-chosen-by-us';
const PHONE_NUMBER_ID = '106540352242922';

const graph: WhatsAppGraphClient & { mediaError: Error | null } = {
  mediaError: null,
  async downloadMedia() {
    if (this.mediaError) throw this.mediaError;
    return { bytes: Buffer.from('Trainline receipt'), mimeType: 'text/plain', sha256: null };
  },
  async sendText() {
    return { messageId: 'wamid.OUT1' };
  },
};

let h: Harness;
let app: ReturnType<typeof createApp>;
let connectionId: string;

beforeAll(async () => {
  vi.stubEnv('SB_WHATSAPP_VERIFY_TOKEN', VERIFY_TOKEN);
  h = await createHarness();
  const deps: EngineDeps = { ...h.deps, channels: channelRegistry([new WhatsAppCloudAdapter(h.deps.evidence, graph, APP_SECRET)]) };
  connectionId = (
    await h.db.pool.query<{ id: string }>(
      `INSERT INTO channel_connections (organisation_id, channel, provider, address, scopes, status, consented_by, consented_at)
       VALUES ($1, 'whatsapp', 'whatsapp-cloud', $2, $3, 'ACTIVE', $4, now()) RETURNING id`,
      [h.org.organisationId, PHONE_NUMBER_ID, ['whatsapp:messages'], h.org.members.controller],
    )
  ).rows[0]!.id;
  app = createApp(deps, { secureCookies: false });
}, 120_000);

afterAll(async () => {
  vi.unstubAllEnvs();
  await h?.close();
});

const handshake = (q: Record<string, string>, id = connectionId) => app.request(`/api/whatsapp/${id}?${new URLSearchParams(q)}`);
const inboundCount = async () => (await h.db.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM inbound_messages')).rows[0]!.n;

function webhook(opts: { type?: 'text' | 'document'; from?: string } = {}): Buffer {
  const message =
    opts.type === 'document'
      ? { from: opts.from ?? '447700900123', id: `wamid.${randomUUID()}`, timestamp: '1792230000', type: 'document', document: { id: 'media-1', mime_type: 'text/plain', filename: 'r.txt' } }
      : { from: opts.from ?? '447700900123', id: `wamid.${randomUUID()}`, timestamp: '1792230000', type: 'text', text: { body: 'hello' } };
  return Buffer.from(
    JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [{ id: 'waba', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: PHONE_NUMBER_ID, display_phone_number: '15550000000' }, messages: [message] } }] }],
    }),
  );
}
const post = (body: Buffer, secret = APP_SECRET, id = connectionId) =>
  app.request(`/api/whatsapp/${id}`, { method: 'POST', body, headers: { 'content-type': 'application/json', [WHATSAPP_SIGNATURE_HEADER]: signWhatsAppBody(secret, body) } });

describe('GET /api/whatsapp/:connectionId (verification handshake)', () => {
  it('echoes the challenge as plain text when the verify token matches', async () => {
    const res = await handshake({ 'hub.mode': 'subscribe', 'hub.verify_token': VERIFY_TOKEN, 'hub.challenge': '1158201444' });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('1158201444');
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('refuses a wrong token, a wrong mode, a missing challenge and an unset server token', async () => {
    expect((await handshake({ 'hub.mode': 'subscribe', 'hub.verify_token': 'nope', 'hub.challenge': '1' })).status).toBe(403);
    expect((await handshake({ 'hub.mode': 'unsubscribe', 'hub.verify_token': VERIFY_TOKEN, 'hub.challenge': '1' })).status).toBe(403);
    expect((await handshake({ 'hub.mode': 'subscribe', 'hub.verify_token': VERIFY_TOKEN })).status).toBe(403);
    vi.stubEnv('SB_WHATSAPP_VERIFY_TOKEN', '');
    expect((await handshake({ 'hub.mode': 'subscribe', 'hub.verify_token': '', 'hub.challenge': '1' })).status).toBe(403);
    vi.stubEnv('SB_WHATSAPP_VERIFY_TOKEN', VERIFY_TOKEN);
  });

  it('answers 404 for an unknown connection or a malformed id', async () => {
    const q = { 'hub.mode': 'subscribe', 'hub.verify_token': VERIFY_TOKEN, 'hub.challenge': '1' };
    expect((await handshake(q, randomUUID())).status).toBe(404);
    expect((await handshake(q, 'not-a-uuid')).status).toBe(404);
  });
});

describe('POST /api/whatsapp/:connectionId', () => {
  it('rejects a bad signature with 401 and ingests nothing', async () => {
    const before = await inboundCount();
    const res = await post(webhook(), 'another-secret-0123456789');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ status: 'REJECTED', reason: 'BAD_SIGNATURE' });
    expect(await inboundCount()).toBe(before);
  });

  it('rejects an unsigned request with 401', async () => {
    const res = await app.request(`/api/whatsapp/${connectionId}`, { method: 'POST', body: webhook() });
    expect(res.status).toBe(401);
  });

  it('accepts a correctly signed webhook with a fast 200 and records it once', async () => {
    const before = await inboundCount();
    const body = webhook();
    const res = await post(body);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'PROCESSED', accepted: 1, duplicates: 0, ignored: 0, rejected: 0 });
    expect(await inboundCount()).toBe(before + 1);
    expect(await (await post(body)).json()).toMatchObject({ accepted: 0, duplicates: 1 });
    expect(await inboundCount()).toBe(before + 1);
  });

  it('answers 404 for an unknown connection', async () => {
    expect((await post(webhook(), APP_SECRET, randomUUID())).status).toBe(404);
  });

  it('answers 503 when the media download fails, so Meta retries, and ingests nothing', async () => {
    const before = await inboundCount();
    const body = webhook({ type: 'document' });
    graph.mediaError = new WhatsAppGraphError(503, null, 'media unavailable');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await post(body);
    spy.mockRestore();
    expect(res.status).toBe(503);
    expect(await inboundCount()).toBe(before);
    graph.mediaError = null;
    expect((await post(body)).status).toBe(200);
    expect(await inboundCount()).toBe(before + 1);
  });
});
