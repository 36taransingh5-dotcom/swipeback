import { createHash, randomBytes } from 'node:crypto';

/**
 * Minimal Gmail REST + Google OAuth client (fetch-based, injectable for tests).
 * Scopes are least-privilege: read messages and send replies. Swipeback never deletes, labels,
 * or reads anything outside the designated finance mailbox it was connected to.
 */

export const GMAIL_SCOPES = ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send'] as const;
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';

export type Fetch = typeof fetch;

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export class GmailApiError extends Error {
  override readonly name = 'GmailApiError';
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** The refresh token was revoked or expired: a person must reconnect the mailbox. */
export class ReconnectRequiredError extends Error {
  override readonly name = 'ReconnectRequiredError';
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

export function googleAuthUrl(cfg: GoogleOAuthConfig, p: { state: string; codeChallenge: string; loginHint?: string }): string {
  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  u.searchParams.set('client_id', cfg.clientId);
  u.searchParams.set('redirect_uri', cfg.redirectUri);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', GMAIL_SCOPES.join(' '));
  u.searchParams.set('access_type', 'offline');
  u.searchParams.set('prompt', 'consent');
  u.searchParams.set('include_granted_scopes', 'false');
  u.searchParams.set('state', p.state);
  u.searchParams.set('code_challenge', p.codeChallenge);
  u.searchParams.set('code_challenge_method', 'S256');
  if (p.loginHint) u.searchParams.set('login_hint', p.loginHint);
  return u.toString();
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date;
  scopes: string[];
}

async function tokenRequest(f: Fetch, body: Record<string, string>): Promise<TokenSet> {
  const res = await f('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    if (json.error === 'invalid_grant') throw new ReconnectRequiredError(`Google rejected the grant: ${String(json.error_description ?? 'invalid_grant')}`);
    throw new GmailApiError(res.status, `token endpoint: ${String(json.error ?? res.statusText)}`);
  }
  return {
    accessToken: String(json.access_token),
    refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : null,
    expiresAt: new Date(Date.now() + Number(json.expires_in ?? 3600) * 1000),
    scopes: String(json.scope ?? '').split(/\s+/).filter(Boolean),
  };
}

export function exchangeCode(f: Fetch, cfg: GoogleOAuthConfig, code: string, codeVerifier: string): Promise<TokenSet> {
  return tokenRequest(f, { grant_type: 'authorization_code', code, code_verifier: codeVerifier, client_id: cfg.clientId, client_secret: cfg.clientSecret, redirect_uri: cfg.redirectUri });
}

export function refreshAccessToken(f: Fetch, cfg: GoogleOAuthConfig, refreshToken: string): Promise<TokenSet> {
  return tokenRequest(f, { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: cfg.clientId, client_secret: cfg.clientSecret });
}

export async function revokeToken(f: Fetch, token: string): Promise<void> {
  await f('https://oauth2.googleapis.com/revoke', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }) }).catch(() => undefined);
}

export interface HistoryPage {
  messageIds: { id: string; threadId: string }[];
  historyId: string;
  nextPageToken: string | null;
}

/** Gmail REST calls for one mailbox. `token()` returns a valid access token (refreshing as needed). */
export class GmailApi {
  constructor(
    private readonly token: (forceRefresh?: boolean) => Promise<string>,
    private readonly f: Fetch = fetch,
  ) {}

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await this.f(`${GMAIL}${path}`, {
        ...init,
        headers: { ...(init.headers ?? {}), authorization: `Bearer ${await this.token(attempt > 0)}` },
      });
      if (res.status === 401 && attempt === 0) continue; // access token expired early: refresh once
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
        throw new GmailApiError(res.status, `gmail ${path.split('?')[0]}: ${body.error?.message ?? res.statusText}`);
      }
      return (await res.json()) as T;
    }
    throw new GmailApiError(401, 'gmail: unauthorised after token refresh');
  }

  profile(): Promise<{ emailAddress: string; historyId: string }> {
    return this.call('/profile');
  }

  async history(startHistoryId: string, pageToken?: string): Promise<HistoryPage> {
    const q = new URLSearchParams({ startHistoryId, historyTypes: 'messageAdded', maxResults: '100' });
    if (pageToken) q.set('pageToken', pageToken);
    const r = await this.call<{ history?: { messagesAdded?: { message: { id: string; threadId: string } }[] }[]; historyId: string; nextPageToken?: string }>(`/history?${q}`);
    const ids = (r.history ?? []).flatMap((h) => (h.messagesAdded ?? []).map((m) => m.message));
    return { messageIds: [...new Map(ids.map((m) => [m.id, m])).values()], historyId: r.historyId, nextPageToken: r.nextPageToken ?? null };
  }

  async listRecent(query: string, max = 50): Promise<{ id: string; threadId: string }[]> {
    const r = await this.call<{ messages?: { id: string; threadId: string }[] }>(`/messages?${new URLSearchParams({ q: query, maxResults: String(max) })}`);
    return r.messages ?? [];
  }

  async getRaw(id: string): Promise<{ id: string; threadId: string; labelIds: string[]; raw: Buffer }> {
    const r = await this.call<{ id: string; threadId: string; labelIds?: string[]; raw: string }>(`/messages/${encodeURIComponent(id)}?format=raw`);
    return { id: r.id, threadId: r.threadId, labelIds: r.labelIds ?? [], raw: Buffer.from(r.raw, 'base64url') };
  }

  async send(rawMime: string, threadId: string | null): Promise<{ id: string; threadId: string }> {
    return this.call('/messages/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ raw: Buffer.from(rawMime, 'utf8').toString('base64url'), ...(threadId ? { threadId } : {}) }),
    });
  }
}
