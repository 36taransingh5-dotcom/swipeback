import { parsePolicyDocument, type PolicyDocument } from '@swipeback/domain';

/**
 * The synthetic demo organisation's written expense policy, and the structured rules derived from
 * it. Each rule cites the clause it implements. Thresholds are this organisation's choices.
 */
export const DEMO_POLICY_TEXT = `Northwind Field Services Ltd — Expense Policy (SYNTHETIC DEMO, v1)

NW-1 Receipts. Every expense needs an itemised receipt.
NW-2 Meals. Meals while working away from base are claimable up to £35 per receipt. State who attended and why.
NW-3 Client entertainment. Up to £150 per receipt; always state the client and business purpose.
NW-4 Travel. Rail, taxis, parking and tolls up to £250 per receipt.
NW-5 Accommodation. Up to £180 per night.
NW-6 Fuel. Fuel for pool or approved private vehicles up to £120 per receipt.
NW-7 Tools and equipment. Up to £200 per receipt; larger purchases go through procurement.
NW-8 Office supplies and software. Up to £100 per receipt. Software subscriptions are not claimable; use procurement.
NW-9 Limits. No more than £300 per employee per day and £800 per employee per week.
NW-10 VAT. Expenses over £100 need a full VAT invoice showing the supplier's VAT number.
NW-11 Deadline. Claim within 60 days of purchase.
NW-12 Not claimable. Gambling, betting and personal purchases are never reimbursed.
NW-13 Finance approval. Any single expense over £500 needs finance approval.
NW-14 Currency. Claims are accepted in GBP, EUR and USD; non-GBP claims are reviewed by finance.
NW-15 Card reconciliation. Company card purchases are matched to the card statement; we wait up to 3 days for the card record.
NW-16 Automatic reimbursement. Employee-paid expenses cleared under this policy are reimbursed automatically up to £150 each, £300 per employee per day and £600 per employee per week, within a monthly reimbursement budget of £5,000. Anything else needs a payment approver.`;

const clause = (title: string, text: string) => ({ title, text });

export const DEMO_POLICY: PolicyDocument = parsePolicyDocument({
  schema: 'swipeback.policy.v1',
  currency: 'GBP',
  clauses: {
    'NW-1': clause('Receipts', 'Every expense needs an itemised receipt.'),
    'NW-2': clause('Meals', 'Meals while working away from base are claimable up to £35 per receipt. State who attended and why.'),
    'NW-3': clause('Client entertainment', 'Up to £150 per receipt; always state the client and business purpose.'),
    'NW-4': clause('Travel', 'Rail, taxis, parking and tolls up to £250 per receipt.'),
    'NW-5': clause('Accommodation', 'Up to £180 per night.'),
    'NW-6': clause('Fuel', 'Fuel for pool or approved private vehicles up to £120 per receipt.'),
    'NW-7': clause('Tools and equipment', 'Up to £200 per receipt; larger purchases go through procurement.'),
    'NW-8': clause('Office supplies and software', 'Up to £100 per receipt. Software subscriptions are not claimable; use procurement.'),
    'NW-9': clause('Limits', 'No more than £300 per employee per day and £800 per employee per week.'),
    'NW-10': clause('VAT', "Expenses over £100 need a full VAT invoice showing the supplier's VAT number."),
    'NW-11': clause('Deadline', 'Claim within 60 days of purchase.'),
    'NW-12': clause('Not claimable', 'Gambling, betting and personal purchases are never reimbursed.'),
    'NW-13': clause('Finance approval', 'Any single expense over £500 needs finance approval.'),
    'NW-14': clause('Currency', 'Claims are accepted in GBP, EUR and USD; non-GBP claims are reviewed by finance.'),
    'NW-15': clause('Card reconciliation', 'Company card purchases are matched to the card statement; we wait up to 3 days for the card record.'),
    'NW-16': clause(
      'Automatic reimbursement',
      'Employee-paid expenses cleared under this policy are reimbursed automatically up to £150 each, £300 per employee per day and £600 per employee per week, within a monthly reimbursement budget of £5,000. Anything else needs a payment approver.',
    ),
  },
  receipts: { required: true, clause: 'NW-1' },
  categories: {
    MEALS: { allowed: true, perExpenseCapMinor: 3500, requiresBusinessPurpose: true, clause: 'NW-2' },
    CLIENT_ENTERTAINMENT: { allowed: true, perExpenseCapMinor: 15000, requiresBusinessPurpose: true, clause: 'NW-3' },
    TRAVEL: { allowed: true, perExpenseCapMinor: 25000, requiresBusinessPurpose: false, clause: 'NW-4' },
    ACCOMMODATION: { allowed: true, perExpenseCapMinor: 18000, requiresBusinessPurpose: false, clause: 'NW-5' },
    FUEL: { allowed: true, perExpenseCapMinor: 12000, requiresBusinessPurpose: false, clause: 'NW-6' },
    TOOLS_EQUIPMENT: { allowed: true, perExpenseCapMinor: 20000, requiresBusinessPurpose: false, clause: 'NW-7' },
    OFFICE_SUPPLIES: { allowed: true, perExpenseCapMinor: 10000, requiresBusinessPurpose: false, clause: 'NW-8' },
    SOFTWARE: { allowed: false, requiresBusinessPurpose: false, clause: 'NW-8' },
    OTHER: { allowed: true, perExpenseCapMinor: 5000, requiresBusinessPurpose: true, clause: 'NW-13' },
  },
  memberLimits: { dailyCapMinor: 30000, weeklyCapMinor: 80000, clause: 'NW-9' },
  reviewAboveMinor: { amountMinor: 50000, clause: 'NW-13' },
  vatInvoice: { requiredAboveMinor: 10000, clause: 'NW-10' },
  claimWindow: { maxAgeDays: 60, clause: 'NW-11' },
  currencies: { allowed: ['GBP', 'EUR', 'USD'], foreignRequiresReview: true, clause: 'NW-14' },
  blockedMerchants: [
    { pattern: 'bet', clause: 'NW-12' },
    { pattern: 'betting', clause: 'NW-12' },
    { pattern: 'casino', clause: 'NW-12' },
    { pattern: 'bookmaker', clause: 'NW-12' },
  ],
  matching: { windowBeforeDays: 1, windowAfterDays: 5, awaitCardFeedMinutes: 3 * 24 * 60, clause: 'NW-15' },
  autoReimbursement: {
    enabled: true,
    perExpenseMaxMinor: 15000,
    memberDailyMaxMinor: 30000,
    memberWeeklyMaxMinor: 60000,
    monthlyBudgetMinor: 500000,
    clause: 'NW-16',
  },
});
