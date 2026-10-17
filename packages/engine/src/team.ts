import { CATEGORIES, isIsoDate } from '@swipeback/domain';
import type { SessionMember } from './auth.ts';
import type { EngineDeps } from './deps.ts';
import { ReviewError } from './review.ts';

/**
 * Read models for the team spend dashboard: who is spending what, where, and when. Monitoring
 * only — nothing here changes an expense. Every query is scoped to the viewer's organisation.
 */

export const SPEND_SORTS = ['date', 'amount', 'category', 'merchant', 'status'] as const;
export const TEAM_SORTS = ['name', 'spend', 'count', 'last'] as const;
/** Filter value for expenses with no category yet (unreadable or still being processed). */
export const UNCATEGORISED = 'NONE';

export type SpendSort = (typeof SPEND_SORTS)[number];
export type TeamSort = (typeof TEAM_SORTS)[number];
export type SortDir = 'asc' | 'desc';

export interface SpendFilters {
  from: string | null;
  to: string | null;
  category: string | null;
  state: string | null;
  sort: SpendSort;
  dir: SortDir;
}

export interface TeamFilters {
  from: string | null;
  to: string | null;
  category: string | null;
  sort: TeamSort;
  dir: SortDir;
}

export interface MoneyTotal {
  currency: string;
  amountMinor: number;
}

export interface CategoryTotal {
  category: string | null;
  count: number;
  totals: MoneyTotal[];
}

export interface TeamMemberSummary {
  memberId: string;
  name: string;
  email: string;
  roles: string[];
  status: string;
  cards: string[];
  expenseCount: number;
  totals: MoneyTotal[];
  lastDate: string | null;
  topCategory: string | null;
  needsReview: number;
  waiting: number;
}

export interface SpendRow {
  expenseId: string;
  ref: string;
  date: string;
  merchant: string | null;
  category: string | null;
  amountMinor: number | null;
  currency: string | null;
  paymentType: string;
  state: string;
  cardLast4: string | null;
  reimbursementState: string | null;
}

export interface TeamOverview {
  members: TeamMemberSummary[];
  byCategory: CategoryTotal[];
  totals: MoneyTotal[];
  baseCurrency: string;
}

export interface MemberSpend {
  member: Omit<TeamMemberSummary, 'expenseCount' | 'totals' | 'lastDate' | 'topCategory' | 'needsReview' | 'waiting'>;
  rows: SpendRow[];
  byCategory: CategoryTotal[];
  totals: MoneyTotal[];
}

const EXPENSE_STATES = ['RECEIVED', 'EXTRACTING', 'NEEDS_MATCH', 'NEEDS_INFO', 'POLICY_CHECK', 'AUTO_CLEARED', 'REVIEW_REQUIRED', 'APPROVED', 'REJECTED', 'EXPORTED'] as const;
export const SPEND_STATES: readonly string[] = EXPENSE_STATES;

const pick = <T extends string>(v: string | undefined, allowed: readonly T[], fallback: T): T => ((allowed as readonly string[]).includes(v ?? '') ? (v as T) : fallback);
const date = (v: string | undefined) => (v && isIsoDate(v) ? v : null);
const category = (v: string | undefined) => (v === UNCATEGORISED || (CATEGORIES as readonly string[]).includes(v ?? '') ? v! : null);

/** Query-string filters are untrusted: anything unrecognised is dropped, never passed to SQL. */
export function parseSpendFilters(q: Record<string, string | undefined>): SpendFilters {
  const sort = pick(q.sort, SPEND_SORTS, 'date');
  return {
    from: date(q.from), to: date(q.to), category: category(q.category),
    state: SPEND_STATES.includes(q.state ?? '') ? q.state! : null,
    sort, dir: pick(q.dir, ['asc', 'desc'] as const, sort === 'date' || sort === 'amount' ? 'desc' : 'asc'),
  };
}

export function parseTeamFilters(q: Record<string, string | undefined>): TeamFilters {
  const sort = pick(q.sort, TEAM_SORTS, 'spend');
  return { from: date(q.from), to: date(q.to), category: category(q.category), sort, dir: pick(q.dir, ['asc', 'desc'] as const, sort === 'name' ? 'asc' : 'desc') };
}

function requireFinance(actor: SessionMember) {
  if (!actor.roles.some((r) => r === 'reviewer' || r === 'admin' || r === 'payment_approver')) throw new ReviewError(403, 'You need a finance role to see team spending');
}

/** The date an expense is filed under: the receipt date, else the card swipe, else when it arrived. */
const SPEND_DATE = `coalesce(e.expense_date, (t.transacted_at AT TIME ZONE o.timezone)::date, (e.created_at AT TIME ZONE o.timezone)::date)`;

