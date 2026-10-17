import { z } from 'zod';

/**
 * Slack payload shapes. Everything here is untrusted input: schemas bound sizes and formats, and
 * unknown fields are dropped. Events we do not handle are ignored rather than rejected.
 */

export const slackFileSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().max(1000).nullish(),
  mimetype: z.string().max(255).nullish(),
  size: z.number().nonnegative().nullish(),
  url_private_download: z.string().max(2000).nullish(),
});
export type SlackFile = z.infer<typeof slackFileSchema>;

export const slackMessageEventSchema = z.object({
  type: z.literal('message'),
  subtype: z.string().max(64).optional(),
  user: z.string().regex(/^[UW][A-Z0-9]{2,31}$/),
  channel: z.string().regex(/^D[A-Z0-9]{2,31}$/),
  channel_type: z.literal('im'),
  ts: z.string().regex(/^\d{1,12}\.\d{1,8}$/),
  thread_ts: z.string().regex(/^\d{1,12}\.\d{1,8}$/).optional(),
  text: z.string().max(50_000).default(''),
  files: z.array(slackFileSchema).max(50).default([]),
});
export type SlackMessageEvent = z.infer<typeof slackMessageEventSchema>;

/** The `payload` of a Socket Mode `events_api` envelope, and the body of an Events API request. */
export const slackEventsPayloadSchema = z.object({
  team_id: z.string().regex(/^[A-Z0-9]{2,32}$/),
  event_id: z.string().max(64).optional(),
  event: z.unknown(),
});

export const slackSocketEnvelopeSchema = z.object({
  type: z.string().max(64),
  envelope_id: z.string().min(1).max(128).optional(),
  payload: z.unknown().optional(),
  retry_attempt: z.number().int().nonnegative().optional(),
});
export type SlackSocketEnvelope = z.infer<typeof slackSocketEnvelopeSchema>;

export const slackEventCallbackSchema = slackEventsPayloadSchema.extend({ type: z.literal('event_callback') });

/** What the adapter carries from verification to normalisation. */
export interface SlackInboundPayload {
  teamId: string;
  eventId: string | null;
  event: SlackMessageEvent;
}

const HANDLED_SUBTYPES = new Set([undefined, 'file_share']);

/**
 * Returns the message event, or `null` when it should be ignored: other event types, bot posts
 * (including our own replies, which prevents reply loops), edits, deletions, joins, non-DM channels.
 * Throws a ZodError when it is a message we would handle but it is malformed.
 */
export function parseSlackMessageEvent(event: unknown): SlackMessageEvent | null {
  if (typeof event !== 'object' || event === null) return null;
  const e = event as Record<string, unknown>;
  if (e.type !== 'message') return null;
  if (e.bot_id !== undefined && e.bot_id !== null) return null;
  if (!HANDLED_SUBTYPES.has(e.subtype as string | undefined)) return null;
  if (e.channel_type !== 'im') return null;
  return slackMessageEventSchema.parse(e);
}

/** Remove `<@U123>` / `<@U123|name>` mentions. Other Slack markup is left as-is, as data. */
export function stripSlackMentions(text: string): string {
  return text.replace(/<@[UW][A-Z0-9]+(?:\|[^>]*)?>/g, '');
}
