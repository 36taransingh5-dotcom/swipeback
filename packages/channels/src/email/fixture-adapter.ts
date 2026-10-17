import type {
  ApprovalRequest,
  ChannelAdapter,
  ConnectionContext,
  InboundMessageV1,
  OutboundEnvelope,
  RawInbound,
  SendResult,
  VerifiedInbound,
} from '../contract.ts';
import { InboundRejectedError } from '../contract.ts';
import type { EvidenceStore } from '../evidence-store.ts';
import { sha256Hex } from '../sanitise.ts';
import type { OutboundSink } from '../sink.ts';
import {
  addressMatchesConnection,
  buildOutboundMime,
  newMessageId,
  parseEmail,
  plusAddress,
  senderAuthentication,
  type ParsedEmail,
} from './mime.ts';
import { normaliseEmail, rfcThreadRoot } from './normalise.ts';

export const FIXTURE_AUTHSERV_ID = 'fixture.swipeback.test';

/**
 * Email adapter over raw RFC 5322 messages (.eml) — used by tests, evaluation and offline replay.
 * It shares parsing, sender authentication and normalisation with the live Gmail adapter; only the
 * transport differs. Replayed fixtures are labelled as such and never presented as live mail.
 */
export class FixtureEmailAdapter implements ChannelAdapter<ParsedEmail> {
  readonly channel = 'email' as const;
  readonly provider: string = 'fixture';
  readonly capabilities = {
    attachments: true,
    threading: true,
    interactiveActions: false,
    deliveryReceipts: false,
    businessInitiatedMessages: 'free',
  } as const;

  constructor(
    private readonly evidence: EvidenceStore,
    private readonly sink: OutboundSink,
    private readonly opts: { trustedAuthservIds?: readonly string[]; messageIdDomain?: string } = {},
  ) {}

  async verifyInbound(connection: ConnectionContext, raw: RawInbound): Promise<VerifiedInbound<ParsedEmail>> {
    if (raw.body.byteLength > 25 * 1024 * 1024) throw new InboundRejectedError('TOO_LARGE');
    let email: ParsedEmail;
    try {
      email = await parseEmail(raw.body);
    } catch (err) {
      throw new InboundRejectedError('MALFORMED', (err as Error).message);
    }
    if (!email.from) throw new InboundRejectedError('MALFORMED', 'missing From');
    // Only mail sent to the designated finance address is processed; nothing else in a mailbox is read.
    if (!email.recipients.some((r) => addressMatchesConnection(r, connection.address))) {
      throw new InboundRejectedError('NOT_ADDRESSED_TO_CONNECTION');
    }
    return {
      connection,
      providerEventId: raw.providerMessageId ?? email.messageId ?? `sha256:${sha256Hex(raw.body)}`,
      senderAuth: senderAuthentication(email, this.opts.trustedAuthservIds ?? [FIXTURE_AUTHSERV_ID]),
      payload: email,
      receivedAt: new Date().toISOString(),
    };
  }

  async normaliseInbound(v: VerifiedInbound<ParsedEmail>): Promise<InboundMessageV1> {
    return normaliseEmail({
      connection: v.connection,
      email: v.payload,
      senderAuth: v.senderAuth,
      providerEventId: v.providerEventId,
      threadId: rfcThreadRoot(v.payload),
      receivedAt: v.receivedAt,
      evidence: this.evidence,
    });
  }

  async sendMessage(message: OutboundEnvelope): Promise<SendResult> {
    return this.send(message, 'message');
  }

  async sendApprovalRequest(request: ApprovalRequest): Promise<SendResult> {
    const text = `${request.text}\n\nReview and decide (sign-in required): ${request.reviewUrl}`;
    return this.send({ ...request, text }, 'approval_request');
  }

  private async send(message: OutboundEnvelope, kind: 'message' | 'approval_request'): Promise<SendResult> {
    const providerMessageId = newMessageId(this.opts.messageIdDomain ?? 'swipeback.test');
    const from = message.from;
    const raw = buildOutboundMime({
      from,
      fromName: 'Swipeback (SYNTHETIC DEMO)',
      to: message.to,
      replyTo: message.replyToken ? plusAddress(from, message.replyToken) : null,
      subject: message.subject ?? 'Swipeback',
      text: message.text,
      messageId: providerMessageId,
      inReplyTo: message.inReplyTo,
      references: message.references,
    });
    await this.sink.deliver({ envelope: message, providerMessageId, raw, kind });
    return { providerMessageId, threadId: message.threadId ?? providerMessageId, rfcMessageId: providerMessageId };
  }
}
