import { z } from 'zod';
import { hashCanonical } from './canonical.ts';
import { CATEGORIES, type Category } from './types.ts';

/**
 * A company's expense policy as structured, versioned rules. Every rule cites a clause from the
 * company's written policy so each decision can quote the text it applied. Thresholds belong to
 * the organisation; there are no universal defaults in code.
 *
 * Amounts are integer minor units in `currency`.
 */

const minor = z.number().int().nonnegative();
const clauseRef = z.string().min(1);

const categoryRule = z.object({
  allowed: z.boolean(),
  perExpenseCapMinor: minor.optional(),
  monthlyCapMinor: minor.optional(),
  requiresBusinessPurpose: z.boolean(),
  clause: clauseRef,
});

export const policyDocumentSchema = z
  .object({
    schema: z.literal('swipeback.policy.v1'),
    currency: z.string().regex(/^[A-Z]{3}$/),
    clauses: z.record(z.string().min(1), z.object({ title: z.string().min(1), text: z.string().min(1) })),
    receipts: z.object({ required: z.boolean(), clause: clauseRef }),
    categories: z.record(z.enum(CATEGORIES), categoryRule),
    memberLimits: z.object({ dailyCapMinor: minor, weeklyCapMinor: minor, clause: clauseRef }),
    reviewAboveMinor: z.object({ amountMinor: minor, clause: clauseRef }),
    vatInvoice: z.object({ requiredAboveMinor: minor, clause: clauseRef }),
    claimWindow: z.object({ maxAgeDays: z.number().int().positive(), clause: clauseRef }),
    currencies: z.object({
      allowed: z.array(z.string().regex(/^[A-Z]{3}$/)).min(1),
      foreignRequiresReview: z.literal(true),
      clause: clauseRef,
    }),
    blockedMerchants: z.array(z.object({ pattern: z.string().min(2), clause: clauseRef })),
    matching: z.object({
      windowBeforeDays: z.number().int().nonnegative(),
      windowAfterDays: z.number().int().nonnegative(),
      /** How long to wait for a card-feed record before asking how the purchase was paid. */
      awaitCardFeedMinutes: z.number().int().nonnegative(),
      clause: clauseRef,
    }),
    /** Payout authorisation — deliberately separate from expense clearance (PRD §5 (a) vs (b)). */
    autoReimbursement: z.object({
      enabled: z.boolean(),
      perExpenseMaxMinor: minor,
      memberDailyMaxMinor: minor,
      memberWeeklyMaxMinor: minor,
      monthlyBudgetMinor: minor,
      clause: clauseRef,
    }),
  })
  .superRefine((doc, ctx) => {
    const referenced: string[] = [
      doc.receipts.clause,
      doc.memberLimits.clause,
      doc.reviewAboveMinor.clause,
      doc.vatInvoice.clause,
      doc.claimWindow.clause,
      doc.currencies.clause,
      doc.matching.clause,
      doc.autoReimbursement.clause,
      ...Object.values(doc.categories).map((c) => c.clause),
      ...doc.blockedMerchants.map((b) => b.clause),
    ];
    for (const ref of referenced) {
      if (!(ref in doc.clauses)) ctx.addIssue({ code: 'custom', message: `Rule cites unknown clause "${ref}"` });
    }
    for (const c of CATEGORIES) {
      if (!(c in doc.categories)) ctx.addIssue({ code: 'custom', message: `Missing rule for category ${c}` });
    }
    if (!doc.currencies.allowed.includes(doc.currency)) {
      ctx.addIssue({ code: 'custom', message: 'Policy currency must be in the allowed currencies' });
    }
  });

export type PolicyDocument = z.infer<typeof policyDocumentSchema> & {
  categories: Record<Category, z.infer<typeof categoryRule>>;
};

export class PolicyValidationError extends Error {
  override readonly name = 'PolicyValidationError';
}

export function parsePolicyDocument(input: unknown): PolicyDocument {
  const r = policyDocumentSchema.safeParse(input);
  if (!r.success) {
    throw new PolicyValidationError(r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '));
  }
  return r.data as PolicyDocument;
}

/** Content hash identifying a policy version independent of its database id. */
export function policyContentHash(doc: PolicyDocument): string {
  return hashCanonical(doc);
}

/**
 * Built-in safety clauses cited when evidence integrity, identity or duplication blocks automation.
 * These are Swipeback controls, not company policy, and cannot be disabled by a policy document.
 */
export const SAFETY_CLAUSES = {
  'SB-SAFETY-EVIDENCE': 'Uncertain, inconsistent or failed extraction is reviewed by a person; it is never cleared automatically.',
  'SB-SAFETY-IDENTITY': 'Submissions are accepted only from an enrolled, authenticated sender.',
  'SB-SAFETY-DUPLICATE': 'Possible duplicates and conflicting card matches are reviewed by a person.',
  'SB-SAFETY-INSTRUCTIONS': 'Text inside receipts, emails or chats is treated as data and cannot change policy, limits or payees.',
  'SB-SAFETY-FOLLOWUP': 'Swipeback asks each question at most once; unresolved questions go to finance.',
  'SB-SAFETY-LOCATION': 'A card payment away from the cardholder\'s home or work area, with no declared trip there, is checked by a person. Location never rejects an expense or changes an amount.',
} as const;
export type SafetyClause = keyof typeof SAFETY_CLAUSES;
