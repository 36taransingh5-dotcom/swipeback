import { randomUUID } from 'node:crypto';
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
import { dedupeKeyFor, MAX_ATTACHMENT_BYTES, normaliseMime, sanitiseShort, sanitiseUntrustedText, screenAttachment } from '../sanitise.ts';
import type { BlueBubblesClient } from './bluebubbles-client.ts';
import { parseBlueBubblesMessage, type BlueBubblesMessage } from './payload.ts';

/**
 * iMessage as a channel, through a Mac running the BlueBubbles server. There is no inbound webhook:
 * BlueBubbles webhooks are unsigned, so the engine polls the server over its password-authenticated
 * REST API (the trusted-transport path, like Slack's Socket Mode) and `verifyInbound` always
 * rejects. Replies are plain text sent into the same 1:1 chat via AppleScript. Adapters never touch
 * expenses, approvals or payouts.
 */

export const IMESSAGE_PROVIDER = 'bluebubbles';

const MAX_FILES_PER_MESSAGE = 5;
const SUPPORTED_MIME = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/heic', 'image/webp', 'text/plain']);

/** `imessage:<handle lower-cased>`: the exact format stored in channel_identities.channel_address. */
export function imessageChannelAddress(handle: string): string {
  const h = handle.trim();
  if (h.includes('@')) return `imessage:${h.toLowerCase()}`;
  // Phone number: drop spaces, dashes and brackets, keep the leading + and digits.
  return `imessage:${h.replace(/[\s()-]/g, '').toLowerCase()}`;
}

/** The BlueBubbles chat guid for a 1:1 iMessage chat with a handle (`iMessage;-;<handle>`). */
export function imessageDmChatGuid(handle: string): string {
  return `iMessage;-;${handle.trim()}`;
}

export interface IMessageInboundPayload {
  message: BlueBubblesMessage;
}

export class BlueBubblesAdapter implements ChannelAdapter<IMessageInboundPayload> {
  readonly channel = 'imessage' as const;
  readonly provider = IMESSAGE_PROVIDER;
  readonly capabilities = {
    attachments: true,
    threading: false,
    interactiveActions: false,
    deliveryReceipts: false,
    businessInitiatedMessages: 'none',
  } as const;

