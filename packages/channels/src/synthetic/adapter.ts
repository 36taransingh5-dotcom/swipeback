import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
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
import { dedupeKeyFor, normaliseMime, sanitiseShort, sanitiseUntrustedText, screenAttachment } from '../sanitise.ts';
import type { OutboundSink } from '../sink.ts';

/**
 * A synthetic chat channel with Slack-style signed webhooks. It exists to prove the engine is
 * channel-neutral (PRD §17.6 P1): the same receipt through email and through this channel must
 * get the same decision. It is clearly a simulator, not a live messaging integration.
 */

export const SIGNATURE_HEADER = 'x-swipeback-signature';
const MAX_SKEW_SECONDS = 300;

export const syntheticPayloadSchema = z.object({
  eventId: z.string().min(1).max(200),
  from: z.string().regex(/^chat:[a-z0-9._-]{2,64}$/),
  displayName: z.string().max(200).optional(),
  threadId: z.string().max(200).optional(),
  text: z.string().max(50_000).default(''),
  sentAt: z.iso.datetime({ offset: true }),
  attachments: z
    .array(z.object({ filename: z.string().max(255), mime: z.string().max(127), dataBase64: z.string() }))
    .max(10)
    .default([]),
  action: z
    .object({ challengeId: z.string().min(1), nonce: z.string().min(1), verb: z.enum(['APPROVE', 'DECLINE', 'REQUEST_INFO']) })
    .optional(),
});
export type SyntheticPayload = z.infer<typeof syntheticPayloadSchema>;

export function signSyntheticRequest(secret: string, body: string, unixSeconds: number): string {
  const mac = createHmac('sha256', secret).update(`${unixSeconds}.${body}`).digest('hex');
  return `t=${unixSeconds},v1=${mac}`;
}

export class SyntheticChatAdapter implements ChannelAdapter<SyntheticPayload> {
  readonly channel = 'synthetic' as const;
  readonly provider = 'synthetic-chat';
  readonly capabilities = {
    attachments: true,
    threading: true,
    interactiveActions: true,
    deliveryReceipts: false,
    businessInitiatedMessages: 'free',
  } as const;

  constructor(
    private readonly evidence: EvidenceStore,
    private readonly sink: OutboundSink,
    private readonly signingSecret: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (signingSecret.length < 16) throw new Error('synthetic channel signing secret too short');
  }

  async verifyInbound(connection: ConnectionContext, raw: RawInbound): Promise<VerifiedInbound<SyntheticPayload>> {
    const header = raw.headers[SIGNATURE_HEADER] ?? '';
    const m = /^t=(\d{1,12}),v1=([0-9a-f]{64})$/.exec(header);
    if (!m) throw new InboundRejectedError('BAD_SIGNATURE', 'missing or malformed signature');
    const t = Number(m[1]);
    if (Math.abs(this.now().getTime() / 1000 - t) > MAX_SKEW_SECONDS) throw new InboundRejectedError('STALE_TIMESTAMP');
    const expected = Buffer.from(signSyntheticRequest(this.signingSecret, raw.body.toString('utf8'), t).slice(-64), 'hex');
    const given = Buffer.from(m[2]!, 'hex');
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw new InboundRejectedError('BAD_SIGNATURE');

    let payload: SyntheticPayload;
    try {
      payload = syntheticPayloadSchema.parse(JSON.parse(raw.body.toString('utf8')));
    } catch (err) {
      throw new InboundRejectedError('MALFORMED', (err as Error).message);
    }
    return {
      connection,
      providerEventId: payload.eventId,
      senderAuth: 'platform_signed',
      payload,
      receivedAt: this.now().toISOString(),
    };
  }

  async normaliseInbound(v: VerifiedInbound<SyntheticPayload>): Promise<InboundMessageV1> {
    const { connection, payload } = v;
    const attachments: InboundAttachment[] = [];
    for (const a of payload.attachments) {
      const bytes = Buffer.from(a.dataBase64, 'base64');
      const mime = normaliseMime(a.mime);
      const screen = screenAttachment(mime, bytes);
      const stored = await this.evidence.put(connection.tenantId, bytes);
      attachments.push({
        sha256: stored.sha256,
        mime,
        sizeBytes: stored.sizeBytes,
        storageKey: stored.storageKey,
        filename: sanitiseShort(a.filename, 255),
        scan: screen.scan,
        scanNote: screen.note,
      });
    }
    return inboundMessageV1Schema.parse({
      schema: 'swipeback.inbound.v1',
      tenantId: connection.tenantId,
      channel: 'synthetic',
      connectionId: connection.connectionId,
      providerEventId: payload.eventId,
      dedupeKey: dedupeKeyFor('synthetic', connection.connectionId, payload.eventId),
      receivedAt: v.receivedAt,
      providerTimestamp: payload.sentAt,
      sender: { channelAddress: payload.from.toLowerCase(), displayName: sanitiseShort(payload.displayName, 200), authentication: 'platform_signed' },
      conversation: {
        threadId: payload.threadId ?? payload.eventId,
        messageId: payload.eventId,
        inReplyTo: null,
        references: [],
        correlationToken: null,
      },
      subject: null,
      text: sanitiseUntrustedText(payload.text),
      attachments,
      action: payload.action ?? null,
      consent: { source: 'bot_dm', scope: `chat:${connection.address}` },
      autoGenerated: false,
      correlationId: randomUUID(),
    } satisfies InboundMessageV1);
  }

  async sendMessage(message: OutboundEnvelope): Promise<SendResult> {
    return this.send(message, 'message', null);
  }

  async sendApprovalRequest(request: ApprovalRequest): Promise<SendResult> {
    return this.send(request, 'approval_request', { reviewUrl: request.reviewUrl, actions: request.actions });
  }

  private async send(message: OutboundEnvelope, kind: 'message' | 'approval_request', extra: object | null): Promise<SendResult> {
    const providerMessageId = `chat-msg-${randomUUID()}`;
    const raw = JSON.stringify({ id: providerMessageId, to: message.to, threadId: message.threadId, text: message.text, ...extra });
    await this.sink.deliver({ envelope: message, providerMessageId, raw, kind });
    return { providerMessageId, threadId: message.threadId };
  }
}
