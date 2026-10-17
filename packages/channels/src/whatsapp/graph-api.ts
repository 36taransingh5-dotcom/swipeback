import { InboundRejectedError } from '../contract.ts';

/**
 * Thin Meta Graph API client for WhatsApp Cloud: download received media and send text.
 * `fetch` is injectable so tests never touch the network. Tokens are never put in error text.
 */

// Meta versions stay available for about two years; set SB_WHATSAPP_GRAPH_VERSION to move on.
export const DEFAULT_GRAPH_VERSION = 'v23.0';
const GRAPH = 'https://graph.facebook.com';

/** The bearer token is only ever sent to https hosts Meta serves media from. */
const MEDIA_HOST_SUFFIXES = ['.facebook.com', '.fbsbx.com', '.fbcdn.net', '.whatsapp.net'] as const;

type FetchLike = typeof fetch;

export interface DownloadedMedia {
  bytes: Buffer;
  mimeType: string;
  /** The hash Meta reports for the media, in whatever encoding it used. Null when absent. */
  sha256: string | null;
}

export interface WhatsAppGraphClient {
  downloadMedia(mediaId: string, maxBytes: number): Promise<DownloadedMedia>;
  sendText(params: { to: string; body: string; replyToMessageId?: string | null }): Promise<{ messageId: string }>;
}

export class WhatsAppGraphError extends Error {
  override readonly name = 'WhatsAppGraphError';
  constructor(
    readonly status: number,
    /** Meta's error code, e.g. 131047 when the 24-hour customer service window has closed. */
    readonly code: number | null,
    message: string,
  ) {
    super(message);
  }
}

export interface MetaGraphConfig {
  accessToken: string;
  phoneNumberId: string;
  graphVersion?: string;
}

export class MetaGraphClient implements WhatsAppGraphClient {
  private readonly base: string;

  constructor(
    private readonly cfg: MetaGraphConfig,
    private readonly fetchImpl: FetchLike = fetch,
  ) {
    if (!cfg.accessToken || !cfg.phoneNumberId) throw new Error('WhatsApp Graph client needs an access token and phone number id');
    if (!/^v\d+\.\d+$/.test(cfg.graphVersion ?? DEFAULT_GRAPH_VERSION)) throw new Error('invalid Graph API version');
    this.base = `${GRAPH}/${cfg.graphVersion ?? DEFAULT_GRAPH_VERSION}`;
  }

  async downloadMedia(mediaId: string, maxBytes: number): Promise<DownloadedMedia> {
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(mediaId)) throw new InboundRejectedError('MALFORMED', 'invalid media id');
    const metaRes = await this.request(`${this.base}/${mediaId}`, { method: 'GET' });
    const meta = (await metaRes.json().catch(() => ({}))) as Record<string, unknown>;
    const url = typeof meta.url === 'string' ? meta.url : '';
    if (!isMediaUrl(url)) throw new WhatsAppGraphError(502, null, 'media lookup returned no usable download url');
    if (typeof meta.file_size === 'number' && meta.file_size > maxBytes) throw new InboundRejectedError('TOO_LARGE', 'attachment too large');

    const res = await this.request(url, { method: 'GET' });
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > maxBytes) throw new InboundRejectedError('TOO_LARGE', 'attachment too large');
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new InboundRejectedError('TOO_LARGE', 'attachment too large');
    return {
      bytes,
      mimeType: typeof meta.mime_type === 'string' ? meta.mime_type : (res.headers.get('content-type') ?? 'application/octet-stream'),
      sha256: typeof meta.sha256 === 'string' ? meta.sha256 : null,
    };
  }

  async sendText(params: { to: string; body: string; replyToMessageId?: string | null }): Promise<{ messageId: string }> {
    const payload: Record<string, unknown> = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: params.to,
      type: 'text',
      text: { preview_url: false, body: params.body },
    };
    if (params.replyToMessageId) payload.context = { message_id: params.replyToMessageId };
    const res = await this.request(`${this.base}/${this.cfg.phoneNumberId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const json = (await res.json().catch(() => ({}))) as { messages?: { id?: unknown }[] };
    const id = json.messages?.[0]?.id;
    if (typeof id !== 'string' || !id) throw new WhatsAppGraphError(502, null, 'send accepted but Meta returned no message id');
    return { messageId: id };
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    const res = await this.fetchImpl(url, {
      ...init,
      headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${this.cfg.accessToken}` },
    });
    if (res.ok) return res;
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: unknown; code?: unknown } };
    const code = typeof body.error?.code === 'number' ? body.error.code : null;
    const detail = typeof body.error?.message === 'string' ? body.error.message.slice(0, 200) : res.statusText;
    throw new WhatsAppGraphError(res.status, code, `WhatsApp Graph API ${res.status}${code === null ? '' : ` (code ${code})`}: ${detail}`);
  }
}

function isMediaUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && MEDIA_HOST_SUFFIXES.some((s) => u.hostname.endsWith(s));
  } catch {
    return false;
  }
}
