import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
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
import {
  parseSlackMessageEvent,
  slackEventCallbackSchema,
  slackEventsPayloadSchema,
  slackSocketEnvelopeSchema,
  stripSlackMentions,
  type SlackInboundPayload,
} from './payload.ts';
import type { SlackClient } from './web-api.ts';

/**
 * Slack direct messages as a channel. Inbound arrives over Socket Mode (authenticated by the
 * app-level token over TLS; see `fromSocketEnvelope`) or, for the generic /api/inbox route, as a
 * request signed with the Slack signing secret (see `verifyInbound`). Replies go back into a thread
 * under the employee's message. Adapters never touch expenses, approvals or payouts.
 */

export const SLACK_SIGNATURE_HEADER = 'x-slack-signature';
export const SLACK_TIMESTAMP_HEADER = 'x-slack-request-timestamp';
const MAX_SKEW_SECONDS = 300;
const MAX_FILES_PER_MESSAGE = 5;

export function signSlackRequest(signingSecret: string, body: string, unixSeconds: number): string {
  return `v0=${createHmac('sha256', signingSecret).update(`v0:${unixSeconds}:${body}`).digest('hex')}`;
}

const SLACK_ADDRESS_RE = /^slack:([a-z0-9]+):([a-z0-9]+)$/i;
const SLACK_THREAD_RE = /^slack:([A-Z0-9]+):(\d{1,12}\.\d{1,8})$/i;

/** `slack:<team>:<user>`, lower-case: the exact format stored in channel_identities.channel_address. */
export function slackChannelAddress(teamId: string, userId: string): string {
  return `slack:${teamId}:${userId}`.toLowerCase();
}

export class SlackAdapter implements ChannelAdapter<SlackInboundPayload> {
  readonly channel = 'slack' as const;
  readonly provider = 'slack-bot';
  readonly capabilities = {
    attachments: true,
    threading: true,
    interactiveActions: false,
    deliveryReceipts: false,
    businessInitiatedMessages: 'free',
  } as const;

