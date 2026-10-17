import type { Category } from '@swipeback/domain';

/** Keyword category suggestion (rule-only). Ties or no signal -> null, which routes to review. */
const KEYWORDS: Readonly<Record<Exclude<Category, 'OTHER' | 'CLIENT_ENTERTAINMENT'>, readonly string[]>> = {
  TRAVEL: ['trainline', 'rail', 'railway', 'train', 'tfl', 'uber', 'taxi', 'taxis', 'cab', 'cabs', 'bolt', 'parking', 'ncp', 'toll', 'coach', 'avanti', 'lner', 'gwr', 'flight', 'easyjet', 'ryanair', 'airways', 'oyster', 'ticket', 'return', 'single'],
  ACCOMMODATION: ['hotel', 'inn', 'travelodge', 'hilton', 'marriott', 'airbnb', 'lodge', 'night', 'nights', 'room'],
  FUEL: ['shell', 'bp', 'esso', 'texaco', 'fuel', 'petrol', 'diesel', 'unleaded', 'gulf', 'litres', 'pump'],
  MEALS: ['pret', 'costa', 'starbucks', 'cafe', 'coffee', 'restaurant', 'greggs', 'subway', 'mcdonald', 'nando', 'pizza', 'kitchen', 'bistro', 'deli', 'lunch', 'dinner', 'breakfast', 'sandwich', 'latte', 'meal'],
  TOOLS_EQUIPMENT: ['screwfix', 'toolstation', 'wickes', 'homebase', 'tools', 'drill', 'hardware', 'rs components', 'fittings', 'sealant', 'cable', 'pipe'],
  OFFICE_SUPPLIES: ['ryman', 'viking', 'staples', 'stationery', 'paper', 'printer', 'ink', 'toner', 'envelopes', 'notebook'],
  SOFTWARE: ['subscription', 'saas', 'software', 'licence', 'license', 'adobe', 'workspace', 'annual plan', 'monthly plan'],
};

function hits(text: string, words: readonly string[]): number {
  const t = ` ${text.toLowerCase().replace(/[^a-z0-9& ]+/g, ' ')} `;
  return words.reduce((n, w) => n + (t.includes(` ${w} `) ? 1 : 0), 0);
}

export function suggestCategory(merchant: string | null, text: string): { category: Category | null; confidence: number } {
  let best: Category | null = null;
  let bestScore = 0;
  let tie = false;
  for (const [cat, words] of Object.entries(KEYWORDS) as [Category, readonly string[]][]) {
    const score = (merchant ? hits(merchant, words) * 3 : 0) + hits(text, words);
    if (score > bestScore) {
      best = cat;
      bestScore = score;
      tie = false;
    } else if (score === bestScore && score > 0) {
      tie = true;
    }
  }
  if (!best || tie) return { category: null, confidence: 0 };
  return { category: best, confidence: bestScore >= 3 ? 0.9 : 0.7 };
}
