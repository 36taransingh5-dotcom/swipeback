import { MAX_ATTACHMENT_BYTES } from '../sanitise.ts';

/**
 * Thin Slack Web API client. `fetch` is injectable so tests never touch the network. Errors carry
 * Slack's error code only: tokens and response bodies never appear in error text.
 */

export class SlackApiError extends Error {
  override readonly name = 'SlackApiError';
  constructor(
    readonly code: string,
    method: string,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(`slack ${method} failed: ${code}`);
  }
}

export interface SlackIdentity {
  teamId: string;
  team: string;
  userId: string;
  user: string;
}

export interface SlackDownload {
  bytes: Buffer;
  contentType: string | null;
}

/** What the adapter and CLI need from Slack. Tests provide a fake. */
export interface SlackClient {
  authTest(): Promise<SlackIdentity>;
  /** Open (or find) the DM with a user and return the channel id (D…). */
  openConversation(userId: string): Promise<string>;
  postMessage(input: { channel: string; text: string; threadTs?: string | undefined }): Promise<{ ts: string; channel: string }>;
  /** `null` when no Slack user has that email. */
  lookupUserByEmail(email: string): Promise<{ id: string } | null>;
  downloadFile(url: string, maxBytes?: number): Promise<SlackDownload>;
}

const API = 'https://slack.com/api/';

function isSlackHost(url: URL): boolean {
  return url.protocol === 'https:' && (url.hostname === 'slack.com' || url.hostname.endsWith('.slack.com'));
}

export class SlackWebClient implements SlackClient {
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly botToken: string,
    fetchImpl: typeof fetch = fetch,
  ) {
    this.fetchImpl = fetchImpl;
  }

  async authTest(): Promise<SlackIdentity> {
    const r = await this.call('auth.test', {});
    return { teamId: str(r.team_id), team: str(r.team), userId: str(r.user_id), user: str(r.user) };
  }

  async openConversation(userId: string): Promise<string> {
    const r = await this.call('conversations.open', { users: userId });
    return str((r.channel as { id?: unknown } | undefined)?.id);
  }

  async postMessage(input: { channel: string; text: string; threadTs?: string | undefined }): Promise<{ ts: string; channel: string }> {
    const r = await this.call('chat.postMessage', {
      channel: input.channel,
      text: input.text,
      ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
      unfurl_links: false,
      unfurl_media: false,
    });
    return { ts: str(r.ts), channel: str(r.channel) };
  }

  async lookupUserByEmail(email: string): Promise<{ id: string } | null> {
    try {
      const r = await this.call('users.lookupByEmail', { email }, true);
      return { id: str((r.user as { id?: unknown } | undefined)?.id) };
    } catch (err) {
      if (err instanceof SlackApiError && err.code === 'users_not_found') return null;
      throw err;
    }
  }

  async downloadFile(url: string, maxBytes: number = MAX_ATTACHMENT_BYTES): Promise<SlackDownload> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new SlackApiError('invalid_file_url', 'files.download');
    }
    // The bot token is only ever sent to Slack.
    if (!isSlackHost(parsed)) throw new SlackApiError('untrusted_file_host', 'files.download');
    const res = await this.fetchImpl(parsed, { headers: { authorization: `Bearer ${this.botToken}` } });
    if (!res.ok) throw new SlackApiError(`http_${res.status}`, 'files.download');
    const contentType = res.headers.get('content-type');
    // Slack answers a bad token or missing files:read scope with an HTML sign-in page.
    if (contentType?.toLowerCase().startsWith('text/html')) throw new SlackApiError('file_download_returned_html', 'files.download');
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > maxBytes) throw new SlackApiError('file_too_large', 'files.download');
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new SlackApiError('file_too_large', 'files.download');
    return { bytes, contentType };
  }

  private async call(method: string, params: Record<string, string | boolean>, form = false): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.botToken}` };
    let body: string;
    if (form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)]))).toString();
    } else {
      headers['content-type'] = 'application/json; charset=utf-8';
      body = JSON.stringify(params);
    }
    const res = await this.fetchImpl(`${API}${method}`, { method: 'POST', headers, body });
    if (res.status === 429) throw new SlackApiError('ratelimited', method, Number(res.headers.get('retry-after') ?? 0) || null);
    if (!res.ok) throw new SlackApiError(`http_${res.status}`, method);
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!json || json.ok !== true) throw new SlackApiError(typeof json?.error === 'string' ? json.error.slice(0, 64) : 'invalid_response', method);
    return json;
  }
}

function str(v: unknown): string {
  if (typeof v !== 'string' || !v) throw new SlackApiError('invalid_response', 'parse');
  return v;
}

/** Socket Mode: exchange the app-level token (xapp-…) for a one-time WebSocket URL. */
export async function openSocketModeUrl(appToken: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const res = await fetchImpl(`${API}apps.connections.open`, { method: 'POST', headers: { authorization: `Bearer ${appToken}`, 'content-type': 'application/x-www-form-urlencoded' } });
  if (res.status === 429) throw new SlackApiError('ratelimited', 'apps.connections.open', Number(res.headers.get('retry-after') ?? 0) || null);
  const json = (await res.json().catch(() => null)) as { ok?: boolean; url?: unknown; error?: unknown } | null;
  if (!res.ok || !json || json.ok !== true || typeof json.url !== 'string') {
    throw new SlackApiError(typeof json?.error === 'string' ? json.error.slice(0, 64) : `http_${res.status}`, 'apps.connections.open');
  }
  const url = new URL(json.url);
  if (url.protocol !== 'wss:') throw new SlackApiError('invalid_socket_url', 'apps.connections.open');
  return url.toString();
}
