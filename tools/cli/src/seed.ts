import { appendAudit, withTransaction, type Pool } from '@swipeback/db';
import { policyContentHash } from '@swipeback/domain';
import { DEMO_POLICY, DEMO_POLICY_TEXT } from './demo-policy.ts';

/**
 * Synthetic demo organisation. Every name, address, card and payout destination here is fictitious
 * and flagged `is_synthetic`. Real addresses can be substituted via env for the live email demo
 * (the employee's sending address and the reviewer's address), but nothing else is real.
 */
export interface SeedOptions {
  financeMailbox?: string;
  employeeEmail?: string;
  reviewerEmail?: string;
}

export interface SeededOrg {
  organisationId: string;
  members: {
    controller: string;
    employee: string;
    unenrolledEmployee: string;
    opsManager: string;
  };
  cards: { employee: string; unenrolledEmployee: string };
  payoutDestinations: { employee: string };
  policyVersionId: string;
  created: boolean;
}

export const DEMO_ORG_NAME = 'Northwind Field Services Ltd (SYNTHETIC DEMO)';

export function seedOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): SeedOptions {
  const opts: SeedOptions = {};
  if (env.SB_FINANCE_MAILBOX) opts.financeMailbox = env.SB_FINANCE_MAILBOX;
  if (env.SB_EMPLOYEE_EMAIL) opts.employeeEmail = env.SB_EMPLOYEE_EMAIL;
  if (env.SB_REVIEWER_EMAIL) opts.reviewerEmail = env.SB_REVIEWER_EMAIL;
  return opts;
}

