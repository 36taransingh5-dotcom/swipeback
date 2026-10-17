import { PermanentJobError, type Job, type JobHandlers } from '@swipeback/db';
import { rematchMember } from './card-feed.ts';
import type { EngineDeps } from './deps.ts';
import { evaluateExpense, extractReceipt, questionTimeout } from './expense.ts';
import { processInbound } from './inbound.ts';
import { authoriseReimbursement, executePayout, exportExpense, failPayoutPermanently } from './money-movement.ts';
import { deliverOutbound } from './outbox.ts';

/** Retryable signal for the job runner (backoff, then dead-letter). */
export class RetryLater extends Error {
  override readonly name = 'RetryLater';
}

function field(job: Job<never>, key: string): string {
  const v = (job.payload as Record<string, unknown>)[key];
  if (typeof v !== 'string' || !v) throw new PermanentJobError(`job ${job.kind}#${job.id} missing ${key}`);
  return v;
}

export function engineHandlers(deps: EngineDeps): JobHandlers {
  return {
    'process-inbound': async (job) => void (await processInbound(deps, field(job, 'inboundId'))),
    'extract-receipt': async (job) => void (await extractReceipt(deps, field(job, 'expenseId'), { finalAttempt: job.attempts >= job.maxAttempts })),
    'evaluate-expense': async (job) => void (await evaluateExpense(deps, field(job, 'expenseId'))),
    'authorise-reimbursement': async (job) => void (await authoriseReimbursement(deps, field(job, 'expenseId'))),
    'execute-payout': async (job) => {
      const id = field(job, 'reimbursementId');
      const run = await executePayout(deps, id);
      if (run === 'RETRY' || run === 'IN_FLIGHT') {
        if (job.attempts >= job.maxAttempts) {
          await failPayoutPermanently(deps, id, `outcome unresolved after ${job.attempts} attempts`);
          return;
        }
        throw new RetryLater(`payout ${run.toLowerCase()}`);
      }
    },
    'export-expense': async (job) => void (await exportExpense(deps, field(job, 'expenseId'))),
    'deliver-outbound': async (job) => {
      try {
        await deliverOutbound(deps, field(job, 'outboundId'));
      } catch (err) {
        if (job.attempts >= job.maxAttempts) {
          await deps.pool.query(`UPDATE outbound_messages SET delivery_state = 'FAILED' WHERE id = $1`, [field(job, 'outboundId')]);
        }
        throw err;
      }
    },
    'question-timeout': async (job) => {
      const stage = field(job, 'stage');
      if (stage !== 'REMIND' && stage !== 'EXPIRE') throw new PermanentJobError(`bad stage ${stage}`);
      await questionTimeout(deps, field(job, 'token'), stage);
    },
    'rematch-member': async (job) => {
      await rematchMember(deps, { organisationId: field(job, 'organisationId'), memberId: field(job, 'memberId'), transactionId: field(job, 'transactionId') });
    },
  };
}