  constructor(
    private readonly evidence: EvidenceStore,
    readonly client: BlueBubblesClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * There is no authenticated HTTP ingress for this channel (BlueBubbles webhooks carry no
   * signature), so every HTTP-delivered request is rejected. Messages arrive by polling.
   */
  verifyInbound(_connection: ConnectionContext, _raw: RawInbound): Promise<never> {
    return Promise.reject(new InboundRejectedError('BAD_SIGNATURE', 'iMessage has no authenticated HTTP ingress; messages are polled from the BlueBubbles server'));
  }

  /**
   * Trusted-transport path: the message was fetched from the BlueBubbles server over its
   * password-authenticated REST API, so the sender is platform_signed. Returns `null` for messages
   * to ignore (our own, tapbacks, group chats, SMS/RCS, empty); throws InboundRejectedError for a
   * malformed message we would otherwise handle.
   */
  fromBlueBubblesMessage(connection: ConnectionContext, raw: unknown): VerifiedInbound<IMessageInboundPayload> | null {
    let message: BlueBubblesMessage | null;
    try {
      message = parseBlueBubblesMessage(raw);
    } catch (err) {
      throw new InboundRejectedError('MALFORMED', (err as Error).message.slice(0, 200));
    }
    if (!message) return null;
    return {
      connection,
      providerEventId: message.guid,
      senderAuth: 'platform_signed',
      payload: { message },
      receivedAt: this.now().toISOString(),
    };
  }

  async normaliseInbound(v: VerifiedInbound<IMessageInboundPayload>): Promise<InboundMessageV1> {
    const { connection, payload } = v;
    const { message } = payload;
    const chatGuid = message.chats[0]!.guid;
    const attachments: InboundAttachment[] = [];
    const files = message.attachments.filter((f) => (f.totalBytes ?? 0) <= MAX_ATTACHMENT_BYTES).slice(0, MAX_FILES_PER_MESSAGE);
    for (const f of files) {
      // A failed download throws: no expense is created without its evidence, and the poll retries.
      const dl = await this.client.downloadAttachment(f.guid, MAX_ATTACHMENT_BYTES);
      const headerMime = dl.contentType ? normaliseMime(dl.contentType) : '';
      const declaredMime = f.mimeType ? normaliseMime(f.mimeType) : '';
      const mime = [headerMime, declaredMime].find((m) => SUPPORTED_MIME.has(m)) ?? (headerMime || declaredMime || 'application/octet-stream');
      const screen = screenAttachment(mime, dl.bytes);
      const stored = await this.evidence.put(connection.tenantId, dl.bytes);
      attachments.push({
        sha256: stored.sha256,
        mime,
        sizeBytes: stored.sizeBytes,
        storageKey: stored.storageKey,
        filename: sanitiseShort(f.transferName, 255),
        scan: screen.scan,
        scanNote: screen.note,
      });
    }
    // One chat per person and no threading: a text-only message can answer the chat's one open
    // question, so it carries the chat thread id. A message with an attachment is always a new
    // expense, so it must not correlate to an open question through the thread.
    const hasAttachments = attachments.length > 0;
    return inboundMessageV1Schema.parse({
      schema: 'swipeback.inbound.v1',
      tenantId: connection.tenantId,
      channel: 'imessage',
      connectionId: connection.connectionId,
      providerEventId: v.providerEventId,
      dedupeKey: dedupeKeyFor('imessage', connection.connectionId, v.providerEventId),
      receivedAt: v.receivedAt,
      providerTimestamp: new Date(message.dateCreated).toISOString(),
      // Identity comes only from the sender handle; display names are never read.
      sender: { channelAddress: imessageChannelAddress(message.handle!.address), displayName: null, authentication: 'platform_signed' },
      conversation: {
        threadId: hasAttachments ? null : `imessage:${chatGuid}`,
        messageId: message.guid,
        inReplyTo: null,
        references: [],
        correlationToken: null,
      },
      subject: null,
      text: sanitiseUntrustedText(message.text ?? ''),
      attachments,
      action: null,
      consent: { source: 'bot_dm', scope: 'imessage' },
      autoGenerated: false,
      correlationId: randomUUID(),
    } satisfies InboundMessageV1);
  }

  async sendMessage(message: OutboundEnvelope): Promise<SendResult> {
    const body = [message.subject?.trim(), message.text].filter(Boolean).join('\n\n');
    return this.post(message, body);
  }

  async sendApprovalRequest(request: ApprovalRequest): Promise<SendResult> {
    // Approvals are not done in iMessage: point to the authenticated review page, which never approves by itself.
    const body = [request.subject?.trim(), request.text].filter(Boolean).join('\n\n');
    return this.post(request, `${body}\n\nReview and decide in the Swipeback app (sign-in required): ${request.reviewUrl}`);
  }

  private async post(message: OutboundEnvelope, text: string): Promise<SendResult> {
    const to = /^imessage:(?<handle>.+)$/.exec(message.to)?.groups?.handle;
    if (!to) throw new Error('recipient is not an iMessage address');
    // Reply into the existing chat when the inbound message established it; otherwise open the
    // 1:1 chat with the recipient. The user messages first, so the chat already exists.
    const fromThread = message.threadId?.startsWith('imessage:') ? message.threadId.slice('imessage:'.length) : null;
    const chatGuid = fromThread ?? imessageDmChatGuid(to);
    const sent = await this.client.sendText({ chatGuid, text });
    return { providerMessageId: sent.guid, threadId: `imessage:${chatGuid}` };
  }
}
