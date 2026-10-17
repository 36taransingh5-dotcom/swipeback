import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

export class MalformedDocumentError extends Error {
  override readonly name = 'MalformedDocumentError';
}

const MAX_PAGES = 20;

/**
 * Text layer of a PDF (empty string for scanned/image-only PDFs). Used to verify evidence quotes
 * independently of the model, and by the rule-only baseline. Throws MalformedDocumentError for
 * anything that is not a readable PDF.
 */
export async function pdfText(bytes: Uint8Array): Promise<string> {
  const task = getDocument({ data: new Uint8Array(bytes), disableFontFace: true, useSystemFonts: false, verbosity: 0 });
  let doc;
  try {
    doc = await task.promise;
  } catch (err) {
    await task.destroy();
    throw new MalformedDocumentError(`unreadable PDF: ${(err as Error).message}`);
  }
  try {
    const pages: string[] = [];
    for (let i = 1; i <= Math.min(doc.numPages, MAX_PAGES); i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      // Rebuild lines from text items using their vertical position.
      const lines = new Map<number, { x: number; w: number; s: string }[]>();
      for (const item of content.items) {
        if (!('str' in item) || !item.str.trim()) continue;
        const y = Math.round(item.transform[5] as number);
        const x = item.transform[4] as number;
        const key = [...lines.keys()].find((k) => Math.abs(k - y) <= 2) ?? y;
        lines.set(key, [...(lines.get(key) ?? []), { x, w: item.width, s: item.str.trim() }]);
      }
      // Join words with one space; a wide gap (columns) becomes two spaces.
      const ordered = [...lines.entries()]
        .sort((a, b) => b[0] - a[0])
        .map(([, parts]) => {
          const sorted = parts.sort((a, b) => a.x - b.x);
          return sorted.map((p, i) => (i === 0 ? '' : p.x - (sorted[i - 1]!.x + sorted[i - 1]!.w) > 12 ? '  ' : ' ') + p.s).join('');
        });
      pages.push(ordered.join('\n'));
    }
    return pages.join('\n\n').replace(/[ \t]+\n/g, '\n').trim();
  } finally {
    await task.destroy();
  }
}