/** Shared WHERE clause for both read models; parameters $1 (org) onwards are appended by the caller. */
function where(f: { from: string | null; to: string | null; category: string | null; state?: string | null }, params: unknown[]): string {
  const clauses = [`e.organisation_id = $1`, `e.state <> 'MERGED'`];
  const add = (sql: string, v: unknown) => {
    params.push(v);
    clauses.push(sql.replace('?', `$${params.length}`));
  };
  if (f.from) add(`${SPEND_DATE} >= ?::date`, f.from);
  if (f.to) add(`${SPEND_DATE} <= ?::date`, f.to);
  if (f.category === UNCATEGORISED) clauses.push('e.category IS NULL');
  else if (f.category) add('e.category = ?', f.category);
  if (f.state) add('e.state = ?', f.state);
  return clauses.join(' AND ');
}

const FROM = `FROM expenses e JOIN organisations o ON o.id = e.organisation_id LEFT JOIN transactions t ON t.id = e.matched_transaction_id`;

const groupTotals = (rows: { currency: string | null; total: number }[]): MoneyTotal[] =>
  rows.filter((r) => r.currency).map((r) => ({ currency: r.currency!, amountMinor: r.total })).sort((a, b) => b.amountMinor - a.amountMinor);

async function categoryTotals(deps: Pick<EngineDeps, 'pool'>, whereSql: string, params: unknown[]): Promise<CategoryTotal[]> {
  const r = await deps.pool.query<{ category: string | null; currency: string | null; count: number; total: number }>(
    `SELECT e.category, e.currency, count(*)::int AS count, coalesce(sum(e.amount_minor), 0)::bigint AS total ${FROM} WHERE ${whereSql} GROUP BY 1, 2`,
    params,
  );
  const by = new Map<string | null, CategoryTotal>();
  for (const row of r.rows) {
    const c = by.get(row.category) ?? { category: row.category, count: 0, totals: [] };
    c.count += row.count;
    if (row.currency) c.totals.push({ currency: row.currency, amountMinor: row.total });
    by.set(row.category, c);
  }
  return [...by.values()].map((c) => ({ ...c, totals: c.totals.sort((a, b) => b.amountMinor - a.amountMinor) })).sort((a, b) => (b.totals[0]?.amountMinor ?? 0) - (a.totals[0]?.amountMinor ?? 0) || b.count - a.count);
}

async function overallTotals(deps: Pick<EngineDeps, 'pool'>, whereSql: string, params: unknown[]): Promise<MoneyTotal[]> {
  const r = await deps.pool.query<{ currency: string | null; total: number }>(`SELECT e.currency, coalesce(sum(e.amount_minor), 0)::bigint AS total ${FROM} WHERE ${whereSql} GROUP BY 1`, params);
  return groupTotals(r.rows);
}

export async function teamOverview(deps: Pick<EngineDeps, 'pool'>, actor: SessionMember, f: TeamFilters): Promise<TeamOverview> {
  requireFinance(actor);
  const params: unknown[] = [actor.organisationId];
  const w = where(f, params);
  const members = await deps.pool.query<{ id: string; display_name: string; email: string; roles: string[]; status: string; cards: string[] | null }>(
    `SELECT m.id, m.display_name, m.email, m.roles, m.status,
            (SELECT array_agg(c.last4 ORDER BY c.created_at) FROM cards c WHERE c.member_id = m.id AND c.status <> 'CLOSED') AS cards
       FROM members m WHERE m.organisation_id = $1`,
    [actor.organisationId],
  );
  const spend = await deps.pool.query<{ member_id: string; currency: string | null; count: number; total: number; last: string | null; review: number; waiting: number }>(
    `SELECT e.member_id, e.currency, count(*)::int AS count, coalesce(sum(e.amount_minor), 0)::bigint AS total, max(${SPEND_DATE}) AS last,
            count(*) FILTER (WHERE e.state = 'REVIEW_REQUIRED')::int AS review, count(*) FILTER (WHERE e.state IN ('NEEDS_INFO','NEEDS_MATCH'))::int AS waiting
       ${FROM} WHERE ${w} GROUP BY 1, 2`,
    params,
  );
  const top = await deps.pool.query<{ member_id: string; category: string }>(
    `SELECT DISTINCT ON (e.member_id) e.member_id, e.category ${FROM} WHERE ${w} AND e.category IS NOT NULL
      GROUP BY e.member_id, e.category ORDER BY e.member_id, coalesce(sum(e.amount_minor), 0) DESC, count(*) DESC, e.category`,
    params,
  );
  const base = (await deps.pool.query<{ base_currency: string }>('SELECT base_currency FROM organisations WHERE id = $1', [actor.organisationId])).rows[0]?.base_currency ?? 'GBP';

  const rows: TeamMemberSummary[] = members.rows.map((m) => {
    const mine = spend.rows.filter((s) => s.member_id === m.id);
    return {
      memberId: m.id, name: m.display_name, email: m.email, roles: m.roles, status: m.status, cards: m.cards ?? [],
      expenseCount: mine.reduce((n, s) => n + s.count, 0),
      totals: groupTotals(mine),
      lastDate: mine.map((s) => s.last).filter((d): d is string => !!d).sort().at(-1) ?? null,
      topCategory: top.rows.find((t) => t.member_id === m.id)?.category ?? null,
      needsReview: mine.reduce((n, s) => n + s.review, 0),
      waiting: mine.reduce((n, s) => n + s.waiting, 0),
    };
  });
  // Spend is compared in the organisation's base currency; other currencies are shown, not converted.
  const inBase = (m: TeamMemberSummary) => m.totals.find((t) => t.currency === base)?.amountMinor ?? 0;
  const key: Record<TeamSort, (a: TeamMemberSummary, b: TeamMemberSummary) => number> = {
    name: (a, b) => a.name.localeCompare(b.name),
    spend: (a, b) => inBase(a) - inBase(b),
    count: (a, b) => a.expenseCount - b.expenseCount,
    last: (a, b) => (a.lastDate ?? '').localeCompare(b.lastDate ?? ''),
  };
  const sign = f.dir === 'asc' ? 1 : -1;
  rows.sort((a, b) => sign * key[f.sort](a, b) || a.name.localeCompare(b.name));

  return { members: rows, byCategory: await categoryTotals(deps, w, params), totals: await overallTotals(deps, w, params), baseCurrency: base };
}

