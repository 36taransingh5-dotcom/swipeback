import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type {
  ApprovalRequest,
  ChannelAdapter,
  ConnectionContext,
  InboundAttachment,
  InboundMessageV1,
  OutboundEnvelope,
  RawInbound,
  SendResult,
  VerifiedInbound,
} from '../contract.ts';
import { InboundRejectedError, inboundMessageV1Schema } from '../contract.ts';
import type { EvidenceStore } from '../evidence-store.ts';
import { MAX_ATTACHMENT_BYTES, dedupeKeyFor, normaliseMime, sanitiseShort, sanitiseUntrustedText, screenAttachment } from '../sanitise.ts';
import type { WhatsAppGraphClient } from './graph-api.ts';
import { splitWebhook, type WaIncoming } from './payload.ts';

/**
 * WhatsApp Cloud API channel (Meta). Inbound webhooks are authenticated by an HMAC of the raw body
 * with the app secret; the sender's number is vouched for by WhatsApp itself ('platform_signed').
 * A webhook POST can batch several messages and statuses, so besides the one-event
 * `verifyInbound` required by the contract there is `verifyWebhook`, which returns every message.
 */

export const WHATSAPP_SIGNATURE_HEADER = 'x-hub-signature-256';
export const WHATSAPP_BODY_LIMIT = 4096;
const TRUNCATION_NOTE = '\n\n[message shortened]';

export type WhatsAppVerified = VerifiedInbound<WaIncoming>;

export interface WhatsAppWebhookBatch {
  messages: WhatsAppVerified[];
  /** Statuses, unsupported message types and messages for other numbers. Recorded, never answered. */
  ignored: number;
}

export function signWhatsAppBody(appSecret: string, body: Buffer | string): string {
  return `sha256=${createHmac('sha256', appSecret).update(body).digest('hex')}`;
}

/** Meta reports media hashes inconsistently (hex or base64); accept either encoding of the same digest. */
export function sha256Matches(bytes: Uint8Array, claimed: string): boolean {
  const digest = createHash('sha256').update(bytes).digest();
  return claimed.toLowerCase() === digest.toString('hex') || claimed === digest.toString('base64');
}

/** `447700900123` -> `+447700900123`. The same form `channel_identities.channel_address` holds. */
export function toE164(digits: string): string {
  return `+${digits.replace(/^\+/, '')}`;
}

/** One thread per chat, shared by inbound messages and our replies so answers correlate. */
export function chatThreadId(connectionId: string, digits: string): string {
  return `wa:${connectionId}:${digits.replace(/^\+/, '')}`;
}

export class WhatsAppCloudAdapter implements ChannelAdapter<WaIncoming> {
  readonly channel = 'whatsapp' as const;
  readonly provider = 'whatsapp-cloud';
  readonly capabilities = {
    attachments: true,
    threading: true,
    interactiveActions: false,
    deliveryReceipts: false,
    businessInitiatedMessages: 'template_only',
  } as const;

  constructor(
    private readonly evidence: EvidenceStore,
    private readonly graph: WhatsAppGraphClient,
    private readonly appSecret: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (appSecret.length < 16) throw new Error('WhatsApp app secret too short');
  }

  async verifyInbound(connection: ConnectionContext, raw: RawInbound): Promise<WhatsAppVerified> {
    const batch = this.verifyWebhook(connection, raw);
    if (batch.messages.length === 0) throw new InboundRejectedError('NOT_ADDRESSED_TO_CONNECTION', 'no user message in webhook');
    if (batch.messages.length > 1) throw new InboundRejectedError('MALFORMED', 'batched webhook: use verifyWebhook');
    return batch.messages[0]!;
  }

  /** Same checks as `verifyInbound`, but returns one entry per user message in the POST. */
  verifyWebhook(connection: ConnectionContext, raw: RawInbound): WhatsAppWebhookBatch {
    this.checkSignature(raw);
    let body: unknown;
    try {
      body = JSON.parse(raw.body.toString('utf8'));
    } catch {
      throw new InboundRejectedError('MALFORMED', 'webhook body is not JSON');
    }
    let batch: ReturnType<typeof splitWebhook>;
    try {
      batch = splitWebhook(body, connection.address);
    } catch (err) {
      throw new InboundRejectedError('MALFORMED', (err as Error).message.slice(0, 200));
    }
    if (batch.phoneNumberIds.length > 0 && !batch.phoneNumberIds.includes(connection.address)) {
      throw new InboundRejectedError('NOT_ADDRESSED_TO_CONNECTION', 'webhook is for another phone number');
    }
    const receivedAt = this.now().toISOString();
    return {
      ignored: batch.ignored,
      messages: batch.messages.map((m) => ({ connection, providerEventId: m.message.id, senderAuth: 'platform_signed', payload: m, receivedAt })),
    };
  }

