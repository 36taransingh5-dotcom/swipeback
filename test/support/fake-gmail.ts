import { randomBytes } from 'node:crypto';

/**
 * In-memory stand-in for Google OAuth + the Gmail REST endpoints Swipeback uses. Behaviour that
 * matters is modelled: bearer auth with expiring access tokens, refresh/invalid_grant, history
 * cursors that go stale (404), SENT copies of our own messages, and thread ids.
 */
interface Msg {
  id: string;
  threadId: string;
  labelIds: string[];
  raw: Buffer;
  historyId: number;
}

export class FakeGmail {
  messages: Msg[] = [];
  sent: { raw: string; threadId: string | null; id: string }[] = [];
  historyId = 1000;
  minHistoryId = 0;
  accessToken = `ya29.${randomBytes(8).toString('hex')}`;
  refreshToken = `1//${randomBytes(8).toString('hex')}`;
  accessValid = true;
  revoked = false;
  grantedScopes = ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send'];
  issuedCodes = new Set<string>();
  calls: string[] = [];

  constructor(public mailbox: string) {}

  deliver(raw: Buffer, opts: { threadId?: string; labels?: string[] } = {}): Msg {
    const m: Msg = { id: randomBytes(8).toString('hex'), threadId: opts.threadId ?? randomBytes(8).toString('hex'), labelIds: opts.labels ?? ['INBOX', 'UNREAD'], raw, historyId: ++this.historyId };
    this.messages.push(m);
    return m;
  }

  issueCode(): string {
    const code = `4/${randomBytes(6).toString('hex')}`;
    this.issuedCodes.add(code);
    return code;
  }

  readonly fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = (init.method ?? 'GET').toUpperCase();
    this.calls.push(`${method} ${url.pathname}`);
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

    if (url.host === 'oauth2.googleapis.com' && url.pathname === '/token') {
      const p = new URLSearchParams(String(init.body));
      if (p.get('grant_type') === 'authorization_code') {
        if (!this.issuedCodes.delete(p.get('code') ?? '') || !p.get('code_verifier')) return json(400, { error: 'invalid_grant' });
        this.accessValid = true;
        return json(200, { access_token: this.accessToken, refresh_token: this.refreshToken, expires_in: 3599, scope: this.grantedScopes.join(' '), token_type: 'Bearer' });
      }
      if (p.get('grant_type') === 'refresh_token') {
        if (this.revoked || p.get('refresh_token') !== this.refreshToken) return json(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
        this.accessToken = `ya29.${randomBytes(8).toString('hex')}`;
        this.accessValid = true;
        return json(200, { access_token: this.accessToken, expires_in: 3599, scope: this.grantedScopes.join(' '), token_type: 'Bearer' });
      }
    }
    if (url.host === 'oauth2.googleapis.com' && url.pathname === '/revoke') {
      this.revoked = true;
      return json(200, {});
    }
    if (url.host !== 'gmail.googleapis.com') return json(404, { error: { message: 'unknown host' } });
    const auth = new Headers(init.headers).get('authorization');
    if (!this.accessValid || auth !== `Bearer ${this.accessToken}`) return json(401, { error: { message: 'Invalid Credentials' } });

    const path = url.pathname.replace('/gmail/v1/users/me', '');
    if (path === '/profile') return json(200, { emailAddress: this.mailbox, historyId: String(this.historyId) });
    if (path === '/history') {
      const start = Number(url.searchParams.get('startHistoryId'));
      if (start < this.minHistoryId) return json(404, { error: { message: 'Requested entity was not found.' } });
      const added = this.messages.filter((m) => m.historyId > start);
      return json(200, { history: added.map((m) => ({ id: String(m.historyId), messagesAdded: [{ message: { id: m.id, threadId: m.threadId } }] })), historyId: String(this.historyId) });
    }
    if (path === '/messages' && method === 'GET') {
      return json(200, { messages: this.messages.filter((m) => m.labelIds.includes('INBOX')).slice(-Number(url.searchParams.get('maxResults') ?? 50)).map((m) => ({ id: m.id, threadId: m.threadId })) });
    }
    const one = /^\/messages\/([^/]+)$/.exec(path);
    if (one && method === 'GET') {
      const m = this.messages.find((x) => x.id === decodeURIComponent(one[1]!));
      return m ? json(200, { id: m.id, threadId: m.threadId, labelIds: m.labelIds, raw: m.raw.toString('base64url') }) : json(404, { error: { message: 'Not Found' } });
    }
    if (path === '/messages/send' && method === 'POST') {
      const body = JSON.parse(String(init.body)) as { raw: string; threadId?: string };
      const raw = Buffer.from(body.raw, 'base64url');
      const m = this.deliver(raw, { labels: ['SENT'], ...(body.threadId ? { threadId: body.threadId } : {}) });
      this.sent.push({ raw: raw.toString('utf8'), threadId: body.threadId ?? null, id: m.id });
      return json(200, { id: m.id, threadId: m.threadId, labelIds: ['SENT'] });
    }
    return json(404, { error: { message: `no fake for ${method} ${path}` } });
  }) as typeof fetch;
}
