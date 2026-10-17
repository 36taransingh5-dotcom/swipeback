import { createHash, timingSafeEqual } from 'node:crypto';
import type { Hono } from 'hono';
import { loadConnection, receiveWhatsAppWebhook, WhatsAppConnectionError, type EngineDeps } from '@swipeback/engine';

/**
 * Meta WhatsApp Cloud API webhook endpoints. No business logic: the GET handshake proves we own
 * the callback URL, the POST hands the raw signed body to the engine. Meta retries any non-2xx, so
 * 2xx means "handled (or deliberately ignored)" and 5xx means "try again".
 */

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const UUID_RE = /^[0-9a-f-]{36}$/;

function tokenMatches(given: string, expected: string): boolean {
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

// Hono's app type carries per-app variables; the routes use none of them.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerWhatsAppRoutes(app: Hono<any>, deps: EngineDeps, env: NodeJS.ProcessEnv = process.env): void {
  /** Webhook verification handshake: echo `hub.challenge` as plain text when the verify token matches. */
  app.get('/api/whatsapp/:connectionId', async (c) => {
    const connectionId = c.req.param('connectionId');
    if (!UUID_RE.test(connectionId)) return c.text('unknown connection', 404);
    const expected = env.SB_WHATSAPP_VERIFY_TOKEN ?? '';
    const token = c.req.query('hub.verify_token') ?? '';
    const challenge = c.req.query('hub.challenge') ?? '';
    if (!expected || c.req.query('hub.mode') !== 'subscribe' || !tokenMatches(token, expected) || challenge.length === 0 || challenge.length > 256) {
      return c.text('forbidden', 403);
    }
    try {
      await loadConnection(deps, connectionId);
    } catch (err) {
      if (err instanceof Error && /^(unknown connection|connection \S+ is )/.test(err.message)) return c.text('unknown connection', 404);
      return c.text('temporarily unavailable', 503);
    }
    return c.text(challenge, 200);
  });

  app.post('/api/whatsapp/:connectionId', async (c) => {
    const connectionId = c.req.param('connectionId');
    if (!UUID_RE.test(connectionId)) return c.json({ error: 'unknown connection' }, 404);
    if (Number(c.req.header('content-length') ?? 0) > MAX_BODY_BYTES) return c.json({ error: 'payload too large' }, 413);
    const body = Buffer.from(await c.req.arrayBuffer());
    if (body.byteLength > MAX_BODY_BYTES) return c.json({ error: 'payload too large' }, 413);
    const headers: Record<string, string> = {};
    c.req.raw.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
    try {
      const r = await receiveWhatsAppWebhook(deps, connectionId, { body, headers });
      return c.json(r, r.status === 'REJECTED' ? 401 : 200);
    } catch (err) {
      if (err instanceof WhatsAppConnectionError) return c.json({ error: 'unknown or inactive connection' }, 404);
      // Transient (media download, database): Meta retries, and the dedupe key makes that safe.
      console.error(`whatsapp webhook failed for connection ${connectionId}: ${err instanceof Error ? err.name : 'error'}`);
      return c.json({ error: 'temporary failure, please retry' }, 503);
    }
  });
}
