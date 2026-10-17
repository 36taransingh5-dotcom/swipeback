import { hashCanonical } from './canonical.ts';
import { addDays, daysBetween, type IsoDate } from './dates.ts';
import type { DuplicateResult } from './duplicates.ts';
import type { MatchResult } from './matching.ts';
import { merchantTokens } from './merchant.ts';
import type { Money } from './money.ts';
import type { PaymentResolution } from './payment-type.ts';
import { policyContentHash, type PolicyDocument, type SafetyClause } from './policy-schema.ts';
import type { ExpenseState } from './state-machines.ts';
import { ENGINE_VERSION, type Category, type DecisionField, type IntegrityFlag, type QuestionKind } from './types.ts';

/**
 * Deterministic expense policy evaluation. The model never decides: it only supplies extracted
 * facts (with uncertainty) that arrive here as plain data.
 *
 * Outcome precedence (first non-empty class wins):
 *   1. INTEGRITY findings  -> HUMAN_REVIEW           (evidence, identity, duplicates, conflicts)
 *   2. REJECT findings     -> REJECT_FOR_CORRECTION  (not claimable as submitted)
 *   3. INFO findings       -> REQUEST_INFO           (exactly one question, highest priority first)
 *   4. LIMIT findings      -> HUMAN_REVIEW           (over caps / thresholds / foreign currency)
 *   5. otherwise           -> CLEAR
 */

export type PolicyOutcome = 'CLEAR' | 'REQUEST_INFO' | 'HUMAN_REVIEW' | 'REJECT_FOR_CORRECTION';
export type FindingClass = 'INTEGRITY' | 'REJECT' | 'INFO' | 'LIMIT';

export type ReasonCode =
  // integrity
  | IntegrityFlag
  | 'UNCERTAIN_DECISION_FIELD'
  | 'SENDER_UNVERIFIED'
  | 'MEMBER_INACTIVE'
  | 'DUPLICATE_EXACT'
  | 'DUPLICATE_POSSIBLE'
  | 'MATCH_CONFLICT'
  | 'PAYMENT_SOURCE_CONFLICT'
  | 'CARD_TRANSACTION_MISSING'
  | 'FUTURE_DATED'
  | 'NON_POSITIVE_AMOUNT'
  | 'QUESTION_UNRESOLVED'
  // reject
  | 'CATEGORY_NOT_ALLOWED'
  | 'MERCHANT_BLOCKED'
  | 'EXPENSE_TOO_OLD'
  | 'CURRENCY_NOT_ALLOWED'
  // info
  | 'PAYMENT_SOURCE_UNKNOWN'
  | 'MATCH_AMBIGUOUS'
  | 'RECEIPT_MISSING'
  | 'BUSINESS_PURPOSE_MISSING'
  | 'VAT_INVOICE_MISSING'
  // limit
  | 'CATEGORY_UNCLASSIFIED'
  | 'FOREIGN_CURRENCY'
  | 'CATEGORY_CAP_EXCEEDED'
  | 'CATEGORY_MONTHLY_CAP_EXCEEDED'
  | 'ABOVE_REVIEW_THRESHOLD'
  | 'MEMBER_DAILY_CAP_EXCEEDED'
  | 'MEMBER_WEEKLY_CAP_EXCEEDED'
  // clear
  | 'WITHIN_POLICY';

export interface Finding {
  code: ReasonCode;
  class: FindingClass;
  clauseId: string;
  detail: string;
}

export interface Question {
  kind: QuestionKind;
  reasonCode: ReasonCode;
  clauseId: string;
  /** For MATCH_CONFIRMATION: the candidate transaction ids the employee chooses between. */
  options?: string[];
}

export interface PolicyEvaluationInput {
  /** The organisation-local calendar date the evaluation is made on. */
  asOf: IsoDate;
  expense: {
    category: Category | null;
    amount: Money | null;
    date: IsoDate | null;
    merchant: string | null;
    businessPurpose: string | null;
    hasReceipt: boolean;
    hasVatInvoice: boolean;
    uncertainFields: readonly DecisionField[];
    flags: readonly IntegrityFlag[];
  };
  senderVerified: boolean;
  memberActive: boolean;
  match: MatchResult | null;
  payment: PaymentResolution;
  duplicates: DuplicateResult;
  /** Questions already asked for this expense (each is asked at most once). */
  questionsAsked: readonly QuestionKind[];
  /** Prior spend in policy currency, excluding this expense: same member same day / ISO week; same category this month. */
  spendBefore: { memberDay: number; memberWeek: number; categoryMonth: number };
}

