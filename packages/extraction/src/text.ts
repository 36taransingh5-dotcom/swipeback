import { pdfText } from './pdf.ts';
import type { ReceiptSource } from './types.ts';

/**
 * Text available without a model: text/plain, HTML, or a PDF's text layer. Null for images and
 * for scanned (image-only) PDFs. Throws MalformedDocumentError for unreadable PDFs.
 */
export async function textFromSource(source: ReceiptSource): Promise<string | null> {
  const mime = source.mime;
  if (mime === 'text/plain') return source.bytes.toString('utf8');
  if (mime === 'text/html') return htmlToText(source.bytes.toString('utf8'));
  if (mime === 'application/pdf') {
    const text = await pdfText(source.bytes);
    return text.length >= 10 ? text : null;
  }
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
