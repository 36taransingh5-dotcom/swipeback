import { InboundRejectedError, MetaGraphClient, WhatsAppCloudAdapter, type EvidenceStore, type RawInbound } from '@swipeback/channels';
import { appendAudit } from '@swipeback/db';
import type { EngineDeps } from './deps.ts';
import { ingestInbound, loadConnection } from './inbound.ts';

/**
 * Batch intake for the WhatsApp Cloud API. Meta delivers several messages and status updates in one
 * POST, while `receiveInbound` handles exactly one event, so this verifies the webhook once and then
 * feeds every message through the same channel-neutral `ingestInbound`. Nothing here decides
 * anything about an expense.
 */

export type WhatsAppReceiveOutcome =
  | { status: 'PROCESSED'; accepted: number; duplicates: number; ignored: number; rejected: number }
  | { status: 'REJECTED'; reason: string };

/** Registered only when the access token, phone number id and app secret are all set (like Gmail). */
export function whatsappAdapterFromEnv(env: NodeJS.ProcessEnv, evidence: EvidenceStore): WhatsAppCloudAdapter | null {
  const { SB_WHATSAPP_ACCESS_TOKEN: accessToken, SB_WHATSAPP_PHONE_NUMBER_ID: phoneNumberId, SB_WHATSAPP_APP_SECRET: appSecret, SB_WHATSAPP_GRAPH_VERSION: graphVersion } = env;
  if (!accessToken || !phoneNumberId || !appSecret) return null;
  return new WhatsAppCloudAdapter(evidence, new MetaGraphClient({ accessToken, phoneNumberId, ...(graphVersion ? { graphVersion } : {}) }), appSecret);
}

/** The connection id in the webhook URL is unknown or not ACTIVE. The route answers 404. */
export class WhatsAppConnectionError extends Error {
  override readonly name = 'WhatsAppConnectionError';
}

export async function receiveWhatsAppWebhook(deps: EngineDeps, connectionId: string, raw: RawInbound): Promise<WhatsAppReceiveOutcome> {
  let conn: Awaited<ReturnType<typeof loadConnection>>;
  try {
    conn = await loadConnection(deps, connectionId);
  } catch (err) {
    if (err instanceof Error && /^(unknown connection|connection \S+ is )/.test(err.message)) throw new WhatsAppConnectionError(err.message);
    throw err;
  }
  const adapter = deps.channels.adapterFor(conn.provider);
  if (!(adapter instanceof WhatsAppCloudAdapter)) throw new WhatsAppConnectionError(`connection ${connectionId} is not a WhatsApp connection`);

  const reject = async (err: InboundRejectedError) => {
    await appendAudit(deps.pool, {
      organisationId: conn.tenantId, actorType: 'channel', actorId: conn.provider, action: 'inbound.rejected',
      entityType: 'channel_connection', entityId: connectionId, after: { reason: err.reason, detail: err.message.slice(0, 200) },
    });
  };

  let batch: ReturnType<WhatsAppCloudAdapter['verifyWebhook']>;
  try {
    batch = adapter.verifyWebhook(conn, raw);
  } catch (err) {
    if (!(err instanceof InboundRejectedError)) throw err;
    // Not for our number: acknowledge quietly so Meta does not retry, and do not audit noise.
    if (err.reason === 'NOT_ADDRESSED_TO_CONNECTION') return { status: 'PROCESSED', accepted: 0, duplicates: 0, ignored: 1, rejected: 0 };
    await reject(err);
    return { status: 'REJECTED', reason: err.reason };
  }

  const out = { accepted: 0, duplicates: 0, ignored: batch.ignored, rejected: 0 };
  for (const verified of batch.messages) {
    try {
      // Any non-rejection error here (media download, database) propagates so the webhook returns
      // 5xx and Meta retries; the dedupe key makes the retry safe for messages already ingested.
      const event = await adapter.normaliseInbound(verified);
      const r = await ingestInbound(deps, event);
      if (r.duplicate) out.duplicates += 1;
      else out.accepted += 1;
    } catch (err) {
      if (!(err instanceof InboundRejectedError)) throw err;
      await reject(err);
      out.rejected += 1;
    }
  }
  return { status: 'PROCESSED', ...out };
}
