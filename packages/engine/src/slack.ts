import {
  InboundRejectedError,
  openSocketModeUrl,
  SlackAdapter,
  SlackWebClient,
  type EvidenceStore,
} from '@swipeback/channels';
import { appendAudit } from '@swipeback/db';
import type { EngineDeps } from './deps.ts';
import { ingestInbound, loadConnection, type ReceiveOutcome } from './inbound.ts';

/**
 * Slack glue. The adapter turns Slack payloads into InboundMessage v1; everything after that is the
 * channel-neutral engine. Socket Mode needs no public URL: events arrive over an outbound WebSocket.
 */

/** The Slack adapter, or `null` when SB_SLACK_BOT_TOKEN is unset (everything else behaves as before). */
export function slackAdapterFromEnv(env: NodeJS.ProcessEnv, evidence: EvidenceStore): SlackAdapter | null {
  const botToken = env.SB_SLACK_BOT_TOKEN;
  if (!botToken) return null;
  return new SlackAdapter(evidence, new SlackWebClient(botToken), env.SB_SLACK_SIGNING_SECRET ?? '');
}

/** Normalise and ingest one Socket Mode envelope from the trusted socket transport. */
export async function receiveSlackEvent(deps: EngineDeps, connectionId: string, envelope: unknown): Promise<ReceiveOutcome> {
  const conn = await loadConnection(deps, connectionId);
  const adapter = deps.channels.adapterFor(conn.provider);
  if (conn.channel !== 'slack' || !(adapter instanceof SlackAdapter)) throw new Error(`connection ${connectionId} is not a Slack connection`);
  try {
    const verified = adapter.fromSocketEnvelope(conn, envelope);
    if (!verified) return { status: 'IGNORED', reason: 'event not handled' };
    const event = await adapter.normaliseInbound(verified);
    const r = await ingestInbound(deps, event);
    return { status: 'ACCEPTED', ...r };
  } catch (err) {
    if (!(err instanceof InboundRejectedError)) throw err;
    if (err.reason === 'NOT_ADDRESSED_TO_CONNECTION') return { status: 'IGNORED', reason: err.reason };
    await appendAudit(deps.pool, {
      organisationId: conn.tenantId, actorType: 'channel', actorId: conn.provider, action: 'inbound.rejected',
      entityType: 'channel_connection', entityId: connectionId, after: { reason: err.reason, detail: err.message.slice(0, 200) },
    });
    return { status: 'REJECTED', reason: err.reason };
  }
}

/** The part of a WebSocket the loop uses; the global WebSocket satisfies it. */
export interface SocketLike {
  send(data: string): void;
  close(): void;
  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: { data?: unknown }) => void): void;
}

export interface SlackSocketOptions {
  signal: AbortSignal;
  /** Resolve a fresh wss:// URL (apps.connections.open). Default uses the app-level token. */
  openUrl?: () => Promise<string>;
  connect?: (url: string) => SocketLike;
  log?: (message: string) => void;
  /** Delay before reconnecting; doubles per consecutive failure up to retryMaxMs. */
  retryBaseMs?: number;
  retryMaxMs?: number;
  /** Attempts to process one event before giving up (Slack will not redeliver an acknowledged envelope). */
  eventAttempts?: number;
  eventRetryMs?: number;
}

/**
 * The Socket Mode loop. Acknowledges every envelope immediately (Slack requires it within 3 s), then
 * processes it. Reconnects with backoff on `disconnect` or a closed socket, never dies on one bad
 * event, and stops cleanly when the signal aborts. Resolves when stopped.
 */
export async function runSlackSocket(deps: EngineDeps, connectionId: string, appToken: string, opts: SlackSocketOptions): Promise<void> {
  const { signal } = opts;
  const log = opts.log ?? ((m: string) => console.error(`[slack] ${m}`));
  const openUrl = opts.openUrl ?? (() => openSocketModeUrl(appToken));
  const connect = opts.connect ?? ((url: string) => new WebSocket(url) as unknown as SocketLike);
  const retryBase = opts.retryBaseMs ?? 1000;
  const retryMax = opts.retryMaxMs ?? 30_000;
  const attempts = opts.eventAttempts ?? 3;
  const eventRetryMs = opts.eventRetryMs ?? 500;

  const handle = async (frame: unknown): Promise<void> => {
    for (let i = 1; i <= attempts && !signal.aborted; i++) {
      try {
        const outcome = await receiveSlackEvent(deps, connectionId, frame);
        if (outcome.status === 'REJECTED') log(`event rejected: ${outcome.reason}`);
        return;
      } catch (err) {
        // Transient failures (a file download, the database) are retried; dedupe makes that safe.
        log(`event failed (attempt ${i}/${attempts}): ${(err as Error).message.slice(0, 200)}`);
        if (i < attempts) await sleep(eventRetryMs * i, signal);
      }
    }
  };

  let failures = 0;
  while (!signal.aborted) {
    let healthy = false;
    let retryAfterMs = 0;
    try {
      const url = await openUrl();
      healthy = await runConnection(url, connect, handle, signal, log);
    } catch (err) {
      log(`connection failed: ${(err as Error).message.slice(0, 200)}`);
      const wait = (err as { retryAfterSeconds?: number | null }).retryAfterSeconds;
      if (wait) retryAfterMs = wait * 1000;
    }
    if (signal.aborted) break;
    failures = healthy ? 0 : failures + 1;
    await sleep(Math.max(retryAfterMs, Math.min(retryMax, retryBase * 2 ** Math.max(0, failures - 1))), signal);
  }
}

/** Runs one WebSocket connection until it closes. Resolves true if Slack said hello (a healthy connection). */
function runConnection(
  url: string,
  connect: (url: string) => SocketLike,
  handle: (frame: unknown) => Promise<void>,
  signal: AbortSignal,
  log: (message: string) => void,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const ws = connect(url);
    let hello = false;
    let done = false;
    // Events are processed in order, one at a time; the ack never waits for this chain.
    let chain: Promise<void> = Promise.resolve();
    const finish = () => {
      if (done) return;
      done = true;
      signal.removeEventListener('abort', onAbort);
      void chain.then(() => resolve(hello));
    };
    const onAbort = () => {
      try {
        ws.close();
      } catch {
        // already closed
      }
      finish();
    };
    signal.addEventListener('abort', onAbort, { once: true });

    ws.addEventListener('message', (ev) => {
      let frame: unknown;
      try {
        frame = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
      } catch {
        log('ignored a malformed frame');
        return;
      }
      if (typeof frame !== 'object' || frame === null) {
        log('ignored a malformed frame');
        return;
      }
      const f = frame as { type?: unknown; envelope_id?: unknown };
      if (typeof f.envelope_id === 'string') ws.send(JSON.stringify({ envelope_id: f.envelope_id })); // ack first
      if (f.type === 'hello') hello = true;
      else if (f.type === 'disconnect') ws.close();
      else if (f.type === 'events_api') chain = chain.then(() => handle(frame));
    });
    ws.addEventListener('close', finish);
    ws.addEventListener('error', () => log('socket error'));
  });
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
