import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  BlueBubblesAdapter,
  BlueBubblesRestClient,
  InboundRejectedError,
  type BlueBubblesClient,
  type EvidenceStore,
} from '@swipeback/channels';
import { appendAudit } from '@swipeback/db';
import type { EngineDeps } from './deps.ts';
import { ingestInbound, loadConnection, type ReceiveOutcome } from './inbound.ts';

/**
 * iMessage glue. The adapter turns BlueBubbles messages into InboundMessage v1; everything after
 * that is the channel-neutral engine. There is no inbound webhook (BlueBubbles webhooks are
 * unsigned): the engine polls the server, exactly like Slack's socket loop, so no tunnel and no
 * public URL is needed and nothing on the network can inject a message.
 */

/** The iMessage adapter, or `null` when SB_BLUEBUBBLES_URL is unset (everything else behaves as before). */
export function bluebubblesAdapterFromEnv(env: NodeJS.ProcessEnv, evidence: EvidenceStore): BlueBubblesAdapter | null {
  const url = env.SB_BLUEBUBBLES_URL;
  if (!url) return null;
  const password = env.SB_BLUEBUBBLES_PASSWORD;
  if (!password) throw new Error('SB_BLUEBUBBLES_PASSWORD is required when SB_BLUEBUBBLES_URL is set (see docs/imessage/SETUP.md)');
  return new BlueBubblesAdapter(evidence, new BlueBubblesRestClient(url, password));
}

/** Normalise and ingest one message fetched from the BlueBubbles server (trusted transport). */
export async function receiveBlueBubblesMessage(deps: EngineDeps, connectionId: string, raw: unknown): Promise<ReceiveOutcome> {
  const conn = await loadConnection(deps, connectionId);
  const adapter = deps.channels.adapterFor(conn.provider);
  if (conn.channel !== 'imessage' || !(adapter instanceof BlueBubblesAdapter)) throw new Error(`connection ${connectionId} is not an iMessage connection`);
  try {
    const verified = adapter.fromBlueBubblesMessage(conn, raw);
    if (!verified) return { status: 'IGNORED', reason: 'message not handled' };
    const event = await adapter.normaliseInbound(verified);
    const r = await ingestInbound(deps, event);
    return { status: 'ACCEPTED', ...r };
  } catch (err) {
    if (!(err instanceof InboundRejectedError)) {
      // Fail closed and loud: a transient failure (attachment download, database) is audited and
      // retried by the poller; no expense is created without its evidence.
      await appendAudit(deps.pool, {
        organisationId: conn.tenantId, actorType: 'channel', actorId: conn.provider, action: 'inbound.failed',
        entityType: 'channel_connection', entityId: connectionId, after: { detail: (err as Error).message.slice(0, 200) },
      });
      throw err;
    }
    if (err.reason === 'NOT_ADDRESSED_TO_CONNECTION') return { status: 'IGNORED', reason: err.reason };
    await appendAudit(deps.pool, {
      organisationId: conn.tenantId, actorType: 'channel', actorId: conn.provider, action: 'inbound.rejected',
      entityType: 'channel_connection', entityId: connectionId, after: { reason: err.reason, detail: err.message.slice(0, 200) },
    });
    return { status: 'REJECTED', reason: err.reason };
  }
}

/** The poller's high-water mark: never ingest history, so a missing cursor starts at "now". */
export async function readIMessageCursor(file: string, now: () => Date = () => new Date()): Promise<number> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as { lastDateCreatedMs?: unknown };
    if (typeof parsed.lastDateCreatedMs === 'number' && Number.isFinite(parsed.lastDateCreatedMs)) return parsed.lastDateCreatedMs;
  } catch {
    // absent or unreadable: start now
  }
  return now().getTime();
}

export async function writeIMessageCursor(file: string, lastDateCreatedMs: number): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, `${JSON.stringify({ lastDateCreatedMs })}\n`);
  await rename(tmp, file);
}

export interface BlueBubblesPollerOptions {
  signal: AbortSignal;
  /** JSON file under SB_DATA_DIR, e.g. .data/imessage-cursor.json. */
  cursorFile: string;
  pollIntervalMs?: number;
  pageSize?: number;
  /** Delay after a failed poll; doubles per consecutive failure up to retryMaxMs. */
  retryBaseMs?: number;
  retryMaxMs?: number;
  log?: (message: string) => void;
  now?: () => Date;
}

/**
 * The polling loop: fetch messages newer than the cursor, process them oldest first, persist the
 * cursor after each one. Dedupe is by message guid, so a crash between ingest and the cursor write
 * is harmless. Survives malformed messages and server outages (backoff), and stops cleanly on abort.
 */
export async function runBlueBubblesPoller(deps: EngineDeps, connectionId: string, client: BlueBubblesClient, opts: BlueBubblesPollerOptions): Promise<void> {
  const { signal } = opts;
  const log = opts.log ?? ((m: string) => console.error(`[imessage] ${m}`));
  const now = opts.now ?? (() => new Date());
  const pollInterval = opts.pollIntervalMs ?? 5000;
  const retryBase = opts.retryBaseMs ?? 1000;
  const retryMax = opts.retryMaxMs ?? 60_000;

  let cursor = await readIMessageCursor(opts.cursorFile, now);
  let failures = 0;
  while (!signal.aborted) {
    try {
      const messages = await client.queryMessages({ afterMs: cursor, limit: opts.pageSize ?? 50 });
      for (const raw of messages) {
        if (signal.aborted) break;
        const outcome = await receiveBlueBubblesMessage(deps, connectionId, raw);
        if (outcome.status === 'REJECTED') log(`message rejected: ${outcome.reason}`);
        const dateCreated = (raw as { dateCreated?: unknown }).dateCreated;
        if (typeof dateCreated === 'number' && dateCreated > cursor) {
          cursor = dateCreated;
          await writeIMessageCursor(opts.cursorFile, cursor);
        }
      }
      failures = 0;
      await sleep(pollInterval, signal);
    } catch (err) {
      failures++;
      log(`poll failed (attempt ${failures}): ${(err as Error).message.slice(0, 200)}`);
      await sleep(Math.min(retryMax, retryBase * 2 ** Math.max(0, failures - 1)), signal);
    }
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}
