import { randomUUID } from 'node:crypto';
import { FIXTURE_AUTHSERV_ID } from '../email/fixture-adapter.ts';

/** Builds synthetic RFC 5322 emails for tests, evaluation fixtures and offline demos. */
export interface EmlSpec {
  from: string;
  fromName?: string;
  to: string;
  subject?: string;
  text?: string;
  messageId?: string;
  inReplyTo?: string;
  references?: string[];
  date?: Date;
  attachments?: { filename: string; mime: string; content: Buffer | string }[];
  /** Authentication-Results stamped by the (fixture) receiving server; 'pass' by default. */
  auth?: 'pass' | 'fail' | 'none' | { authservId: string; result: 'pass' | 'fail' };
  extraHeaders?: Record<string, string>;
}

export function buildEml(spec: EmlSpec): Buffer {
  const messageId = spec.messageId ?? `<${randomUUID()}@mail.northwind.example>`;
  const fromDomain = spec.from.split('@')[1]!;
  const headers: string[] = [];
  const auth = spec.auth ?? 'pass';
  if (auth !== 'none') {
    const { authservId, result } = typeof auth === 'object' ? auth : { authservId: FIXTURE_AUTHSERV_ID, result: auth };
    headers.push(
      `Authentication-Results: ${authservId}; dkim=${result} header.d=${fromDomain} header.s=sel1; dmarc=${result} header.from=${fromDomain}; spf=pass`,
    );
  }
  headers.push(
    `From: ${spec.fromName ? `"${spec.fromName}" ` : ''}<${spec.from}>`,
    `To: <${spec.to}>`,
    `Subject: ${spec.subject ?? 'Receipt'}`,
    `Message-ID: ${messageId}`,
    `Date: ${(spec.date ?? new Date()).toUTCString()}`,
    'MIME-Version: 1.0',
  );
  if (spec.inReplyTo) headers.push(`In-Reply-To: ${spec.inReplyTo}`);
  if (spec.references?.length) headers.push(`References: ${spec.references.join(' ')}`);
  for (const [k, v] of Object.entries(spec.extraHeaders ?? {})) headers.push(`${k}: ${v}`);

  const text = spec.text ?? '';
  if (!spec.attachments?.length) {
    headers.push('Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64');
    return Buffer.from(`${headers.join('\r\n')}\r\n\r\n${b64(Buffer.from(text, 'utf8'))}\r\n`);
  }
  const boundary = `sb-${randomUUID()}`;
  headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
  const parts = [
    `--${boundary}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64(Buffer.from(text, 'utf8'))}`,
    ...spec.attachments.map(
      (a) =>
        `--${boundary}\r\nContent-Type: ${a.mime}; name="${a.filename}"\r\nContent-Disposition: attachment; filename="${a.filename}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64(typeof a.content === 'string' ? Buffer.from(a.content, 'utf8') : a.content)}`,
    ),
  ];
  return Buffer.from(`${headers.join('\r\n')}\r\n\r\n${parts.join('\r\n')}\r\n--${boundary}--\r\n`);
}

function b64(buf: Buffer): string {
  return buf.toString('base64').replace(/.{76}/g, '$&\r\n');
}

/** Build a reply to a message we sent, as the employee's mail client would. */
export function buildReplyEml(original: { raw: string; to: string }, spec: Omit<EmlSpec, 'inReplyTo' | 'references' | 'to'> & { to?: string }): Buffer {
  const header = (k: string) => new RegExp(`^${k}: (.+)$`, 'mi').exec(original.raw)?.[1]?.trim();
  const messageId = header('Message-ID')!;
  const refs = header('References')?.split(/\s+/) ?? [];
  const replyTo = header('Reply-To')?.replace(/[<>]/g, '');
  const subject = header('Subject') ?? '';
  return buildEml({
    ...spec,
    to: spec.to ?? replyTo ?? header('From')!.replace(/^.*<|>.*$/g, ''),
    subject: spec.subject ?? (subject.startsWith('Re:') ? subject : `Re: ${subject}`),
    inReplyTo: messageId,
    references: [...refs, messageId],
  });
}