/** Idempotent: returns the existing org if already seeded. */
export async function seedDemoOrg(pool: Pool, opts: SeedOptions = {}): Promise<SeededOrg> {
  return withTransaction(pool, async (c) => {
    const existing = await c.query<{ id: string }>('SELECT id FROM organisations WHERE name = $1', [DEMO_ORG_NAME]);
    if (existing.rows[0]) return { ...(await loadSeeded(pool, existing.rows[0].id)), created: false };

    const financeMailbox = (opts.financeMailbox ?? 'finance@northwind.example').toLowerCase();
    const org = await c.query<{ id: string }>(
      `INSERT INTO organisations (name, timezone, base_currency, designated_address, is_synthetic)
       VALUES ($1, 'Europe/London', 'GBP', $2, true) RETURNING id`,
      [DEMO_ORG_NAME, financeMailbox],
    );
    const organisationId = org.rows[0]!.id;

    const member = async (email: string, name: string, roles: string[], enrolment: string) => {
      const r = await c.query<{ id: string }>(
        `INSERT INTO members (organisation_id, email, display_name, roles, payout_enrolment_status)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [organisationId, email.toLowerCase(), name, roles, enrolment],
      );
      const id = r.rows[0]!.id;
      await c.query(
        `INSERT INTO channel_identities (organisation_id, member_id, channel, channel_address, verification_method)
         VALUES ($1, $2, 'email', $3, 'seed_enrolment')`,
        [organisationId, id, email.toLowerCase()],
      );
      return id;
    };

    const controller = await member(
      opts.reviewerEmail ?? 'finance.controller@northwind.example',
      'Priya Shah (Finance Controller, synthetic)',
      ['reviewer', 'payment_approver', 'admin'],
      'NOT_ENROLLED',
    );
    const employee = await member(
      opts.employeeEmail ?? 'sam.taylor@northwind.example',
      'Sam Taylor (Field Engineer, synthetic)',
      ['employee'],
      'VERIFIED',
    );
    const unenrolledEmployee = await member(
      'alex.morgan@northwind.example',
      'Alex Morgan (Field Engineer, synthetic)',
      ['employee'],
      'NOT_ENROLLED',
    );
    const opsManager = await member(
      'ops.manager@northwind.example',
      'Jordan Lee (Operations Manager, synthetic)',
      ['employee', 'reviewer'],
      'NOT_ENROLLED',
    );

    const card = async (memberId: string, last4: string, label: string) =>
      (
        await c.query<{ id: string }>(
          `INSERT INTO cards (organisation_id, member_id, last4, label, is_synthetic)
           VALUES ($1, $2, $3, $4, true) RETURNING id`,
          [organisationId, memberId, last4, label],
        )
      ).rows[0]!.id;
    // Synthetic chat channel identities (proves a second channel through the same engine).
    for (const [memberId, handle] of [
      [employee, 'chat:sam.taylor'],
      [unenrolledEmployee, 'chat:alex.morgan'],
      [controller, 'chat:priya.shah'],
    ] as const) {
      await c.query(
        `INSERT INTO channel_identities (organisation_id, member_id, channel, channel_address, verification_method)
         VALUES ($1, $2, 'synthetic', $3, 'seed_enrolment')`,
        [organisationId, memberId, handle],
      );
    }

    const employeeCard = await card(employee, '4242', 'Company card — Sam Taylor (SYNTHETIC)');
    const unenrolledCard = await card(unenrolledEmployee, '1881', 'Company card — Alex Morgan (SYNTHETIC)');

    const dest = await c.query<{ id: string }>(
      `INSERT INTO payout_destinations (organisation_id, member_id, account_ref_masked, provider_ref,
                                        verified_at, verified_by, is_synthetic)
       VALUES ($1, $2, 'SYNTHETIC ****0042', 'mockpay_dest_sam_taylor', clock_timestamp(), $3, true) RETURNING id`,
      [organisationId, employee, controller],
    );

    const policy = await c.query<{ id: string }>(
      `INSERT INTO policy_versions (organisation_id, version, rules, source_text, content_hash, created_by)
       VALUES ($1, 1, $2, $3, $4, $5) RETURNING id`,
      [organisationId, JSON.stringify(DEMO_POLICY), DEMO_POLICY_TEXT, policyContentHash(DEMO_POLICY), controller],
    );
    const policyVersionId = policy.rows[0]!.id;
    await c.query('UPDATE organisations SET active_policy_version_id = $2 WHERE id = $1', [organisationId, policyVersionId]);

    await appendAudit(c, {
      organisationId,
      actorType: 'system',
      actorId: 'seed',
      action: 'organisation.seeded',
      entityType: 'organisation',
      entityId: organisationId,
      after: { name: DEMO_ORG_NAME, financeMailbox, synthetic: true },
    });
    await appendAudit(c, {
      organisationId,
      actorType: 'member',
      actorId: controller,
      action: 'policy.activated',
      entityType: 'policy_version',
      entityId: policyVersionId,
      after: { version: 1, contentHash: policyContentHash(DEMO_POLICY) },
    });

    return {
      organisationId,
      members: { controller, employee, unenrolledEmployee, opsManager },
      cards: { employee: employeeCard, unenrolledEmployee: unenrolledCard },
      payoutDestinations: { employee: dest.rows[0]!.id },
      policyVersionId,
      created: true,
    };
  });
}

async function loadSeeded(pool: Pool, organisationId: string): Promise<Omit<SeededOrg, 'created'>> {
  const m = await pool.query<{ id: string; display_name: string }>(
    'SELECT id, display_name FROM members WHERE organisation_id = $1',
    [organisationId],
  );
  const byName = (prefix: string) => m.rows.find((r) => r.display_name.startsWith(prefix))!.id;
  const cards = await pool.query<{ id: string; last4: string }>(
    `SELECT id, last4 FROM cards WHERE organisation_id = $1 AND status = 'ACTIVE'`,
    [organisationId],
  );
  const employee = byName('Sam Taylor');
  const dest = await pool.query<{ id: string }>(
    `SELECT id FROM payout_destinations WHERE member_id = $1 AND status = 'ACTIVE'`,
    [employee],
  );
  const org = await pool.query<{ active_policy_version_id: string }>(
    'SELECT active_policy_version_id FROM organisations WHERE id = $1',
    [organisationId],
  );
  return {
    organisationId,
    policyVersionId: org.rows[0]!.active_policy_version_id,
    members: {
      controller: byName('Priya Shah'),
      employee,
      unenrolledEmployee: byName('Alex Morgan'),
      opsManager: byName('Jordan Lee'),
    },
    cards: {
      employee: cards.rows.find((c) => c.last4 === '4242')!.id,
      unenrolledEmployee: cards.rows.find((c) => c.last4 === '1881')!.id,
    },
    payoutDestinations: { employee: dest.rows[0]!.id },
  };
}