export interface PolicyDecision {
  outcome: PolicyOutcome;
  reasonCodes: ReasonCode[];
  clauseIds: string[];
  findings: Finding[];
  question: Question | null;
  policyContentHash: string;
  engineVersion: string;
  inputsHash: string;
}

const INFO_PRIORITY: readonly ReasonCode[] = [
  'PAYMENT_SOURCE_UNKNOWN',
  'MATCH_AMBIGUOUS',
  'RECEIPT_MISSING',
  'BUSINESS_PURPOSE_MISSING',
  'VAT_INVOICE_MISSING',
];

const QUESTION_FOR: Partial<Record<ReasonCode, QuestionKind>> = {
  PAYMENT_SOURCE_UNKNOWN: 'PAYMENT_SOURCE',
  MATCH_AMBIGUOUS: 'MATCH_CONFIRMATION',
  RECEIPT_MISSING: 'RECEIPT',
  BUSINESS_PURPOSE_MISSING: 'BUSINESS_PURPOSE',
  VAT_INVOICE_MISSING: 'VAT_INVOICE',
};

const safety = (c: SafetyClause) => c;

export function evaluatePolicy(policy: PolicyDocument, input: PolicyEvaluationInput): PolicyDecision {
  const findings: Finding[] = [];
  const applied = new Set<string>();
  const add = (code: ReasonCode, cls: FindingClass, clauseId: string, detail: string) =>
    findings.push({ code, class: cls, clauseId, detail });
  const { expense: e } = input;

  // ---- 1. Integrity -----------------------------------------------------------------------
  for (const flag of [...new Set(e.flags)].sort()) {
    const clause = flag === 'INJECTION_SUSPECTED' ? safety('SB-SAFETY-INSTRUCTIONS') : safety('SB-SAFETY-EVIDENCE');
    add(flag, 'INTEGRITY', clause, `Evidence check raised ${flag}`);
  }
  const missing: DecisionField[] = [];
  if (!e.amount) missing.push('amount', 'currency');
  if (!e.date) missing.push('date');
  if (!e.merchant) missing.push('merchant');
  const uncertain = [...new Set([...e.uncertainFields, ...missing])].sort();
  if (uncertain.length) {
    add('UNCERTAIN_DECISION_FIELD', 'INTEGRITY', safety('SB-SAFETY-EVIDENCE'), `Uncertain or missing: ${uncertain.join(', ')}`);
  }
  if (!input.senderVerified) add('SENDER_UNVERIFIED', 'INTEGRITY', safety('SB-SAFETY-IDENTITY'), 'Sender is not an authenticated, enrolled member');
  if (!input.memberActive) add('MEMBER_INACTIVE', 'INTEGRITY', safety('SB-SAFETY-IDENTITY'), 'Member account is not active');
  if (input.duplicates.exact.length) {
    add('DUPLICATE_EXACT', 'INTEGRITY', safety('SB-SAFETY-DUPLICATE'), `Identical file already submitted (${input.duplicates.exact.length})`);
  }
  if (input.duplicates.possible.length) {
    add('DUPLICATE_POSSIBLE', 'INTEGRITY', safety('SB-SAFETY-DUPLICATE'), `Same merchant, date and total as ${input.duplicates.possible.length} other claim(s)`);
  }
  if (input.match?.status === 'CONFLICT') {
    add('MATCH_CONFLICT', 'INTEGRITY', safety('SB-SAFETY-DUPLICATE'), 'Matching card transaction is already linked to another expense');
  }
  if (input.payment.conflict) {
    add('PAYMENT_SOURCE_CONFLICT', 'INTEGRITY', safety('SB-SAFETY-EVIDENCE'), 'Payment evidence disagrees (card record vs stated payment)');
  }
  if (input.payment.action === 'MISSING_TRANSACTION') {
    add('CARD_TRANSACTION_MISSING', 'INTEGRITY', policy.matching.clause, 'Company card indicated but no card-feed transaction arrived');
  }
  if (e.date && daysBetween(addDays(input.asOf, 1), e.date) > 0) {
    add('FUTURE_DATED', 'INTEGRITY', safety('SB-SAFETY-EVIDENCE'), `Receipt date ${e.date} is in the future`);
  }
  if (e.amount && e.amount.amountMinor <= 0) {
    add('NON_POSITIVE_AMOUNT', 'INTEGRITY', safety('SB-SAFETY-EVIDENCE'), 'Total is zero or negative (refund/credit?)');
  }

  // ---- 2. Reject ----------------------------------------------------------------------------
  const categoryRule = e.category ? policy.categories[e.category] : null;
  if (categoryRule) applied.add(categoryRule.clause);
  if (categoryRule && !categoryRule.allowed) {
    add('CATEGORY_NOT_ALLOWED', 'REJECT', categoryRule.clause, `${e.category} expenses are not claimable`);
  }
  if (e.merchant) {
    const tokens = merchantTokens(e.merchant).join(' ');
    for (const b of policy.blockedMerchants) {
      const pattern = merchantTokens(b.pattern).join(' ');
      if (pattern && ` ${tokens} `.includes(` ${pattern} `)) {
        add('MERCHANT_BLOCKED', 'REJECT', b.clause, `Merchant matches non-claimable "${b.pattern}"`);
        break;
      }
    }
  }
  if (e.date) {
    applied.add(policy.claimWindow.clause);
    const age = daysBetween(e.date, input.asOf);
    if (age > policy.claimWindow.maxAgeDays) {
      add('EXPENSE_TOO_OLD', 'REJECT', policy.claimWindow.clause, `Expense is ${age} days old (limit ${policy.claimWindow.maxAgeDays})`);
    }
  }
  const currency = e.amount?.currency ?? null;
  if (currency && !policy.currencies.allowed.includes(currency)) {
    add('CURRENCY_NOT_ALLOWED', 'REJECT', policy.currencies.clause, `${currency} is not an accepted currency`);
  }

  // ---- 3. Info ------------------------------------------------------------------------------
  if (input.payment.action === 'ASK') {
    add('PAYMENT_SOURCE_UNKNOWN', 'INFO', policy.matching.clause, 'Not known whether a company card or personal funds were used');
  }
  if (input.match?.status === 'AMBIGUOUS') {
    add('MATCH_AMBIGUOUS', 'INFO', policy.matching.clause, `${input.match.candidates.length} card transactions could match`);
  }
  if (policy.receipts.required) {
    applied.add(policy.receipts.clause);
    if (!e.hasReceipt) add('RECEIPT_MISSING', 'INFO', policy.receipts.clause, 'No receipt attached');
  }
  if (categoryRule?.requiresBusinessPurpose && !e.businessPurpose?.trim()) {
    add('BUSINESS_PURPOSE_MISSING', 'INFO', categoryRule.clause, `${e.category} expenses need a business purpose`);
  }
  if (e.amount && currency === policy.currency && e.amount.amountMinor > policy.vatInvoice.requiredAboveMinor) {
    applied.add(policy.vatInvoice.clause);
    if (!e.hasVatInvoice) add('VAT_INVOICE_MISSING', 'INFO', policy.vatInvoice.clause, 'A VAT invoice is required at this amount');
  }

  // ---- 4. Limits ----------------------------------------------------------------------------
  if (!e.category) add('CATEGORY_UNCLASSIFIED', 'LIMIT', safety('SB-SAFETY-EVIDENCE'), 'Expense category could not be determined');
  if (e.amount && currency && policy.currencies.allowed.includes(currency) && currency !== policy.currency) {
    add('FOREIGN_CURRENCY', 'LIMIT', policy.currencies.clause, `${currency} expense needs finance review (no FX in automation)`);
  }
  if (e.amount && currency === policy.currency) {
    const amt = e.amount.amountMinor;
    if (categoryRule?.perExpenseCapMinor !== undefined && amt > categoryRule.perExpenseCapMinor) {
      add('CATEGORY_CAP_EXCEEDED', 'LIMIT', categoryRule.clause, `Above the ${e.category} cap of ${categoryRule.perExpenseCapMinor}`);
    }
    if (categoryRule?.monthlyCapMinor !== undefined && input.spendBefore.categoryMonth + amt > categoryRule.monthlyCapMinor) {
      add('CATEGORY_MONTHLY_CAP_EXCEEDED', 'LIMIT', categoryRule.clause, `Monthly ${e.category} cap of ${categoryRule.monthlyCapMinor} exceeded`);
    }
    applied.add(policy.reviewAboveMinor.clause);
    if (amt > policy.reviewAboveMinor.amountMinor) {
      add('ABOVE_REVIEW_THRESHOLD', 'LIMIT', policy.reviewAboveMinor.clause, `Above the finance review threshold of ${policy.reviewAboveMinor.amountMinor}`);
    }
    applied.add(policy.memberLimits.clause);
    if (input.spendBefore.memberDay + amt > policy.memberLimits.dailyCapMinor) {
      add('MEMBER_DAILY_CAP_EXCEEDED', 'LIMIT', policy.memberLimits.clause, `Daily limit of ${policy.memberLimits.dailyCapMinor} exceeded`);
    }
    if (input.spendBefore.memberWeek + amt > policy.memberLimits.weeklyCapMinor) {
      add('MEMBER_WEEKLY_CAP_EXCEEDED', 'LIMIT', policy.memberLimits.clause, `Weekly limit of ${policy.memberLimits.weeklyCapMinor} exceeded`);
    }
  }

  // ---- Outcome ------------------------------------------------------------------------------
  const of = (cls: FindingClass) => findings.filter((f) => f.class === cls);
  let outcome: PolicyOutcome;
  let question: Question | null = null;
  let decisive: Finding[];

  const integrity = of('INTEGRITY');
  const infos = of('INFO').sort((a, b) => INFO_PRIORITY.indexOf(a.code) - INFO_PRIORITY.indexOf(b.code));
  if (integrity.length) {
    outcome = 'HUMAN_REVIEW';
    decisive = integrity;
  } else if (of('REJECT').length) {
    outcome = 'REJECT_FOR_CORRECTION';
    decisive = of('REJECT');
  } else if (infos.length) {
    const first = infos[0]!;
    const kind = QUESTION_FOR[first.code]!;
    if (input.questionsAsked.includes(kind)) {
      // Never ask the same question twice: hand it to finance with the full context instead.
      const unresolved: Finding = {
        code: 'QUESTION_UNRESOLVED',
        class: 'INTEGRITY',
        clauseId: safety('SB-SAFETY-FOLLOWUP'),
        detail: `${kind} was already asked and remains unresolved`,
      };
      findings.push(unresolved);
      outcome = 'HUMAN_REVIEW';
      decisive = [unresolved, ...infos, ...of('LIMIT')];
    } else {
      outcome = 'REQUEST_INFO';
      decisive = [first];
      question = { kind, reasonCode: first.code, clauseId: first.clauseId };
      if (first.code === 'MATCH_AMBIGUOUS' && input.match?.status === 'AMBIGUOUS') {
        question.options = input.match.candidates.map((c) => c.transactionId);
      }
    }
  } else if (of('LIMIT').length) {
    outcome = 'HUMAN_REVIEW';
    decisive = of('LIMIT');
  } else {
    outcome = 'CLEAR';
    decisive = [];
  }

  const reasonCodes: ReasonCode[] = outcome === 'CLEAR' ? ['WITHIN_POLICY'] : uniqueSorted(decisive.map((f) => f.code));
  const clauseIds = outcome === 'CLEAR' ? uniqueSorted([...applied]) : uniqueSorted(decisive.map((f) => f.clauseId));
  const contentHash = policyContentHash(policy);

  return {
    outcome,
    reasonCodes,
    clauseIds,
    findings,
    question,
    policyContentHash: contentHash,
    engineVersion: ENGINE_VERSION,
    inputsHash: hashCanonical({ engine: ENGINE_VERSION, policy: contentHash, input }),
  };
}

