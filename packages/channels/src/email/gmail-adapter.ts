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
import type { GmailApi } from './gmail-api.ts';
import { addressMatchesConnection, buildOutboundMime, newMessageId, parseEmail, plusAddress, senderAuthentication, type ParsedEmail } from './mime.ts';
import { normaliseEmail } from './normalise.ts';

/** Gmail's receiving servers stamp Authentication-Results with this authserv-id. */
export const GMAIL_AUTHSERV_IDS = ['mx.google.com'] as const;

/**
 * Live Gmail transport for a connected, designated finance mailbox. Messages are fetched by the
 * poller through the authenticated Gmail API (that is the inbound authenticity proof); sender
 * identity still requires Google's own DKIM/DMARC verdict, aligned with the From domain.
 */
export class GmailAdapter implements ChannelAdapter<ParsedEmail> {
  readonly channel = 'email' as const;
  readonly provider = 'gmail';
  readonly capabilities = {
    attachments: true,
    threading: true,
    interactiveActions: false,
    deliveryReceipts: false,
    businessInitiatedMessages: 'free',
  } as const;

  constructor(
    private readonly evidence: EvidenceStore,
    private readonly gmailFor: (connectionId: string) => Promise<GmailApi>,
  ) {}

  async verifyInbound(connection: ConnectionContext, raw: RawInbound): Promise<VerifiedInbound<ParsedEmail>> {
    if (!raw.providerMessageId || !raw.providerThreadId) throw new InboundRejectedError('MALFORMED', 'gmail message id and thread id required');
    if (raw.body.byteLength > 30 * 1024 * 1024) throw new InboundRejectedError('TOO_LARGE');
    let email: ParsedEmail;
    try {
      email = await parseEmail(raw.body);
    } catch (err) {
      throw new InboundRejectedError('MALFORMED', (err as Error).message);
    }
    if (!email.from) throw new InboundRejectedError('MALFORMED', 'missing From');
    if (!email.recipients.some((r) => addressMatchesConnection(r, connection.address))) throw new InboundRejectedError('NOT_ADDRESSED_TO_CONNECTION');
    return {
      connection,
      providerEventId: `gmail:${raw.providerMessageId}`,
      senderAuth: senderAuthentication(email, GMAIL_AUTHSERV_IDS),
      payload: Object.assign(email, { gmailThreadId: raw.providerThreadId }),
      receivedAt: new Date().toISOString(),
    };
  }

  async normaliseInbound(v: VerifiedInbound<ParsedEmail>): Promise<InboundMessageV1> {
    return normaliseEmail({
      connection: v.connection,
      email: v.payload,
      senderAuth: v.senderAuth,
      providerEventId: v.providerEventId,
      threadId: (v.payload as ParsedEmail & { gmailThreadId: string }).gmailThreadId,
      receivedAt: v.receivedAt,
      evidence: this.evidence,
    });
  }

  async sendMessage(message: OutboundEnvelope): Promise<SendResult> {
    return this.send(message);
  }

  async sendApprovalRequest(request: ApprovalRequest): Promise<SendResult> {
    return this.send({ ...request, text: `${request.text}\n\nReview and decide (sign-in required): ${request.reviewUrl}` });
  }

  private async send(m: OutboundEnvelope): Promise<SendResult> {
    const gmail = await this.gmailFor(m.connectionId);
    const rfcMessageId = newMessageId(m.from.split('@')[1] ?? 'swipeback.local');
    const mime = buildOutboundMime({
      from: m.from,
      fromName: 'Swipeback (SYNTHETIC DEMO)',
      to: m.to,
      replyTo: m.replyToken ? plusAddress(m.from, m.replyToken) : null,
      subject: m.subject ?? 'Swipeback',
      text: m.text,
      messageId: rfcMessageId,
      inReplyTo: m.inReplyTo,
      references: m.references,
    });
    const sent = await gmail.send(mime, m.threadId);
    return { providerMessageId: sent.id, threadId: sent.threadId, rfcMessageId };
  }
}
