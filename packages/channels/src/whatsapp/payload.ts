import { z } from 'zod';

/**
 * Meta WhatsApp Cloud API webhook body. One POST may carry several messages and status updates,
 * possibly for several phone numbers; only `messages` changes for our number matter. Unknown
 * fields are tolerated (Meta adds fields without notice) but everything we read is validated.
 */

const mediaSchema = z.object({
  id: z.string().min(1).max(200),
  mime_type: z.string().max(127).optional(),
  sha256: z.string().max(200).optional(),
  caption: z.string().max(5_000).optional(),
  filename: z.string().max(255).optional(),
});

export const waMessageSchema = z.looseObject({
  from: z.string().regex(/^\d{5,20}$/),
  id: z.string().min(1).max(200),
  timestamp: z.string().regex(/^\d{1,12}$/),
  type: z.string().min(1).max(50),
  text: z.object({ body: z.string().max(50_000) }).optional(),
  image: mediaSchema.optional(),
  document: mediaSchema.optional(),
  context: z.looseObject({ id: z.string().max(200).optional() }).optional(),
});
export type WaMessage = z.infer<typeof waMessageSchema>;

const waValueSchema = z.looseObject({
  metadata: z.looseObject({ phone_number_id: z.string().min(1).max(64), display_phone_number: z.string().max(64).optional() }),
  contacts: z.array(z.looseObject({ wa_id: z.string().max(64).optional(), profile: z.looseObject({ name: z.string().max(500).optional() }).optional() })).optional(),
  messages: z.array(z.unknown()).optional(),
  statuses: z.array(z.unknown()).optional(),
});

export const waWebhookSchema = z.looseObject({
  object: z.literal('whatsapp_business_account'),
  entry: z.array(z.looseObject({ changes: z.array(z.looseObject({ field: z.string(), value: z.unknown() })).default([]) })).max(100),
});

/** The message types Swipeback acts on. Everything else (stickers, audio, reactions...) is ignored. */
export const SUPPORTED_TYPES = ['text', 'image', 'document'] as const;

/** One user message, with the context it arrived in. */
export interface WaIncoming {
  phoneNumberId: string;
  message: WaMessage;
  contactName: string | null;
}

export interface WaBatch {
  /** Every phone_number_id mentioned in the body (messages and statuses). */
  phoneNumberIds: string[];
  /** Messages for `phoneNumberId` that we can process. */
  messages: WaIncoming[];
  /** Status updates, unsupported types and messages for other numbers: recorded, never answered. */
  ignored: number;
}

/** Split a validated webhook body into the messages for one phone number. Throws zod errors if malformed. */
export function splitWebhook(body: unknown, phoneNumberId: string): WaBatch {
  const parsed = waWebhookSchema.parse(body);
  const batch: WaBatch = { phoneNumberIds: [], messages: [], ignored: 0 };
  for (const entry of parsed.entry) {
    for (const change of entry.changes) {
      if (change.field !== 'messages') continue;
      const value = waValueSchema.parse(change.value);
      const pid = value.metadata.phone_number_id;
      if (!batch.phoneNumberIds.includes(pid)) batch.phoneNumberIds.push(pid);
      const count = (value.messages?.length ?? 0) + (value.statuses?.length ?? 0);
      if (pid !== phoneNumberId) {
        batch.ignored += count;
        continue;
      }
      batch.ignored += value.statuses?.length ?? 0;
      for (const raw of value.messages ?? []) {
        const message = waMessageSchema.parse(raw);
        if (!(SUPPORTED_TYPES as readonly string[]).includes(message.type) || !hasPayloadFor(message)) {
          batch.ignored += 1;
          continue;
        }
        const contact = value.contacts?.find((c) => c.wa_id === message.from);
        batch.messages.push({ phoneNumberId: pid, message, contactName: contact?.profile?.name ?? null });
      }
    }
  }
  return batch;
}

function hasPayloadFor(m: WaMessage): boolean {
  if (m.type === 'text') return m.text !== undefined;
  if (m.type === 'image') return m.image !== undefined;
  return m.document !== undefined;
}
