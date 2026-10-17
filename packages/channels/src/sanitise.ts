import { createHash } from 'node:crypto';

export const MAX_TEXT_CHARS = 20_000;

// Zero-width and bidirectional control characters are a common way to hide instructions in text.
const INVISIBLE_RE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\u00AD]/g;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/** Normalise untrusted text: it stays data, but without hidden characters or unbounded size. */
export function sanitiseUntrustedText(input: string, max = MAX_TEXT_CHARS): { sanitised: string; truncated: boolean } {
  const s = input
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(INVISIBLE_RE, '')
    .replace(CONTROL_RE, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return s.length > max ? { sanitised: s.slice(0, max), truncated: true } : { sanitised: s, truncated: false };
}

export function sanitiseShort(input: string | null | undefined, max: number): string | null {
  if (!input) return null;
  const s = sanitiseUntrustedText(input, max).sanitised.replace(/\s+/g, ' ');
  return s || null;
}

export function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

export function dedupeKeyFor(channel: string, connectionId: string, providerEventId: string): string {
  return sha256Hex(`${channel}|${connectionId}|${providerEventId}`);
}

const ALLOWED_MIME = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/heic', 'image/webp', 'text/plain', 'text/html']);
export const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;

/** Check declared type against magic bytes; anything unexpected is quarantined as REJECTED evidence. */
export function screenAttachment(mime: string, bytes: Uint8Array): { scan: 'UNSCANNED' | 'REJECTED'; note: string | null } {
  const m = mime.toLowerCase().split(';')[0]!.trim();
  if (!ALLOWED_MIME.has(m)) return { scan: 'REJECTED', note: `unsupported type ${m}` };
  if (bytes.byteLength === 0) return { scan: 'REJECTED', note: 'empty file' };
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) return { scan: 'REJECTED', note: 'file too large' };
  const head = Buffer.from(bytes.subarray(0, 8));
  const magic: Record<string, (b: Buffer) => boolean> = {
    'application/pdf': (b) => b.subarray(0, 5).toString('latin1') === '%PDF-',
    'image/png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  };
  const check = magic[m];
  if (check && !check(head)) return { scan: 'REJECTED', note: `content does not match declared ${m}` };
  // No malware scanner is wired in; files are stored as inert evidence and never executed.
  return { scan: 'UNSCANNED', note: null };
}

export function normaliseMime(mime: string): string {
  return mime.toLowerCase().split(';')[0]!.trim();
}
