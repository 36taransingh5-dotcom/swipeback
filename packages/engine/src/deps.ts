import type { ChannelAdapter, EvidenceStore } from '@swipeback/channels';
import type { Pool, PoolClient } from '@swipeback/db';
import { assertTransition, EXPENSE_MACHINE, REIMBURSEMENT_MACHINE, type ExpenseState, type ReimbursementState } from '@swipeback/domain';
import type { Extractor } from '@swipeback/extraction';
import type { PayoutProvider } from '@swipeback/payouts';

export interface Clock {
  now(): Date;
}
export const systemClock: Clock = { now: () => new Date() };

export interface ChannelRegistry {
  adapterFor(provider: string): ChannelAdapter;
}

export function channelRegistry(adapters: readonly ChannelAdapter[]): ChannelRegistry {
  const byProvider = new Map(adapters.map((a) => [a.provider, a]));
  return {
    adapterFor(provider) {
      const a = byProvider.get(provider);
      if (!a) throw new Error(`no channel adapter registered for provider "${provider}"`);
      return a;
    },
  };
}

export interface EngineConfig {
  /** Base URL of the authenticated review app (links in emails point here; they never authenticate). */
  appUrl: string;
  /** HMAC secret for the card-feed simulator webhook. */
  cardFeedSecret: string;
  /** Minutes before an unanswered question gets its one reminder, and then before it expires (defaults 24h each). */
  questionReminderMinutes?: number;
  questionExpiryMinutes?: number;
}

export interface EngineDeps {
  pool: Pool;
  clock: Clock;
  extractor: Extractor;
  payouts: PayoutProvider;
  channels: ChannelRegistry;
  evidence: EvidenceStore;
  config: EngineConfig;
}

/** Move an expense through one or more states, each checked against the domain machine (and the DB trigger). */
export async function moveExpense(c: PoolClient, expenseId: string, from: ExpenseState, ...path: ExpenseState[]): Promise<ExpenseState> {
  let current = from;
  for (const next of path) {
    if (next === current) continue;
    assertTransition(EXPENSE_MACHINE, current, next);
    const r = await c.query('UPDATE expenses SET state = $3 WHERE id = $1 AND state = $2', [expenseId, current, next]);
    if (r.rowCount !== 1) throw new ConcurrentModificationError(`expense ${expenseId} is no longer ${current}`);
    current = next;
  }
  return current;
}

export async function moveReimbursement(
  c: PoolClient,
  reimbursementId: string,
  from: ReimbursementState,
  ...path: ReimbursementState[]
): Promise<ReimbursementState> {
  let current = from;
  for (const next of path) {
    assertTransition(REIMBURSEMENT_MACHINE, current, next);
    const r = await c.query('UPDATE reimbursements SET state = $3 WHERE id = $1 AND state = $2', [reimbursementId, current, next]);
    if (r.rowCount !== 1) throw new ConcurrentModificationError(`reimbursement ${reimbursementId} is no longer ${current}`);
    current = next;
  }
  return current;
}

export class ConcurrentModificationError extends Error {
  override readonly name = 'ConcurrentModificationError';
}

export async function lockKey(c: PoolClient, key: string): Promise<void> {
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
}