function uniqueSorted<T extends string>(xs: readonly T[]): T[] {
  return [...new Set(xs)].sort();
}

// ---- Orchestration: wait for the card feed, then decide -------------------------------------

export type ExpenseDecision =
  | { kind: 'AWAIT_CARD_FEED'; waitMinutes: number; nextState: 'NEEDS_MATCH' }
  | { kind: 'POLICY'; decision: PolicyDecision; nextState: ExpenseState };

/**
 * Combine payment resolution with policy. While the card feed may still deliver a transaction we
 * wait — but only if nothing else is needed. Review and rejection never wait, and a question the
 * card feed cannot answer (purpose, which of several transactions, a VAT invoice) is asked now.
 */
export function decideExpense(policy: PolicyDocument, input: PolicyEvaluationInput): ExpenseDecision {
  const decision = evaluatePolicy(policy, input);
  const waiting = input.payment.action === 'WAIT';
  const waitable = decision.outcome === 'CLEAR';
  if (waiting && waitable) {
    return { kind: 'AWAIT_CARD_FEED', waitMinutes: input.payment.waitMinutes ?? 0, nextState: 'NEEDS_MATCH' };
  }
  return { kind: 'POLICY', decision, nextState: stateForDecision(decision) };
}

export function stateForDecision(d: PolicyDecision): ExpenseState {
  switch (d.outcome) {
    case 'CLEAR':
      return 'AUTO_CLEARED';
    case 'REQUEST_INFO':
      return d.question?.kind === 'MATCH_CONFIRMATION' ? 'NEEDS_MATCH' : 'NEEDS_INFO';
    case 'HUMAN_REVIEW':
      return 'REVIEW_REQUIRED';
    case 'REJECT_FOR_CORRECTION':
      return 'REJECTED';
  }
}
