import { z } from 'zod';

/**
 * BlueBubbles REST payload shapes. Everything here is untrusted input from the server: schemas bound
 * sizes, and unknown fields are kept (`.passthrough()`) so a server update never breaks parsing.
 * Messages we do not handle are ignored rather than rejected.
 */

export const blueBubblesHandleSchema = z.object({ address: z.string().min(1).max(320) }).passthrough();

export const blueBubblesChatSchema = z
  .object({
    guid: z.string().min(1).max(200),
    /** iMessage chat style: 45 is a group chat. */
    style: z.number().int().nullish(),
    participants: z.array(blueBubblesHandleSchema).max(100).nullish(),
  })
  .passthrough();

export const blueBubblesAttachmentSchema = z
  .object({
    guid: z.string().min(1).max(200),
    mimeType: z.string().max(255).nullish(),
    transferName: z.string().max(1000).nullish(),
    totalBytes: z.number().nonnegative().nullish(),
  })
  .passthrough();

export const blueBubblesMessageSchema = z
  .object({
    guid: z.string().min(1).max(200),
    text: z.string().max(50_000).nullish(),
    /** Epoch milliseconds. */
    dateCreated: z.number().nonnegative(),
    isFromMe: z.boolean().default(false),
    service: z.string().max(64).nullish(),
    handle: blueBubblesHandleSchema.nullish(),
    chats: z.array(blueBubblesChatSchema).max(10).default([]),
    attachments: z.array(blueBubblesAttachmentSchema).max(50).default([]),
    /** Set on tapbacks/reactions, which are messages about another message. */
    associatedMessageGuid: z.string().max(200).nullish(),
    associatedMessageType: z.number().nullish(),
  })
  .passthrough();
export type BlueBubblesMessage = z.infer<typeof blueBubblesMessageSchema>;

const GROUP_CHAT_STYLE = 45;

/**
 * Returns the message, or `null` when it should be ignored: our own messages (anti-loop),
 * tapbacks/reactions, group chats, SMS/RCS (their sender ids are spoofable), and empty messages.
 * Throws a ZodError when it is a message we would handle but it is malformed.
 */
export function parseBlueBubblesMessage(raw: unknown): BlueBubblesMessage | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r.isFromMe === true) return null;
  if (r.associatedMessageGuid != null || (typeof r.associatedMessageType === 'number' && r.associatedMessageType !== 0)) return null;
  const message = blueBubblesMessageSchema.parse(raw);
  if (message.service !== 'iMessage') return null;
  const chat = message.chats[0];
  if (!chat) return null;
  if (chat.style === GROUP_CHAT_STYLE || (chat.participants?.length ?? 1) > 1) return null;
  if (!message.handle?.address) return null;
  if (!sanitisableText(message.text) && message.attachments.length === 0) return null;
  return message;
}

function sanitisableText(text: string | null | undefined): boolean {
  return !!text && text.trim().length > 0;
}