  async normaliseInbound(v: WhatsAppVerified): Promise<InboundMessageV1> {
    const { connection, payload } = v;
    const { message } = payload;
    const media = message.type === 'image' ? message.image : message.type === 'document' ? message.document : undefined;
    const attachments: InboundAttachment[] = [];
    if (media) {
      // Media URLs expire within minutes, so the bytes are fetched now. A failure throws and the
      // webhook is retried; an expense is never created without its evidence.
      const downloaded = await this.graph.downloadMedia(media.id, MAX_ATTACHMENT_BYTES);
      const expected = media.sha256 ?? downloaded.sha256;
      if (expected && !sha256Matches(downloaded.bytes, expected)) throw new InboundRejectedError('MALFORMED', 'media hash does not match Meta sha256');
      const mime = normaliseMime(media.mime_type ?? downloaded.mimeType);
      const screen = screenAttachment(mime, downloaded.bytes);
      const stored = await this.evidence.put(connection.tenantId, downloaded.bytes);
      attachments.push({
        sha256: stored.sha256,
        mime,
        sizeBytes: stored.sizeBytes,
        storageKey: stored.storageKey,
        filename: sanitiseShort(media.filename, 255),
        scan: screen.scan,
        scanNote: screen.note,
      });
    }
    const text = message.type === 'text' ? (message.text?.body ?? '') : (media?.caption ?? '');
    return inboundMessageV1Schema.parse({
      schema: 'swipeback.inbound.v1',
      tenantId: connection.tenantId,
      channel: 'whatsapp',
      connectionId: connection.connectionId,
      providerEventId: message.id,
      dedupeKey: dedupeKeyFor('whatsapp', connection.connectionId, message.id),
      receivedAt: v.receivedAt,
      providerTimestamp: new Date(Number(message.timestamp) * 1000).toISOString(),
      sender: { channelAddress: toE164(message.from), displayName: sanitiseShort(payload.contactName, 200), authentication: 'platform_signed' },
      conversation: {
        threadId: chatThreadId(connection.connectionId, message.from),
        messageId: message.id,
        inReplyTo: message.context?.id ?? null,
        references: [],
        correlationToken: null,
      },
      subject: null,
      text: sanitiseUntrustedText(text),
      attachments,
      action: null,
      consent: { source: 'bot_dm', scope: `whatsapp:${connection.address}` },
      autoGenerated: false,
      correlationId: randomUUID(),
    } satisfies InboundMessageV1);
  }

  async sendMessage(message: OutboundEnvelope): Promise<SendResult> {
    const digits = message.to.replace(/^\+/, '');
    if (!/^\d{5,20}$/.test(digits)) throw new Error('WhatsApp recipient must be an E.164 phone number');
    const body = message.text.length > WHATSAPP_BODY_LIMIT ? message.text.slice(0, WHATSAPP_BODY_LIMIT - TRUNCATION_NOTE.length) + TRUNCATION_NOTE : message.text;
    const replyToMessageId = message.inReplyTo?.startsWith('wamid.') ? message.inReplyTo : null;
    const sent = await this.graph.sendText({ to: digits, body, replyToMessageId });
    return { providerMessageId: sent.messageId, threadId: message.threadId ?? chatThreadId(message.connectionId, digits) };
  }

  /** WhatsApp is not an approval surface: this is a plain message pointing at the authenticated review app. */
  async sendApprovalRequest(request: ApprovalRequest): Promise<SendResult> {
    return this.sendMessage({ ...request, text: `${request.text}\n\nReview in the Swipeback app (sign-in required): ${request.reviewUrl}` });
  }

  private checkSignature(raw: RawInbound): void {
    const m = /^sha256=([0-9a-f]{64})$/i.exec(raw.headers[WHATSAPP_SIGNATURE_HEADER] ?? '');
    if (!m) throw new InboundRejectedError('BAD_SIGNATURE', 'missing or malformed signature');
    const expected = Buffer.from(signWhatsAppBody(this.appSecret, raw.body).slice('sha256='.length), 'hex');
    const given = Buffer.from(m[1]!, 'hex');
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw new InboundRejectedError('BAD_SIGNATURE');
  }
}
