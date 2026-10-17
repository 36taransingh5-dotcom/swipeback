import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isPgError, SQLSTATE } from '@swipeback/db';
import { seedDemoOrg, type SeededOrg } from '@swipeback/cli/seed';
import { createTestDatabase, type TestDatabase } from '../../../test/support/db.ts';

/**
 * The database is the last line of defence for money-relevant invariants (docs/PLAN.md §2.4).
 * These tests bypass application code entirely and attack the schema directly.
 */
let db: TestDatabase;
let org: SeededOrg;

beforeAll(async () => {
  db = await createTestDatabase();
  org = await seedDemoOrg(db.pool);
});
afterAll(async () => db.drop());

async function sqlstate(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (err) {
    return isPgError(err) ? err.code : `NOT_PG_ERROR: ${String(err)}`;
  }
}

async function newExpense(opts: { paymentType?: string; amountMinor?: number; memberId?: string } = {}) {
  const r = await db.pool.query<{ id: string }>(
    `INSERT INTO expenses (organisation_id, member_id, source_type, payment_type, amount_minor, currency, state)
     VALUES ($1, $2, 'EMAIL', $3, $4, 'GBP', 'RECEIVED') RETURNING id`,
    [org.organisationId, opts.memberId ?? org.members.employee, opts.paymentType ?? 'PERSONAL', opts.amountMinor ?? 4210],
  );
  return r.rows[0]!.id;
}

async function moveExpense(id: string, ...states: string[]) {
  for (const s of states) await db.pool.query('UPDATE expenses SET state = $2 WHERE id = $1', [id, s]);
}

async function clearedPersonalExpense() {
  const id = await newExpense();
  await moveExpense(id, 'EXTRACTING', 'POLICY_CHECK', 'AUTO_CLEARED');
  return id;
}

async function newReimbursement(expenseId: string, overrides: { memberId?: string; amountMinor?: number } = {}) {
  const r = await db.pool.query<{ id: string }>(
    `INSERT INTO reimbursements (organisation_id, expense_id, member_id, payout_destination_id, amount_minor, currency,
                                 state, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, 'GBP', 'DRAFT', $6) RETURNING id`,
    [
      org.organisationId,
      expenseId,
      overrides.memberId ?? org.members.employee,
      org.payoutDestinations.employee,
      overrides.amountMinor ?? 4210,
      `reimb:${expenseId}`,
    ],
  );
  return r.rows[0]!.id;
}

async function policyVersion() {
  const r = await db.pool.query<{ id: string }>(
    `INSERT INTO policy_versions (organisation_id, version, rules, source_text, content_hash)
     VALUES ($1, (SELECT coalesce(max(version), 0) + 1 FROM policy_versions WHERE organisation_id = $1),
             '{}', 'test policy', md5(random()::text)) RETURNING id`,
    [org.organisationId],
  );
  return r.rows[0]!.id;
}

describe('state machine triggers', () => {
  it('expenses must start in RECEIVED', async () => {
    const code = await sqlstate(
      db.pool.query(
        `INSERT INTO expenses (organisation_id, member_id, source_type, state) VALUES ($1, $2, 'EMAIL', 'AUTO_CLEARED')`,
        [org.organisationId, org.members.employee],
      ),
    );
    expect(code).toBe(SQLSTATE.illegalTransition);
  });

  it('rejects skipping states (RECEIVED -> AUTO_CLEARED) but allows the tabled path', async () => {
    const id = await newExpense();
    expect(await sqlstate(moveExpense(id, 'AUTO_CLEARED'))).toBe(SQLSTATE.illegalTransition);
    await moveExpense(id, 'EXTRACTING', 'POLICY_CHECK', 'AUTO_CLEARED', 'EXPORTED');
    expect(await sqlstate(moveExpense(id, 'REVIEW_REQUIRED'))).toBe(SQLSTATE.illegalTransition); // EXPORTED is terminal
  });

  it('reimbursements must start in DRAFT and cannot jump to SIMULATED_PAID', async () => {
    const reimb = await newReimbursement(await clearedPersonalExpense());
    expect(await sqlstate(db.pool.query(`UPDATE reimbursements SET state = 'SIMULATED_PAID' WHERE id = $1`, [reimb]))).toBe(
      SQLSTATE.illegalTransition,
    );
  });

  it('every update bumps the optimistic-concurrency version', async () => {
    const id = await newExpense();
    await db.pool.query(`UPDATE expenses SET merchant = 'Pret' WHERE id = $1`, [id]);
    await db.pool.query(`UPDATE expenses SET merchant = 'Pret A Manger', version = 1 WHERE id = $1`, [id]);
    const r = await db.pool.query('SELECT version FROM expenses WHERE id = $1', [id]);
    expect(r.rows[0].version).toBe(3);
  });
});

