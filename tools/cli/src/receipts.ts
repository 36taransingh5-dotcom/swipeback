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
  /** Layout: till receipt (default), A5 tax invoice, or card-terminal slip. */
  template?: 'thermal' | 'invoice' | 'slip';
  /** Discount line (printed as negative), e.g. "2.00". */
  discount?: string;
  /** Service charge / tip line. */
  serviceCharge?: string;
  /** Photo degradation (format 'photo' only). */
  photo?: { rotateDeg?: number; blurPx?: number; tiltDeg?: number; contrast?: number; quality?: number };
}

export type RenderFormat = 'pdf' | 'png' | 'photo';

export function receiptHtml(r: ReceiptSpec): string {
  return r.template === 'invoice' ? invoiceHtml(r) : r.template === 'slip' ? slipHtml(r) : thermalHtml(r);
}

const WATERMARK = `<div class="wm" aria-hidden="true"></div>`;
const WATERMARK_CSS = `.wm { position: absolute; inset: 0; pointer-events: none; background: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='320' height='200'><text x='20' y='140' transform='rotate(-24 160 100)' font-family='Arial' font-size='40' font-weight='bold' fill='rgba(200,0,0,0.16)'>SYNTHETIC</text></svg>") repeat-y center; }`;

function invoiceHtml(r: ReceiptSpec): string {
  const c = r.currencySymbol ?? '£';
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body { margin: 0; background: #fff; font-family: Helvetica, Arial, sans-serif; color: #1a1a1a; }
    .r { width: 520px; padding: 28px 30px; position: relative; font-size: 13px; }
    ${WATERMARK_CSS}
    .top { display: flex; justify-content: space-between; align-items: flex-start; }
    h1 { font-size: 22px; margin: 0; } h2 { font-size: 15px; margin: 0; letter-spacing: 2px; color: #444; }
    table { width: 100%; border-collapse: collapse; margin: 18px 0 8px; }
    th { text-align: left; border-bottom: 2px solid #222; padding: 5px 4px; font-size: 12px; }
    td { padding: 5px 4px; border-bottom: 1px solid #ddd; } td.n, th.n { text-align: right; }
    .sum { width: 240px; margin-left: auto; } .sum div { display: flex; justify-content: space-between; padding: 2px 0; }
    .due { font-weight: bold; font-size: 15px; border-top: 2px solid #222; margin-top: 4px; padding-top: 4px; }
    .muted { color: #555; font-size: 11px; } .hidden { color: #fefefe; font-size: 3px; }
  </style></head><body><div class="r">${WATERMARK}
    <div class="top"><div><h1>${esc(r.merchant)}</h1><div class="muted">${esc(r.address ?? '')}</div>${r.vatNumber ? `<div class="muted">VAT Reg No: ${esc(r.vatNumber)}</div>` : ''}</div>
    <div style="text-align:right"><h2>TAX INVOICE</h2>${r.receiptNo ? `<div>Invoice No: ${esc(r.receiptNo)}</div>` : ''}<div>Invoice date: ${esc(r.date)}</div></div></div>
    <table><tr><th>Description</th><th class="n">Amount</th></tr>
    ${r.items.map(([d, a]) => `<tr><td>${esc(d)}</td><td class="n">${c}${esc(a)}</td></tr>`).join('')}</table>
    <div class="sum">
      ${r.discount ? `<div><span>Discount</span><span>-${c}${esc(r.discount)}</span></div>` : ''}
      ${r.subtotal ? `<div><span>Net</span><span>${c}${esc(r.subtotal)}</span></div>` : ''}
      ${r.vat ? `<div><span>VAT 20%</span><span>${c}${esc(r.vat)}</span></div>` : ''}
      ${r.serviceCharge ? `<div><span>Service charge</span><span>${c}${esc(r.serviceCharge)}</span></div>` : ''}
      <div class="due"><span>Total paid</span><span>${c}${esc(r.total)}</span></div>
    </div>
    <div class="muted" style="margin-top:14px">${r.paidWith === 'cash' ? 'Paid in cash' : r.paidWith ? `Paid by ${esc(r.paidWith.scheme ?? 'Visa')} card ending ${esc(r.paidWith.card)}` : 'Payment received with thanks'}</div>
    ${(r.extraLines ?? []).map((l) => `<div class="muted">${esc(l)}</div>`).join('')}
    ${r.hiddenText ? `<div class="hidden">${esc(r.hiddenText)}</div>` : ''}
    <div class="muted" style="margin-top:8px">SYNTHETIC DEMO DOCUMENT — not a real invoice</div>
  </div></body></html>`;
}

function slipHtml(r: ReceiptSpec): string {
  const cur = r.currencySymbol === '€' ? 'EUR' : r.currencySymbol === '$' ? 'USD' : 'GBP';
  const card = r.paidWith && r.paidWith !== 'cash' ? r.paidWith : { card: '0000', scheme: 'VISA' };
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body { margin: 0; background: #fff; font-family: "Lucida Console", "Courier New", monospace; color: #222; }
    .r { width: 260px; padding: 20px 18px; position: relative; font-size: 12px; text-align: center; }
    ${WATERMARK_CSS}
    .b { font-weight: bold; font-size: 14px; } .l { display: flex; justify-content: space-between; text-align: left; margin: 2px 0; }
    .hidden { color: #fefefe; font-size: 3px; }
  </style></head><body><div class="r">${WATERMARK}
    <div class="b">${esc(r.merchant.toUpperCase())}</div>
    <div>${esc(r.address ?? '')}</div>
    <div style="margin:8px 0">CUSTOMER COPY<br>SALE</div>
    <div class="l"><span>${esc((card.scheme ?? 'VISA').toUpperCase())} CONTACTLESS</span></div>
    <div class="l"><span>************${esc(card.card)}</span></div>
    <div class="l"><span>DATE ${esc(r.date)}</span><span>${esc(r.time ?? '')}</span></div>
    ${r.receiptNo ? `<div class="l"><span>REF ${esc(r.receiptNo)}</span></div>` : ''}
    <div class="l"><span>AUTH CODE 0${esc(card.card)}2</span></div>
    <div class="l b" style="margin-top:8px"><span>AMOUNT</span><span>${cur} ${esc(r.total)}</span></div>
    <div style="margin-top:8px">VERIFIED BY DEVICE<br>PLEASE RETAIN THIS RECEIPT</div>
    ${r.hiddenText ? `<div class="hidden">${esc(r.hiddenText)}</div>` : ''}
    <div style="margin-top:6px">SYNTHETIC DEMO SLIP</div>
  </div></body></html>`;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

function thermalHtml(r: ReceiptSpec): string {
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
    ${WATERMARK_CSS}
    .hidden { color: #fefefe; font-size: 3px; }
  </style></head><body><div class="r">
    ${WATERMARK}
    <h1>${esc(r.merchant)}</h1>
    ${r.address ? `<div class="c">${esc(r.address)}</div>` : ''}
    <div class="c">${r.receiptNo ? `Receipt No: ${esc(r.receiptNo)} · ` : ''}Date: ${esc(r.date)}${r.time ? ` ${esc(r.time)}` : ''}</div>
    <hr>
    ${r.items.map(([d, a]) => row(d, `${c}${a}`)).join('')}
    <hr>
    ${r.discount ? row('Discount', `-${c}${r.discount}`) : ''}
    ${r.subtotal ? row('Subtotal', `${c}${r.subtotal}`) : ''}
    ${r.vat ? row('VAT @ 20%', `${c}${r.vat}`) : ''}
    ${r.serviceCharge ? row('Service', `${c}${r.serviceCharge}`) : ''}
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
    const width = spec.template === 'invoice' ? 600 : 380;
    const page = await this.browser.newPage({ viewport: { width, height: 700 }, deviceScaleFactor: format === 'photo' ? 1.5 : 2 });
    try {
      if (format === 'photo') {
        // A phone photo of a paper receipt: rotated, softly blurred, on a desk-coloured background.
        const p = { rotateDeg: -2.2, blurPx: 0.35, tiltDeg: 0, contrast: 0.92, quality: 72, ...spec.photo };
        const html = receiptHtml(spec).replace('<body>', '<body style="background:#b9ab95;padding:30px;display:inline-block">').replace(
          'class="r"',
          `class="r" style="background:#fbf8f1;transform:perspective(900px) rotateX(${p.tiltDeg}deg) rotate(${p.rotateDeg}deg);filter:blur(${p.blurPx}px) contrast(${p.contrast});box-shadow:3px 6px 14px rgba(0,0,0,.35)"`,
        );
        await page.setContent(html);
        const bytes = await page.locator('body').screenshot({ type: 'jpeg', quality: p.quality });
        return { bytes, mime: 'image/jpeg', ext: 'jpg' };
      }
      await page.setContent(receiptHtml(spec));
      if (format === 'png') return { bytes: await page.locator('.r').screenshot({ type: 'png' }), mime: 'image/png', ext: 'png' };
      const bytes = await page.pdf({
        width: spec.template === 'invoice' ? '148mm' : '90mm',
        height: spec.template === 'invoice' ? '210mm' : '160mm',
        printBackground: true,
        margin: { top: '4mm', bottom: '4mm', left: '2mm', right: '2mm' },
      });
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
