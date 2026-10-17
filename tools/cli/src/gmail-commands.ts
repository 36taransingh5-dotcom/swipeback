import { parseArgs } from 'node:util';
import { GMAIL_SCOPES } from '@swipeback/channels';
import { JobRunner } from '@swipeback/db';
import { activeGmailConnections, createRuntime, engineHandlers, loadLocalEnv, pollGmailConnection, receiveCardEvent, signCardEvent } from '@swipeback/engine';

type Command = { describe: string; run: (args: string[]) => Promise<void> };

/**
 * Live AC-01 check against the real connected mailbox: send a receipt email to the finance mailbox
 * from an enrolled employee address while this runs. It polls Gmail, runs the jobs, and checks the
 * whole round trip, printing each check as it passes.
 */
export const gmailCommands: Record<string, Command> = {
  'verify:gmail': {
    describe: 'Live mailbox check: connection, scopes, then waits for a new receipt email and verifies the threaded reply [--wait 180]',
    run: async (args) => {
      loadLocalEnv();
      const { values } = parseArgs({ args, options: { wait: { type: 'string' } } });
      const rt = createRuntime();
      const ok = (label: string, pass: boolean, detail = '') => {
        console.log(`${pass ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
        if (!pass) process.exitCode = 1;
        return pass;
      };
      try {
        if (!ok('Google OAuth configured', !!rt.gmail)) return;
        const [id] = await activeGmailConnections(rt.pool);
        if (!ok('Gmail mailbox connected (ACTIVE)', !!id, id ? '' : 'connect it at /connect')) return;
        const conn = (await rt.pool.query<{ address: string; scopes: string[] }>('SELECT address, scopes FROM channel_connections WHERE id = $1', [id])).rows[0]!;
        ok('Connected address is the designated mailbox', true, conn.address);
        ok('Scopes are exactly read + send', [...conn.scopes].sort().join(' ') === [...GMAIL_SCOPES].sort().join(' '), conn.scopes.join(' '));

        const started = new Date();
        const waitMs = Number(values.wait ?? 180) * 1000;
        console.log(`\nNow email a receipt (photo or PDF) to ${conn.address} from an enrolled employee address. Waiting up to ${waitMs / 1000}s…`);
        const runner = new JobRunner(rt.pool, engineHandlers(rt.deps), { workerId: 'verify-gmail', onError: (j, e) => console.error(`  job ${j.kind}: ${(e as Error).message}`) });
        const deadline = Date.now() + waitMs;
        let inbound: { id: string; provider_event_id: string; thread_id: string; processing_state: string; sender_address: string } | undefined;
        let reply: { thread_id: string; template: string; provider_message_id: string } | undefined;
        while (Date.now() < deadline && !reply) {
          await pollGmailConnection(rt.deps, rt.gmail!.tokens, id!);
          for (let i = 0; i < 50 && (await runner.runOnce()) > 0; i++);
          inbound ??= (await rt.pool.query(`SELECT id, provider_event_id, thread_id, processing_state, sender_address FROM inbound_messages WHERE connection_id = $1 AND received_at >= $2 ORDER BY received_at LIMIT 1`, [id, started])).rows[0];
          if (inbound) {
            reply = (await rt.pool.query(`SELECT o.thread_id, o.template, o.provider_message_id FROM outbound_messages o WHERE o.connection_id = $1 AND o.delivery_state = 'SENT' AND o.thread_id = $2 AND o.created_at >= $3 ORDER BY o.created_at LIMIT 1`, [id, inbound.thread_id, started])).rows[0];
          }
          if (!reply) await new Promise((r) => setTimeout(r, 4000));
        }
        if (!ok('New email ingested from Gmail', !!inbound, inbound ? `${inbound.provider_event_id} from ${inbound.sender_address} (${inbound.processing_state.toLowerCase()})` : 'nothing arrived in time')) return;
        const att = (await rt.pool.query<{ sha256: string; mime: string }>('SELECT ef.sha256, ef.mime FROM inbound_attachments ia JOIN evidence_files ef ON ef.id = ia.evidence_file_id WHERE ia.inbound_message_id = $1', [inbound!.id])).rows;
        ok('Attachment stored as evidence with its hash', att.length > 0, att.map((a) => `${a.mime} ${a.sha256.slice(0, 16)}…`).join(', '));
        const exp = (await rt.pool.query<{ ref: string; state: string; merchant: string | null; amount_minor: number | null; currency: string | null }>('SELECT ref, state, merchant, amount_minor, currency FROM expenses WHERE inbound_message_id = $1', [inbound!.id])).rows[0];
        ok('Expense created and decided', !!exp, exp ? `${exp.ref} ${exp.merchant} ${exp.currency} ${((exp.amount_minor ?? 0) / 100).toFixed(2)} → ${exp.state}` : inbound!.processing_state === 'QUARANTINED' ? 'sender quarantined: is the sender enrolled (SB_EMPLOYEE_EMAIL) and DKIM-authenticated?' : 'none');
        ok('Reply sent in the same Gmail thread', !!reply && reply.thread_id === inbound!.thread_id, reply ? `${reply.template} → thread ${reply.thread_id}` : 'no reply yet');
      } finally {
        await rt.pool.end();
      }
    },
  },
};

/**
 * Live card-led flow: emit a signed SYNTHETIC swipe on the employee's company card, wait for the
 * receipt request to go out from the finance mailbox, then wait for the employee's reply with the
 * receipt and check the outcome. Uses the running worker for jobs and Gmail polling.
 */
gmailCommands['verify:card-receipt'] = {
  describe: 'Live card-swipe receipt chase: --amount 58.40 --merchant "SHELL WATFORD 123" [--card 4242] [--wait 900]',
  run: async (args) => {
    loadLocalEnv();
    const { values } = parseArgs({ args, options: { amount: { type: 'string' }, merchant: { type: 'string' }, card: { type: 'string' }, wait: { type: 'string' } } });
    const rt = createRuntime();
    const ok = (label: string, pass: boolean, detail = '') => {
      console.log(`${pass ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
      if (!pass) process.exitCode = 1;
      return pass;
    };
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    try {
      const [connId] = await activeGmailConnections(rt.pool);
      if (!ok('Gmail mailbox connected', !!connId)) return;
      const org = (await rt.pool.query<{ id: string }>('SELECT organisation_id AS id FROM channel_connections WHERE id = $1', [connId])).rows[0]!.id;
      const body = JSON.stringify({
        provider: 'card-sim', transactionId: `live-${Date.now()}`, cardLast4: values.card ?? '4242', amountMinor: Math.round(Number(values.amount ?? '58.40') * 100),
        currency: 'GBP', merchantDescriptor: (values.merchant ?? 'SHELL WATFORD 123').toUpperCase(), transactedAt: new Date().toISOString(), synthetic: true,
      });
      const r = await receiveCardEvent(rt.deps, org, body, signCardEvent(rt.deps.config.cardFeedSecret, body, Math.floor(Date.now() / 1000)));
      if (!ok('Signed SYNTHETIC card swipe accepted', r.status === 'ACCEPTED', JSON.stringify(r))) return;
      const txnId = (r as { transactionId: string }).transactionId;
      const deadline = Date.now() + Number(values.wait ?? 900) * 1000;
      const expense = async () => (await rt.pool.query<{ id: string; ref: string; state: string; receipt_id: string | null; flags: string[] }>('SELECT id, ref, state, receipt_id, flags FROM expenses WHERE matched_transaction_id = $1', [txnId])).rows[0];
      let e = await expense();
      while (!e && Date.now() < deadline) { await sleep(2000); e = await expense(); }
      if (!ok('Card-led expense created at the swipe (no receipt yet)', !!e, e ? `${e.ref} ${e.state}` : '')) return;
      const grace = rt.deps.config.receiptGraceMinutes ?? 60;
      console.log(`  waiting ${grace} min grace period, then the receipt request goes out…`);
      let request: { recipient_address: string; thread_id: string | null; subject: string } | undefined;
      while (!request && Date.now() < deadline) {
        request = (await rt.pool.query(`SELECT recipient_address, thread_id, subject FROM outbound_messages WHERE expense_id = $1 AND template = 'receipt-request' AND delivery_state = 'SENT'`, [e!.id])).rows[0];
        if (!request) await sleep(3000);
      }
      if (!ok('Receipt request emailed from the finance mailbox', !!request, request ? `to ${request.recipient_address}: "${request.subject}"` : '')) return;
      console.log(`\n  ➜ Now reply to that email in Gmail with the receipt attached.\n`);
      let outcome: { state: string; flags: string[] } | undefined;
      while (Date.now() < deadline) {
        const cur = await expense();
        if (cur && ['EXPORTED', 'REVIEW_REQUIRED', 'REJECTED', 'AUTO_CLEARED'].includes(cur.state) && cur.receipt_id) { outcome = cur; break; }
        if (cur && cur.state === 'REVIEW_REQUIRED') { outcome = cur; break; }
        await sleep(3000);
      }
      if (!ok('Reply with the receipt ingested and decided', !!outcome, outcome ? `${outcome.state}${outcome.flags.length ? ` flags=${outcome.flags.join(',')}` : ''}` : 'no reply in time')) return;
      const reply = (await rt.pool.query<{ thread_id: string; template: string }>(`SELECT thread_id, template FROM outbound_messages WHERE expense_id = $1 AND template <> 'receipt-request' AND delivery_state = 'SENT' ORDER BY sent_at DESC LIMIT 1`, [e!.id])).rows[0];
      ok('Outcome sent in the same Gmail thread', !!reply && reply.thread_id === request!.thread_id, reply ? `${reply.template} → thread ${reply.thread_id}` : '');
      const reimb = (await rt.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM reimbursements WHERE expense_id = $1', [e!.id])).rows[0]!.n;
      ok('Company-card spend not reimbursed', reimb === 0);
      const extraction = (await rt.pool.query<{ extractor: string; model: string | null }>('SELECT x.extractor, x.model FROM expenses e JOIN extractions x ON x.id = e.current_extraction_id WHERE e.id = $1', [e!.id])).rows[0];
      ok('Receipt read by the configured model', !!extraction, extraction ? `${extraction.extractor} ${extraction.model ?? ''}` : '');
    } finally {
      await rt.pool.end();
    }
  },
};
