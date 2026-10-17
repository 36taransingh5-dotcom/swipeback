import { chromium, type Browser } from 'playwright-core';

/**
 * Synthetic receipt renderer for tests, demos and the evaluation dataset. Every receipt is
 * fictitious and printed with a SYNTHETIC watermark; VAT numbers are invalid test values.
 */
export interface ReceiptSpec {
  merchant: string;
  address?: string;
  date: string; // as printed, e.g. 16/10/2026
  time?: string;
  receiptNo?: string;
  items: [description: string, amount: string][];
  subtotal?: string;
  vat?: string;
  total: string;
  currencySymbol?: '£' | '€' | '$';
  vatNumber?: string;
  paidWith?: { card: string; scheme?: string } | 'cash';
  /** Extra printed lines (e.g. adversarial text for injection tests). */
  extraLines?: string[];
  /** Text rendered nearly invisibly (white-on-white, tiny) — a hidden-instruction attack. */
  hiddenText?: string;
}

export type RenderFormat = 'pdf' | 'png' | 'photo';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export function receiptHtml(r: ReceiptSpec): string {
  const c = r.currencySymbol ?? '£';
  const row = (l: string, v: string, cls = '') => `<div class="row ${cls}"><span>${esc(l)}</span><span>${esc(v)}</span></div>`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body { margin: 0; background: #fff; font-family: "Courier New", monospace; color: #111; }
    .r { width: 320px; padding: 24px 22px; position: relative; }
    h1 { font-size: 20px; text-align: center; margin: 0 0 4px; letter-spacing: 1px; }
    .c { text-align: center; font-size: 12px; }
    .row { display: flex; justify-content: space-between; font-size: 13px; margin: 3px 0; gap: 12px; }
    .row span:first-child { flex: 1; }
    .tot { font-weight: bold; font-size: 16px; border-top: 1px dashed #333; padding-top: 6px; margin-top: 8px; }
    hr { border: 0; border-top: 1px dashed #333; margin: 10px 0; }
    .wm { position: absolute; inset: 0; pointer-events: none; background: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='320' height='200'><text x='20' y='140' transform='rotate(-24 160 100)' font-family='Arial' font-size='40' font-weight='bold' fill='rgba(200,0,0,0.16)'>SYNTHETIC</text></svg>") repeat-y center; }
    .hidden { color: #fefefe; font-size: 3px; }
  </style></head><body><div class="r">
    <div class="wm" aria-hidden="true"></div>
    <h1>${esc(r.merchant)}</h1>
    ${r.address ? `<div class="c">${esc(r.address)}</div>` : ''}
    <div class="c">${r.receiptNo ? `Receipt No: ${esc(r.receiptNo)} · ` : ''}Date: ${esc(r.date)}${r.time ? ` ${esc(r.time)}` : ''}</div>
    <hr>
    ${r.items.map(([d, a]) => row(d, `${c}${a}`)).join('')}
    <hr>
    ${r.subtotal ? row('Subtotal', `${c}${r.subtotal}`) : ''}
    ${r.vat ? row('VAT @ 20%', `${c}${r.vat}`) : ''}
    ${row('TOTAL', `${c}${r.total}`, 'tot')}
    ${r.paidWith === 'cash' ? row('Paid: Cash', '') : r.paidWith ? row(`${r.paidWith.scheme ?? 'Visa'} ending ${r.paidWith.card}`, `${c}${r.total}`) : ''}
    ${r.vatNumber ? `<div class="c">VAT No: ${esc(r.vatNumber)}</div>` : ''}
    ${(r.extraLines ?? []).map((l) => `<div class="c">${esc(l)}</div>`).join('')}
    ${r.hiddenText ? `<div class="hidden">${esc(r.hiddenText)}</div>` : ''}
    <div class="c" style="margin-top:10px">Thank you · SYNTHETIC DEMO RECEIPT</div>
  </div></body></html>`;
}

export function receiptText(r: ReceiptSpec): string {
  const c = r.currencySymbol ?? '£';
  return [
    r.merchant,
    ...(r.address ? [r.address] : []),
    ...(r.receiptNo ? [`Receipt No: ${r.receiptNo}`] : []),
    `Date: ${r.date}${r.time ? ` ${r.time}` : ''}`,
    '',
    ...r.items.map(([d, a]) => `${d}  ${c}${a}`),
    '',
    ...(r.subtotal ? [`Subtotal  ${c}${r.subtotal}`] : []),
    ...(r.vat ? [`VAT @ 20%  ${c}${r.vat}`] : []),
    `Total  ${c}${r.total}`,
    ...(r.paidWith === 'cash' ? ['Paid: Cash'] : r.paidWith ? [`Paid by ${r.paidWith.scheme ?? 'Visa'} ending ${r.paidWith.card}`] : []),
    ...(r.vatNumber ? [`VAT No: ${r.vatNumber}`] : []),
    ...(r.extraLines ?? []),
    'SYNTHETIC DEMO RECEIPT',
  ].join('\n');
}

export class ReceiptRenderer {
  private browser: Browser | null = null;

  async render(spec: ReceiptSpec, format: RenderFormat): Promise<{ bytes: Buffer; mime: string; ext: string }> {
    this.browser ??= await chromium.launch({ headless: true });
    const page = await this.browser.newPage({ viewport: { width: 364, height: 600 }, deviceScaleFactor: format === 'photo' ? 1.5 : 2 });
    try {
      if (format === 'photo') {
        // A phone photo of a paper receipt: rotated, softly blurred, on a desk-coloured background.
        const html = receiptHtml(spec).replace('<body>', '<body style="background:#b9ab95;padding:30px">').replace(
          'class="r"',
          'class="r" style="background:#fbf8f1;transform:rotate(-2.2deg);filter:blur(0.35px) contrast(.92);box-shadow:3px 6px 14px rgba(0,0,0,.35)"',
        );
        await page.setContent(html);
        const bytes = await page.screenshot({ type: 'jpeg', quality: 72, fullPage: true });
        return { bytes, mime: 'image/jpeg', ext: 'jpg' };
      }
      await page.setContent(receiptHtml(spec));
      if (format === 'png') return { bytes: await page.screenshot({ type: 'png', fullPage: true }), mime: 'image/png', ext: 'png' };
      const bytes = await page.pdf({ width: '90mm', height: '160mm', printBackground: true, margin: { top: '4mm', bottom: '4mm', left: '2mm', right: '2mm' } });
      return { bytes, mime: 'application/pdf', ext: 'pdf' };
    } finally {
      await page.close();
    }
  }

  async close(): Promise<void> {
    await this.browser?.close();
    this.browser = null;
  }
}