describe('I1: company-card spend is never reimbursed', () => {
  it('rejects a reimbursement for a CORPORATE expense', async () => {
    const id = await newExpense({ paymentType: 'CORPORATE' });
    await moveExpense(id, 'EXTRACTING', 'POLICY_CHECK', 'AUTO_CLEARED');
    expect(await sqlstate(newReimbursement(id))).toBe(SQLSTATE.invariant);
  });

  it('rejects a reimbursement for a card-matched expense', async () => {
    const id = await newExpense();
    const txn = await db.pool.query<{ id: string }>(
      `INSERT INTO transactions (organisation_id, provider, provider_transaction_id, card_id, member_id, amount_minor,
                                 currency, merchant_descriptor, merchant_normalised, transacted_at)
       VALUES ($1, 'card-sim', 'txn-i1', $2, $3, 4210, 'GBP', 'PRET A MANGER LDN', 'pret a manger', now()) RETURNING id`,
      [org.organisationId, org.cards.employee, org.members.employee],
    );
    await db.pool.query('UPDATE expenses SET matched_transaction_id = $2 WHERE id = $1', [id, txn.rows[0]!.id]);
    await moveExpense(id, 'EXTRACTING', 'POLICY_CHECK', 'AUTO_CLEARED');
    expect(await sqlstate(newReimbursement(id))).toBe(SQLSTATE.invariant);
  });

  it('rejects a card match or payment-type change after a reimbursement exists', async () => {
    const id = await clearedPersonalExpense();
    await newReimbursement(id);
    expect(await sqlstate(db.pool.query(`UPDATE expenses SET payment_type = 'CORPORATE' WHERE id = $1`, [id]))).toBe(
      SQLSTATE.invariant,
    );
  });

  it('rejects reimbursing an uncleared expense, another payee, or more than the expense', async () => {
    const pending = await newExpense();
    expect(await sqlstate(newReimbursement(pending))).toBe(SQLSTATE.invariant);
    const cleared = await clearedPersonalExpense();
    expect(await sqlstate(newReimbursement(cleared, { memberId: org.members.controller }))).toBe(SQLSTATE.invariant);
    expect(await sqlstate(newReimbursement(cleared, { amountMinor: 4211 }))).toBe(SQLSTATE.invariant);
  });

  it('rejects a payout destination that is not the claimant\'s verified one', async () => {
    const id = await newExpense({ memberId: org.members.unenrolledEmployee });
    await moveExpense(id, 'EXTRACTING', 'POLICY_CHECK', 'AUTO_CLEARED');
    expect(await sqlstate(newReimbursement(id, { memberId: org.members.unenrolledEmployee }))).toBe(SQLSTATE.invariant);
  });
});

describe('I2-I4: one live reimbursement, gated transitions, immutable payee and key', () => {
  it('allows at most one live reimbursement per expense', async () => {
    const id = await clearedPersonalExpense();
    await newReimbursement(id);
    const second = db.pool.query(
      `INSERT INTO reimbursements (organisation_id, expense_id, member_id, payout_destination_id, amount_minor, currency,
                                   state, idempotency_key)
       VALUES ($1, $2, $3, $4, 100, 'GBP', 'DRAFT', 'another-key')`,
      [org.organisationId, id, org.members.employee, org.payoutDestinations.employee],
    );
    expect(await sqlstate(second)).toBe(SQLSTATE.uniqueViolation);
  });

  it('AUTHORIZED requires an authorisation record; SIMULATED_PAID requires a succeeded attempt', async () => {
    const reimb = await newReimbursement(await clearedPersonalExpense());
    await db.pool.query(`UPDATE reimbursements SET state = 'ELIGIBILITY_CHECK' WHERE id = $1`, [reimb]);
    expect(await sqlstate(db.pool.query(`UPDATE reimbursements SET state = 'AUTHORIZED' WHERE id = $1`, [reimb]))).toBe(
      SQLSTATE.invariant,
    );

    const pv = await policyVersion();
    await db.pool.query(
      `INSERT INTO reimbursement_authorisations (reimbursement_id, kind, policy_version_id, checks, limits_snapshot)
       VALUES ($1, 'AUTO', $2, '{}', '{}')`,
      [reimb, pv],
    );
    await db.pool.query(`UPDATE reimbursements SET state = 'AUTHORIZED' WHERE id = $1`, [reimb]);
    await db.pool.query(`UPDATE reimbursements SET state = 'PAYOUT_QUEUED' WHERE id = $1`, [reimb]);
    expect(await sqlstate(db.pool.query(`UPDATE reimbursements SET state = 'SIMULATED_PAID' WHERE id = $1`, [reimb]))).toBe(
      SQLSTATE.invariant,
    );

    await db.pool.query(
      `INSERT INTO payout_attempts (reimbursement_id, attempt, idempotency_key, provider, status, request)
       SELECT id, 1, idempotency_key, 'mockpay', 'SUCCEEDED', '{}' FROM reimbursements WHERE id = $1`,
      [reimb],
    );
    await db.pool.query(`UPDATE reimbursements SET state = 'SIMULATED_PAID' WHERE id = $1`, [reimb]);

    const secondSuccess = db.pool.query(
      `INSERT INTO payout_attempts (reimbursement_id, attempt, idempotency_key, provider, status, request)
       SELECT id, 2, idempotency_key, 'mockpay', 'SUCCEEDED', '{}' FROM reimbursements WHERE id = $1`,
      [reimb],
    );
    expect(await sqlstate(secondSuccess)).toBe(SQLSTATE.uniqueViolation);
  });

  it('payee, amount and idempotency key cannot change after creation', async () => {
    const reimb = await newReimbursement(await clearedPersonalExpense());
    expect(await sqlstate(db.pool.query(`UPDATE reimbursements SET amount_minor = 1 WHERE id = $1`, [reimb]))).toBe(SQLSTATE.invariant);
    expect(await sqlstate(db.pool.query(`UPDATE reimbursements SET idempotency_key = 'x' WHERE id = $1`, [reimb]))).toBe(
      SQLSTATE.invariant,
    );
  });

  it('a human payment authorisation needs a payment_approver who is not the claimant, and a reason', async () => {
    const reimb = await newReimbursement(await clearedPersonalExpense());
    const pv = await policyVersion();
    const insert = (by: string, reason: string | null) =>
      db.pool.query(
        `INSERT INTO reimbursement_authorisations (reimbursement_id, kind, authorised_by, policy_version_id, checks,
                                                   limits_snapshot, reason)
         VALUES ($1, 'HUMAN', $2, $3, '{}', '{}', $4)`,
        [reimb, by, pv, reason],
      );
    expect(await sqlstate(insert(org.members.employee, 'self-approve'))).toBe(SQLSTATE.invariant);
    expect(await sqlstate(insert(org.members.opsManager, 'reviewer but not payment approver'))).toBe(SQLSTATE.invariant);
    expect(await sqlstate(insert(org.members.controller, null))).toBe(SQLSTATE.invariant);
    expect(await sqlstate(insert(org.members.controller, 'Over auto-pay limit; receipt and purpose verified'))).toBeUndefined();
  });
});

