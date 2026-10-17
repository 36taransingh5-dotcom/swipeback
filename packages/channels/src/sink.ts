import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { OutboundEnvelope } from './contract.ts';

/** Where fixture/synthetic adapters "send" messages. Real adapters call their provider instead. */
export interface SentRecord {
  envelope: OutboundEnvelope;
  providerMessageId: string;
  /** Rendered wire format (RFC 5322 for email, JSON for chat). */
  raw: string;
  kind: 'message' | 'approval_request';
}

export interface OutboundSink {
  deliver(record: SentRecord): Promise<void>;
}

export class MemorySink implements OutboundSink {
  readonly sent: SentRecord[] = [];
  async deliver(record: SentRecord): Promise<void> {
    this.sent.push(record);
  }
  to(address: string): SentRecord[] {
    return this.sent.filter((s) => s.envelope.to === address);
  }
}

/** Writes each sent message to a directory so a developer can read the conversation (CLI demo). */
export class DirectorySink implements OutboundSink {
  constructor(private readonly dir: string) {}
  async deliver(record: SentRecord): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const safe = record.providerMessageId.replace(/[^a-zA-Z0-9.-]/g, '_');
    const ext = record.raw.startsWith('{') ? 'json' : 'eml';
    await writeFile(path.join(this.dir, `${Date.now()}-${safe}.${ext}`), record.raw);
  }
}
