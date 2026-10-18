import { MAX_ATTACHMENT_BYTES } from '../sanitise.ts';

/**
 * Thin BlueBubbles REST client. `fetch` is injectable so tests never touch the network. The server
 * password travels only as the `password` query parameter to the configured server URL and never
 * appears in error text.
 *
 * NOTE: coded against the published BlueBubbles REST docs; not yet verified against a live server.
 */

export class BlueBubblesApiError extends Error {
  override readonly name = 'BlueBubblesApiError';
  constructor(
    readonly code: string,
    method: string,
  ) {
    super(`bluebubbles ${method} failed: ${code}`);
  }
}

export interface BlueBubblesDownload {
  bytes: Buffer;
  contentType: string | null;
}

/** What the adapter, poller and CLI need from the server. Tests provide a fake. */
export interface BlueBubblesClient {
  ping(): Promise<void>;
  /** Raw messages with dateCreated strictly after `afterMs`, oldest first. */
  queryMessages(input: { afterMs: number; limit?: number }): Promise<unknown[]>;
  downloadAttachment(guid: string, maxBytes?: number): Promise<BlueBubblesDownload>;
  sendText(input: { chatGuid: string; text: string }): Promise<{ guid: string }>;
}

export class BlueBubblesRestClient implements BlueBubblesClient {
  private readonly base: URL;
  private readonly fetchImpl: typeof fetch;

  constructor(
    baseUrl: string,
    private readonly password: string,
    fetchImpl: typeof fetch = fetch,
  ) {
    let url: URL;
    try {
      url = new URL(baseUrl);
    } catch {
      throw new BlueBubblesApiError('invalid_server_url', 'config');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new BlueBubblesApiError('invalid_server_url', 'config');
    url.pathname = url.pathname.replace(/\/+$/, '');
    url.search = '';
    this.base = url;
    this.fetchImpl = fetchImpl;
  }

  private url(path: string): string {
    const base = this.base.toString().replace(/\/+$/, '');
    const u = new URL(`${base}${path}`);
    u.searchParams.set('password', this.password);
    return u.toString();
  }

  async ping(): Promise<void> {
    const res = await this.fetchImpl(this.url('/api/v1/ping'));
    if (!res.ok) throw new BlueBubblesApiError(`http_${res.status}`, 'ping');
  }

  async queryMessages(input: { afterMs: number; limit?: number }): Promise<unknown[]> {
    const res = await this.fetchImpl(this.url('/api/v1/message/query'), {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        limit: input.limit ?? 50,
        offset: 0,
        after: input.afterMs,
        sort: 'ASC',
        with: ['chats', 'chats.participants', 'handle', 'attachments'],
      }),
    });
    if (!res.ok) throw new BlueBubblesApiError(`http_${res.status}`, 'message/query');
    const json = (await res.json().catch(() => null)) as { data?: unknown } | null;
    if (!json || !Array.isArray(json.data)) throw new BlueBubblesApiError('invalid_response', 'message/query');
    return json.data;
  }

  async downloadAttachment(guid: string, maxBytes: number = MAX_ATTACHMENT_BYTES): Promise<BlueBubblesDownload> {
    const res = await this.fetchImpl(this.url(`/api/v1/attachment/${encodeURIComponent(guid)}/download`));
    if (!res.ok) throw new BlueBubblesApiError(`http_${res.status}`, 'attachment/download');
    const contentType = res.headers.get('content-type');
    // An HTML answer is an error page, never a receipt.
    if (contentType?.toLowerCase().startsWith('text/html')) throw new BlueBubblesApiError('attachment_download_returned_html', 'attachment/download');
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > maxBytes) throw new BlueBubblesApiError('file_too_large', 'attachment/download');
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new BlueBubblesApiError('file_too_large', 'attachment/download');
    return { bytes, contentType };
  }

  async sendText(input: { chatGuid: string; text: string }): Promise<{ guid: string }> {
    const res = await this.fetchImpl(this.url('/api/v1/message/text'), {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      // AppleScript, not the Private API.
      body: JSON.stringify({ chatGuid: input.chatGuid, message: input.text, method: 'apple-script' }),
    });
    if (!res.ok) throw new BlueBubblesApiError(`http_${res.status}`, 'message/text');
    const json = (await res.json().catch(() => null)) as { data?: { guid?: unknown } } | null;
    const guid = json?.data?.guid;
    if (typeof guid !== 'string' || !guid) throw new BlueBubblesApiError('invalid_response', 'message/text');
    return { guid };
  }
}