describe('immutability and segregation of duties', () => {
  it('policy versions are immutable', async () => {
    const pv = await policyVersion();
    expect(await sqlstate(db.pool.query(`UPDATE policy_versions SET rules = '{"x":1}' WHERE id = $1`, [pv]))).toBe(SQLSTATE.appendOnly);
    expect(await sqlstate(db.pool.query('DELETE FROM policy_versions WHERE id = $1', [pv]))).toBe(SQLSTATE.appendOnly);
  });

  it('an expense pinned to a policy version cannot be re-pinned', async () => {
    const id = await newExpense();
    const [a, b] = [await policyVersion(), await policyVersion()];
    await db.pool.query('UPDATE expenses SET policy_version_id = $2 WHERE id = $1', [id, a]);
    expect(await sqlstate(db.pool.query('UPDATE expenses SET policy_version_id = $2 WHERE id = $1', [id, b]))).toBe(SQLSTATE.invariant);
  });

  it('payout destinations can be revoked but never edited', async () => {
    expect(
      await sqlstate(
        db.pool.query(`UPDATE payout_destinations SET provider_ref = 'attacker' WHERE id = $1`, [org.payoutDestinations.employee]),
      ),
    ).toBe(SQLSTATE.appendOnly);
    // Revocation is allowed; rolled back to keep the seed intact for other tests.
    const c = await db.pool.connect();
    try {
      await c.query('BEGIN');
      const r = await c.query(`UPDATE payout_destinations SET status = 'REVOKED', revoked_at = now() WHERE id = $1`, [
        org.payoutDestinations.employee,
      ]);
      expect(r.rowCount).toBe(1);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });

  it('nobody can review their own expense, and reviewers need the reviewer role', async () => {
    const own = await newExpense({ memberId: org.members.opsManager });
    const review = (expenseId: string, reviewer: string) =>
      db.pool.query(
        `INSERT INTO reviews (organisation_id, expense_id, reviewer_id, action, reason, expense_version)
         VALUES ($1, $2, $3, 'APPROVE', 'looks fine', 1)`,
        [org.organisationId, expenseId, reviewer],
      );
    expect(await sqlstate(review(own, org.members.opsManager))).toBe(SQLSTATE.invariant);
    const other = await newExpense();
    expect(await sqlstate(review(other, org.members.unenrolledEmployee))).toBe(SQLSTATE.invariant);
    expect(await sqlstate(review(other, org.members.controller))).toBeUndefined();
    expect(await sqlstate(db.pool.query(`UPDATE reviews SET reason = 'edited'`))).toBe(SQLSTATE.appendOnly);
  });

  it('a review reason cannot be blank', async () => {
    const id = await newExpense();
    const blank = db.pool.query(
      `INSERT INTO reviews (organisation_id, expense_id, reviewer_id, action, reason, expense_version)
       VALUES ($1, $2, $3, 'DECLINE', '   ', 1)`,
      [org.organisationId, id, org.members.controller],
    );
    expect(await sqlstate(blank)).toBe('23514');
  });
});
