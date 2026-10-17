/**
 * Merchant name normalisation for comparing card descriptors ("SQ *JOES COFFEE LDN 123")
 * with receipt headers ("Joe's Coffee Ltd"). Deterministic and conservative: a weak similarity
 * never auto-matches on its own (see matching.ts).
 */

const PAYMENT_PREFIX_RE = /^(?:sq|sumup|zettle|iz|paypal|pp|crv|sp|tst|ws|stripe)\s*\*+\s*/i;

const NOISE_TOKENS = new Set([
  'ltd', 'limited', 'plc', 'inc', 'llc', 'llp', 'co', 'company', 'the', 'and', 'uk', 'gb', 'gbr', 'london',
  'ldn', 'store', 'shop', 'online', 'www', 'com', 'net', 'org', 'europe', 'group', 'services', 'svc', 'trading',
  'retail', 'stores', 'branch',
]);

const ALIASES: Readonly<Record<string, string>> = {
  amzn: 'amazon',
  mktp: 'marketplace',
  mkt: 'market',
  intl: 'international',
  sainsburys: 'sainsbury',
  mcdonalds: 'mcdonald',
};

export function merchantTokens(name: string): string[] {
  const stripped = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(PAYMENT_PREFIX_RE, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/&/g, ' and ')
    .replace(/\.(co\.uk|com|net|org|io)\b/g, ' ');
  const tokens: string[] = [];
  for (const raw of stripped.split(/[^a-z0-9]+/)) {
    if (!raw || /^\d+$/.test(raw)) continue;
    const t = ALIASES[raw] ?? raw;
    if (NOISE_TOKENS.has(t)) continue;
    tokens.push(t);
  }
  return tokens;
}

export function normaliseMerchant(name: string): string {
  return merchantTokens(name).join(' ');
}

/** Similarity in [0, 1]. */
export function merchantSimilarity(a: string, b: string): number {
  const ta = merchantTokens(a);
  const tb = merchantTokens(b);
  if (ta.length === 0 || tb.length === 0) return 0;
  const ja = ta.join('');
  const jb = tb.join('');
  if (ja === jb) return 1;

  const sa = new Set(ta);
  const sb = new Set(tb);
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  const union = sa.size + sb.size - inter;
  const jaccard = inter / union;
  const containment = (inter / Math.min(sa.size, sb.size)) * 0.9;
  const compact = Math.min(ja.length, jb.length) >= 4 && (ja.includes(jb) || jb.includes(ja)) ? 0.9 : 0;
  const leading = ta[0] === tb[0] && ta[0]!.length >= 4 ? 0.75 : 0;
  return Math.max(jaccard, containment, compact, leading);
}

export const MERCHANT_MATCH_THRESHOLD = 0.6;
