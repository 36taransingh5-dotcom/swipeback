import { randomBytes } from 'node:crypto';
import type { Pool } from '@swipeback/db';

/**
 * Payout provider port. Production would bind a verified, regulated payout provider with
 * treasury authorisation; the hackathon build binds only MockPay (simulated, no funds move).
 *
 * Contract required of any provider:
 *  - createPayout is idempotent on idempotencyKey (same key -> same payout, never a second one);
 *  - getPayout(idempotencyKey) lets the caller resolve an unknown outcome before retrying.
 */
export interface PayoutRequest {
  idempotencyKey: string;
  amountMinor: number;
  currency: string;
  destinationRef: string;
  reference: string;
}

export interface PayoutRecord {
  status: 'SUCCEEDED' | 'FAILED';
  providerRef: string;
}

export interface PayoutProvider {
  readonly name: string;
  readonly simulated: boolean;
  createPayout(req: PayoutRequest): Promise<PayoutRecord>;
  getPayout(idempotencyKey: string): Promise<PayoutRecord | null>;
}

/** The outcome of the call is unknown to the caller (e.g. network timeout). Never assume either way. */
export class PayoutOutcomeUnknownError extends Error {
  override readonly name = 'PayoutOutcomeUnknownError';
}
export class PayoutProviderError extends Error {
  override readonly name = 'PayoutProviderError';
}

export type MockFailure =
  /** The provider records the payout, but the response is lost (classic double-pay trap). */
  | 'TIMEOUT_AFTER_COMMIT'
  /** The request never reaches the provider. */
  | 'TIMEOUT_BEFORE_COMMIT'
  /** The provider rejects the request with a server error; nothing recorded. */
  | 'SERVER_ERROR'
  /** The provider declines the payout (recorded as FAILED). */
  | 'DECLINED';

/**
 * MockPay: a simulated provider whose ledger lives in the `mockpay` schema, standing in for the
 * provider's own database. Failure modes can be queued to exercise retry semantics.
 */
export class MockPayProvider implements PayoutProvider {
  readonly name = 'mockpay';
  readonly simulated = true;
  private readonly failures: MockFailure[] = [];

  constructor(
    private readonly pool: Pool,
    private readonly opts: { latencyMs?: number } = {},
  ) {}

  failNext(...modes: MockFailure[]): void {
    this.failures.push(...modes);
  }

  async createPayout(req: PayoutRequest): Promise<PayoutRecord> {
    if (!Number.isSafeInteger(req.amountMinor) || req.amountMinor <= 0) throw new PayoutProviderError('invalid amount');
    await this.delay();
    const failure = this.failures.shift();
    if (failure === 'TIMEOUT_BEFORE_COMMIT') {
      await this.log('create', req.idempotencyKey, 'timeout_before_commit');
      throw new PayoutOutcomeUnknownError('MockPay: request timed out');
    }
    if (failure === 'SERVER_ERROR') {
      await this.log('create', req.idempotencyKey, 'server_error');
      throw new PayoutProviderError('MockPay: 503 service unavailable');
    }
    const status = failure === 'DECLINED' ? 'FAILED' : 'SUCCEEDED';
    const providerRef = `SIMULATED-MP-${randomBytes(6).toString('hex').toUpperCase()}`;
    // Idempotent on the key: a repeated request returns the original payout.
    const { rows } = await this.pool.query<{ status: 'SUCCEEDED' | 'FAILED'; provider_ref: string; inserted: boolean }>(
      `WITH ins AS (
         INSERT INTO mockpay.payouts (idempotency_key, provider_ref, destination_ref, amount_minor, currency, reference, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING status, provider_ref, true AS inserted)
       SELECT * FROM ins
       UNION ALL
       SELECT status, provider_ref, false FROM mockpay.payouts WHERE idempotency_key = $1 AND NOT EXISTS (SELECT 1 FROM ins)`,
      [req.idempotencyKey, providerRef, req.destinationRef, req.amountMinor, req.currency, req.reference, status],
    );
    // A concurrent identical request may have committed between our insert and select.
    const row =
      rows[0] ??
      (
        await this.pool.query<{ status: 'SUCCEEDED' | 'FAILED'; provider_ref: string; inserted: boolean }>(
          'SELECT status, provider_ref, false AS inserted FROM mockpay.payouts WHERE idempotency_key = $1',
          [req.idempotencyKey],
        )
      ).rows[0]!;
    await this.log('create', req.idempotencyKey, row.inserted ? `created_${row.status.toLowerCase()}` : 'idempotent_replay');
    if (failure === 'TIMEOUT_AFTER_COMMIT') throw new PayoutOutcomeUnknownError('MockPay: response lost after commit');
    return { status: row.status, providerRef: row.provider_ref };
  }

  async getPayout(idempotencyKey: string): Promise<PayoutRecord | null> {
    await this.delay();
    const { rows } = await this.pool.query<{ status: 'SUCCEEDED' | 'FAILED'; provider_ref: string }>(
      'SELECT status, provider_ref FROM mockpay.payouts WHERE idempotency_key = $1',
      [idempotencyKey],
    );
    await this.log('get', idempotencyKey, rows[0] ? 'found' : 'not_found');
    return rows[0] ? { status: rows[0].status, providerRef: rows[0].provider_ref } : null;
  }

  /** Test/eval helper: how many payouts the provider holds (should equal reimbursements paid). */
  async ledgerCount(): Promise<number> {
    const { rows } = await this.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM mockpay.payouts WHERE status = 'SUCCEEDED'`);
    return rows[0]!.n;
  }

  private async log(operation: 'create' | 'get', key: string, outcome: string): Promise<void> {
    await this.pool.query('INSERT INTO mockpay.calls (operation, idempotency_key, outcome) VALUES ($1, $2, $3)', [operation, key, outcome]);
  }

  private async delay(): Promise<void> {
    if (this.opts.latencyMs) await new Promise((r) => setTimeout(r, this.opts.latencyMs));
  }
}
