/** Synthetic text e-receipts (all merchants' details fictitious; VAT numbers are invalid test values). */
export interface TextReceiptSpec {
  merchant: string;
  date: string; // DD/MM/YYYY as printed on UK receipts
  items: [description: string, pounds: string][];
  total: string;
  currencySymbol?: '£' | '€' | '$';
  vat?: string;
  vatNumber?: string;
  receiptNo?: string;
  paidWith?: { card: string } | 'cash';
  extraLines?: string[];
}

export function textReceipt(s: TextReceiptSpec): string {
  const c = s.currencySymbol ?? '£';
  return [
    s.merchant,
    ...(s.receiptNo ? [`Receipt No: ${s.receiptNo}`] : []),
    `Date: ${s.date}`,
    '',
    ...s.items.map(([d, p]) => `${d}  ${c}${p}`),
    '',
    ...(s.vat ? [`VAT @ 20%  ${c}${s.vat}`] : []),
    `Total  ${c}${s.total}`,
    ...(s.paidWith === 'cash' ? ['Paid: Cash', 'Change due  £0.00'] : s.paidWith ? [`Paid by Visa ending ${s.paidWith.card}`] : []),
    ...(s.vatNumber ? [`VAT No: ${s.vatNumber}`] : []),
    ...(s.extraLines ?? []),
    'SYNTHETIC DEMO RECEIPT',
  ].join('\n');
}

export const TRAIN_RECEIPT = textReceipt({
  merchant: 'Trainline',
  receiptNo: 'TL-88231',
  date: '16/10/2026',
  items: [['Off-peak return London Euston - Watford Junction', '42.10']],
  total: '42.10',
  paidWith: { card: '9911' },
});

export const PRET_CARD_RECEIPT = textReceipt({
  merchant: 'Pret A Manger (Europe) Ltd',
  receiptNo: 'P-55120',
  date: '16/10/2026',
  items: [['Chicken caesar baguette', '6.25'], ['Flat white', '3.60'], ['Still water', '1.40']],
  total: '11.25',
  paidWith: { card: '4242' },
});

export const SCREWFIX_RECEIPT = textReceipt({
  merchant: 'Screwfix Direct',
  receiptNo: 'SF-20931',
  date: '17/10/2026',
  items: [['15mm compression fittings x10', '18.99'], ['Silicone sealant', '6.49']],
  total: '25.48',
  vat: '4.25',
  paidWith: { card: '9911' },
});

export const HOTEL_OVER_CAP_RECEIPT = textReceipt({
  merchant: 'Premier Stay Hotel Watford',
  receiptNo: 'H-7781',
  date: '15/10/2026',
  items: [['Room, 1 night', '210.00']],
  total: '210.00',
  vat: '35.00',
  vatNumber: 'GB000000000',
  paidWith: { card: '9911' },
});