  constructor(
    private readonly evidence: EvidenceStore,
    private readonly client: SlackClient,
    /** May be empty: HTTP-delivered Slack requests are then always rejected. */
    private readonly signingSecret: string = '',
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** HTTP path (generic /api/inbox route): requires a valid Slack request signature. */
  async verifyInbound(connection: ConnectionContext, raw: RawInbound): Promise<VerifiedInbound<SlackInboundPayload>> {
    if (!this.signingSecret) throw new InboundRejectedError('BAD_SIGNATURE', 'no Slack signing secret configured');
    const given = /^v0=([0-9a-f]{64})$/.exec(raw.headers[SLACK_SIGNATURE_HEADER] ?? '');
    const tsHeader = /^\d{1,12}$/.exec(raw.headers[SLACK_TIMESTAMP_HEADER] ?? '');
    if (!given || !tsHeader) throw new InboundRejectedError('BAD_SIGNATURE', 'missing or malformed signature');
    const ts = Number(tsHeader[0]);
    if (Math.abs(this.now().getTime() / 1000 - ts) > MAX_SKEW_SECONDS) throw new InboundRejectedError('STALE_TIMESTAMP');
    const expected = Buffer.from(signSlackRequest(this.signingSecret, raw.body.toString('utf8'), ts).slice(3), 'hex');
    const actual = Buffer.from(given[1]!, 'hex');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new InboundRejectedError('BAD_SIGNATURE');

    let parsed;
    try {
      parsed = slackEventCallbackSchema.parse(JSON.parse(raw.body.toString('utf8')));
    } catch (err) {
      throw new InboundRejectedError('MALFORMED', (err as Error).message.slice(0, 200));
    }
    const verified = this.verifiedFromPayload(connection, parsed);
    if (!verified) throw new InboundRejectedError('NOT_ADDRESSED_TO_CONNECTION', 'event ignored');
    return verified;
  }

  /**
   * Socket Mode path. The transport is authenticated by the app-level token, so there is no
   * per-event signature. Returns `null` for events to ignore (bots, edits, non-DMs, empty
   * messages); throws InboundRejectedError for a wrong workspace or a malformed message.
   */
  fromSocketEnvelope(connection: ConnectionContext, envelope: unknown): VerifiedInbound<SlackInboundPayload> | null {
    const env = slackSocketEnvelopeSchema.safeParse(envelope);
    if (!env.success || env.data.type !== 'events_api') return null;
    const payload = slackEventsPayloadSchema.safeParse(env.data.payload);
    if (!payload.success) throw new InboundRejectedError('MALFORMED', 'events_api envelope without a valid payload');
    return this.verifiedFromPayload(connection, payload.data);
  }

  private verifiedFromPayload(
    connection: ConnectionContext,
    payload: { team_id: string; event_id?: string | undefined; event: unknown },
  ): VerifiedInbound<SlackInboundPayload> | null {
    if (payload.team_id.toLowerCase() !== connection.address.toLowerCase()) throw new InboundRejectedError('NOT_ADDRESSED_TO_CONNECTION', 'event is for another workspace');
    let event;
    try {
      event = parseSlackMessageEvent(payload.event);
    } catch (err) {
      throw new InboundRejectedError('MALFORMED', (err as Error).message.slice(0, 200));
    }
    if (!event) return null;
    // Nothing to process: no file and no text beyond mentions.
    const hasFile = event.files.some((f) => !!f.url_private_download);
    if (!hasFile && !sanitiseUntrustedText(stripSlackMentions(event.text)).sanitised) return null;
    return {
      connection,
      providerEventId: `${event.channel}:${event.ts}`,
      senderAuth: 'platform_signed',
      payload: { teamId: payload.team_id, eventId: payload.event_id ?? null, event },
      receivedAt: this.now().toISOString(),
    };
  }

  async normaliseInbound(v: VerifiedInbound<SlackInboundPayload>): Promise<InboundMessageV1> {
    const { connection, payload } = v;
    const { event } = payload;
    const attachments: InboundAttachment[] = [];
    const files = event.files.filter((f) => !!f.url_private_download && (f.size ?? 0) <= MAX_ATTACHMENT_BYTES).slice(0, MAX_FILES_PER_MESSAGE);
    for (const f of files) {
      // A failed download throws: no expense is created without its evidence, and the event is retried.
      const dl = await this.client.downloadFile(f.url_private_download!, MAX_ATTACHMENT_BYTES);
      const headerMime = dl.contentType ? normaliseMime(dl.contentType) : '';
      const mime = headerMime && headerMime !== 'application/octet-stream' ? headerMime : normaliseMime(f.mimetype ?? 'application/octet-stream');
      const screen = screenAttachment(mime, dl.bytes);
      const stored = await this.evidence.put(connection.tenantId, dl.bytes);
      attachments.push({
        sha256: stored.sha256,
        mime,
        sizeBytes: stored.sizeBytes,
        storageKey: stored.storageKey,
        filename: sanitiseShort(f.name, 255),
        scan: screen.scan,
        scanNote: screen.note,
      });
    }
    const root = event.thread_ts ?? event.ts;
    return inboundMessageV1Schema.parse({
      schema: 'swipeback.inbound.v1',
      tenantId: connection.tenantId,
      channel: 'slack',
      connectionId: connection.connectionId,
      providerEventId: v.providerEventId,
      dedupeKey: dedupeKeyFor('slack', connection.connectionId, v.providerEventId),
      receivedAt: v.receivedAt,
      providerTimestamp: new Date(Math.floor(Number(event.ts) * 1000)).toISOString(),
      // Identity comes only from the Slack user id; profile names are never read.
      sender: { channelAddress: slackChannelAddress(payload.teamId, event.user), displayName: null, authentication: 'platform_signed' },
      conversation: {
        threadId: `slack:${event.channel}:${root}`,
        messageId: event.ts,
        inReplyTo: event.thread_ts ?? null,
        references: [],
        correlationToken: null,
      },
      subject: null,
      text: sanitiseUntrustedText(stripSlackMentions(event.text)),
      attachments,
      action: null,
      consent: { source: 'bot_dm', scope: `slack:${payload.teamId}`.toLowerCase() },
      autoGenerated: false,
      correlationId: randomUUID(),
    } satisfies InboundMessageV1);
  }

  async sendMessage(message: OutboundEnvelope): Promise<SendResult> {
    const body = [message.subject?.trim(), message.text].filter(Boolean).join('\n\n');
    // Follow-up questions carry a reply token; tell the employee where to answer.
    return this.post(message, message.replyToken ? `${body}\n\nReply in this thread.` : body);
  }

  async sendApprovalRequest(request: ApprovalRequest): Promise<SendResult> {
    // Approvals are not done in Slack: point to the authenticated review page, which never approves by itself.
    const body = [request.subject?.trim(), request.text].filter(Boolean).join('\n\n');
    return this.post(request, `${body}\n\nReview and decide in the Swipeback app (sign-in required): ${request.reviewUrl}`);
  }

  private async post(message: OutboundEnvelope, text: string): Promise<SendResult> {
    const to = SLACK_ADDRESS_RE.exec(message.to);
    if (!to) throw new Error('recipient is not a Slack address');
    // `from` is the connection address (the workspace id): never post into a different workspace.
    if (to[1]!.toLowerCase() !== message.from.toLowerCase()) throw new Error('recipient belongs to another Slack workspace');
    const channel = await this.client.openConversation(to[2]!.toUpperCase());
    const thread = message.threadId ? SLACK_THREAD_RE.exec(message.threadId) : null;
    const threadTs = thread && thread[1]!.toUpperCase() === channel.toUpperCase() ? thread[2] : undefined;
    const posted = await this.client.postMessage({ channel, text, threadTs });
    // The thread id uses the root ts so later replies in the thread correlate with this expense.
    return { providerMessageId: posted.ts, threadId: `slack:${posted.channel}:${threadTs ?? posted.ts}` };
  }
}
