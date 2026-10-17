import type { ReceiptSource } from './types.ts';

/** Plain text from a receipt source when one is available without a model (text/plain, HTML). */
export function textFromSource(source: ReceiptSource): string | null {
  const mime = source.mime;
  if (mime === 'text/plain') return source.bytes.toString('utf8');
  if (mime === 'text/html') return htmlToText(source.bytes.toString('utf8'));
  return null;
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h\d|table)>/gi, '\n')
    .replace(/<\/t[dh]>/gi, '  ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&pound;/g, '£')
    .replace(/&euro;/g, '€')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n');
}

/** Whitespace/case-insensitive containment, used to verify evidence quotes against source text. */
export function containsQuote(haystack: string, quote: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  return norm(haystack).includes(norm(quote));
}