const ORDER: Record<SpendSort, string> = {
  date: 'spend_date',
  amount: 'e.amount_minor',
  category: 'e.category',
  merchant: 'lower(e.merchant)',
  status: 'e.state',
};

export async function memberSpend(deps: Pick<EngineDeps, 'pool'>, actor: SessionMember, memberId: string, f: SpendFilters): Promise<MemberSpend> {
  requireFinance(actor);
  if (!/^[0-9a-f-]{36}$/.test(memberId)) throw new ReviewError(404, 'Team member not found');
  const m = (
    await deps.pool.query<{ id: string; display_name: string; email: string; roles: string[]; status: string; cards: string[] | null }>(
      `SELECT m.id, m.display_name, m.email, m.roles, m.status,
              (SELECT array_agg(c.last4 ORDER BY c.created_at) FROM cards c WHERE c.member_id = m.id AND c.status <> 'CLOSED') AS cards
         FROM members m WHERE m.id = $1 AND m.organisation_id = $2`,
      [memberId, actor.organisationId],
    )
  ).rows[0];
  if (!m) throw new ReviewError(404, 'Team member not found');

  const params: unknown[] = [actor.organisationId];
  const w = `${where(f, params)} AND e.member_id = $${params.push(memberId)}`;
  const dir = f.dir === 'asc' ? 'ASC' : 'DESC';
  const r = await deps.pool.query<{
    id: string; ref: string; spend_date: string; merchant: string | null; category: string | null; amount_minor: number | null; currency: string | null;
    payment_type: string; state: string; last4: string | null; reimbursement_state: string | null;
  }>(
    `SELECT e.id, e.ref, ${SPEND_DATE} AS spend_date, coalesce(e.merchant, t.merchant_descriptor) AS merchant, e.category, e.amount_minor, e.currency,
            e.payment_type, e.state, cd.last4,
            (SELECT r.state FROM reimbursements r WHERE r.expense_id = e.id ORDER BY r.created_at DESC LIMIT 1) AS reimbursement_state
       ${FROM} LEFT JOIN cards cd ON cd.id = t.card_id
      WHERE ${w}
      ORDER BY ${ORDER[f.sort]} ${dir} NULLS LAST, e.created_at DESC
      LIMIT 500`,
    params,
  );
  return {
    member: { memberId: m.id, name: m.display_name, email: m.email, roles: m.roles, status: m.status, cards: m.cards ?? [] },
    rows: r.rows.map((x) => ({
      expenseId: x.id, ref: x.ref, date: x.spend_date, merchant: x.merchant, category: x.category, amountMinor: x.amount_minor, currency: x.currency,
      paymentType: x.payment_type, state: x.state, cardLast4: x.last4, reimbursementState: x.reimbursement_state,
    })),
    byCategory: await categoryTotals(deps, w, params),
    totals: await overallTotals(deps, w, params),
  };
}
