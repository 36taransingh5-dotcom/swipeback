import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { enqueue } from '@swipeback/db';
import {
  CARD_SIGNATURE_HEADER,
  consumeLoginToken,
  endSession,
  loadCase,
  loadEvidence,
  loadSession,
  pageChallenge,
  peekChallenge,
  receiveCardEvent,
  receiveInbound,
  requestLoginLink,
  reviewExpense,
  ReviewError,
  reviewQueue,
  safeNextPath,
  SESSION_TTL_HOURS,
  authorisePayment,
  type Corrections,
  disconnectGmail,
  finishGmailConnect,
  mailboxStatus,
  startGmailConnect,
  type EngineDeps,
  type GmailRuntime,
  type ReviewAction,
  type SessionMember,
} from '@swipeback/engine';
import { casePage, checkEmailPage, connectPage, errorPage, loginPage, queuePage, STATIC_CSS, STATIC_JS, type CasePageOptions } from './views.ts';

/**
 * The minimal authenticated reviewer surface plus the PRD §7.4 API. It holds no business logic:
 * every action calls a role-checked engine command.
 */

export const SESSION_COOKIE = 'sb_session';
const BASE_CSP = "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'";
type Env = { Variables: { actor: SessionMember | null } };

export interface WebOptions {
  secureCookies: boolean;
  reportsDir?: string;
  /** Google OAuth + token cipher; when absent the connect page explains what to configure. */
  gmail?: GmailRuntime | null;
}

const isReviewer = (a: SessionMember) => a.roles.some((r) => r === 'reviewer' || r === 'admin');
const isPayer = (a: SessionMember) => a.roles.includes('payment_approver');

export function createApp(deps: EngineDeps, opts: WebOptions) {
  const app = new Hono<Env>();

  // ---- security headers -------------------------------------------------------------------
  app.use('*', async (c, next) => {
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer'); // one-time links must never leak via Referer
    c.header('X-Frame-Options', 'DENY');
    if (!c.res.headers.get('Content-Security-Policy')) {
      c.header('Content-Security-Policy', BASE_CSP);
    }
    if (!c.res.headers.get('Cache-Control')) c.header('Cache-Control', 'no-store');
  });

  // ---- session ----------------------------------------------------------------------------
  app.use('*', async (c, next) => {
    c.set('actor', await loadSession(deps, getCookie(c, SESSION_COOKIE)));
    await next();
  });
  const requireActor = (c: Context<Env>): SessionMember | Response => {
    const actor = c.get('actor');
    if (actor) return actor;
    const url = new URL(c.req.url);
    if (url.pathname.startsWith('/api/')) return c.json({ error: 'authentication required' }, 401);
    return c.redirect(`/login?next=${encodeURIComponent(url.pathname + url.search)}`, 303);
  };

  app.get('/healthz', (c) => c.json({ ok: true }));
  app.get('/static/app.css', (c) => c.body(String(STATIC_CSS), 200, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'public, max-age=300' }));
  app.get('/static/app.js', (c) => c.body(String(STATIC_JS), 200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=300' }));
  app.get('/', (c) => c.redirect('/review', 303));

  // ---- sign in ----------------------------------------------------------------------------
  app.get('/login', (c) => c.html(loginPage({ next: safeNextPath(c.req.query('next')) })));
  app.post('/login', async (c) => {
    const body = await c.req.parseBody();
    await requestLoginLink(deps, String(body.email ?? ''), String(body.next ?? ''));
    return c.html(checkEmailPage());
  });
  app.get('/auth/callback', async (c) => {
    const result = await consumeLoginToken(deps, c.req.query('t') ?? '');
    if (!result) return c.html(loginPage({ error: 'That sign-in link has expired or was already used. Request a new one.' }), 401);
    setCookie(c, SESSION_COOKIE, result.sessionToken, { httpOnly: true, secure: opts.secureCookies, sameSite: 'Lax', path: '/', maxAge: SESSION_TTL_HOURS * 3600 });
    return c.redirect(result.nextPath, 303);
  });
  app.post('/logout', async (c) => {
    await endSession(deps, getCookie(c, SESSION_COOKIE));
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.redirect('/login', 303);
  });

  // ---- review -----------------------------------------------------------------------------
  app.get('/review', async (c) => {
    const actor = requireActor(c);
    if (actor instanceof Response) return actor;
    return c.html(queuePage(actor, await reviewQueue(deps, actor), await mailboxStatus(deps, actor.organisationId)));
  });

  // ---- connected finance mailbox --------------------------------------------------------------
  app.get('/connect', async (c) => {
    const actor = requireActor(c);
    if (actor instanceof Response) return actor;
    // The Connect form posts here and is redirected to Google's consent screen; CSP form-action
    // applies to that redirect, so this page alone may target accounts.google.com.
    c.header('Content-Security-Policy', `${BASE_CSP.replace("form-action 'self'", "form-action 'self' https://accounts.google.com")}`);
    return c.html(connectPage(actor, await mailboxStatus(deps, actor.organisationId), { configured: !!opts.gmail, notice: c.req.query('connected') ? 'Mailbox connected. New receipts sent to it are processed automatically.' : null, error: c.req.query('error') ?? null }));
  });
  app.post('/connect/gmail', async (c) => {
    const actor = requireActor(c);
    if (actor instanceof Response) return actor;
    if (!opts.gmail) return c.redirect('/connect', 303);
    return withErrors(c, actor, async () => c.redirect(await startGmailConnect(deps, opts.gmail!, actor), 303));
  });
  app.post('/connect/gmail/disconnect', async (c) => {
    const actor = requireActor(c);
    if (actor instanceof Response) return actor;
    if (!opts.gmail) return c.redirect('/connect', 303);
    return withErrors(c, actor, async () => {
      await disconnectGmail(deps, opts.gmail!, actor);
      return c.redirect('/connect', 303);
    });
  });
  app.get('/api/oauth/google/callback', async (c) => {
    const actor = requireActor(c);
    if (actor instanceof Response) return actor;
    if (!opts.gmail) return c.redirect('/connect', 303);
    const denied = c.req.query('error');
    if (denied) return c.redirect(`/connect?error=${encodeURIComponent(`Google consent was not given (${denied}). Nothing was connected.`)}`, 303);
    const r = await finishGmailConnect(deps, opts.gmail, actor, { code: c.req.query('code') ?? '', state: c.req.query('state') ?? '' });
    return c.redirect(r.ok ? '/connect?connected=1' : `/connect?error=${encodeURIComponent(r.reason)}`, 303);
  });

  async function renderCase(c: Context<Env>, actor: SessionMember, expenseId: string, extra: Partial<CasePageOptions> = {}, status: 200 | 400 | 403 | 404 | 409 | 410 = 200) {
    const view = await loadCase(deps, actor, expenseId);
    const own = view.expense.memberId === actor.memberId;
    const review = extra.review ?? (view.expense.state === 'REVIEW_REQUIRED' && isReviewer(actor) && !own ? await pageChallenge(deps, actor, { expenseId, purpose: 'EXPENSE_REVIEW' }) : null);
    const payment =
      extra.payment ??
      (view.reimbursement?.state === 'ELIGIBILITY_CHECK' && isPayer(actor) && !own
        ? await pageChallenge(deps, actor, { expenseId, purpose: 'PAYMENT_AUTHORISATION', reimbursementId: view.reimbursement.id })
        : null);
    return c.html(casePage(view, { actor, review, payment, notice: extra.notice ?? null, error: extra.error ?? null }), status);
  }

  const withErrors = async (c: Context<Env>, actor: SessionMember, fn: () => Promise<Response>) => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof ReviewError) return c.html(errorPage(err.status, err.message, actor), err.status);
      throw err;
    }
  };

  app.get('/review/:id', async (c) => {
    const actor = requireActor(c);
    if (actor instanceof Response) return actor;
    const done = c.req.query('done');
    return withErrors(c, actor, () => renderCase(c, actor, c.req.param('id'), { notice: done ? `Recorded. The expense is now ${done.toLowerCase().replace(/_/g, ' ')}.` : null }));
  });

  // Link from an approval email: valid only for the person it was sent to, once, before expiry.
  app.get('/a/:challengeId', async (c) => {
    const actor = requireActor(c);
    if (actor instanceof Response) return actor;
    const ch = await peekChallenge(deps.pool, { challengeId: c.req.param('challengeId'), nonce: c.req.query('n') ?? '', memberId: actor.memberId, organisationId: actor.organisationId });
    if (!ch) return c.html(errorPage(410, 'This approval link has expired, was already used, or was sent to someone else. Open the case from your queue instead.', actor), 410);
    const token = { challengeId: c.req.param('challengeId'), nonce: c.req.query('n') ?? '' };
    return withErrors(c, actor, () => renderCase(c, actor, ch.expense_id, ch.purpose === 'EXPENSE_REVIEW' ? { review: token } : { payment: token }));
  });

  app.post('/review/:id/decision', async (c) => {
    const actor = requireActor(c);
    if (actor instanceof Response) return actor;
    const expenseId = c.req.param('id');
    const b = await c.req.parseBody();
    const s = (k: string) => (typeof b[k] === 'string' ? (b[k] as string) : '');
    const corrections: Corrections = {
      ...(s('merchant') ? { merchant: s('merchant') } : {}),
      ...(s('amount') ? { amount: s('amount') } : {}),
      ...(s('currency') ? { currency: s('currency') } : {}),
      ...(s('date') ? { date: s('date') } : {}),
      ...(s('category') ? { category: s('category') } : {}),
      ...(s('paymentType') === 'CORPORATE' || s('paymentType') === 'PERSONAL' ? { paymentType: s('paymentType') as 'CORPORATE' | 'PERSONAL' } : {}),
    };
    try {
      const r = await reviewExpense(deps, actor, {
        expenseId, action: s('action') as ReviewAction, reason: s('reason'), expectedVersion: Number(s('version')),
        challengeId: s('challengeId'), nonce: s('nonce'), question: s('question'), corrections,
      });
      return c.redirect(`/review/${expenseId}?done=${r.state}`, 303);
    } catch (err) {
      if (!(err instanceof ReviewError)) throw err;
      if (err.status === 404) return c.html(errorPage(404, err.message, actor), 404);
      return withErrors(c, actor, () => renderCase(c, actor, expenseId, { error: err.message }, err.status));
    }
  });

  app.post('/review/:id/payment', async (c) => {
    const actor = requireActor(c);
    if (actor instanceof Response) return actor;
    const expenseId = c.req.param('id');
    const b = await c.req.parseBody();
    try {
      const r = await authorisePayment(deps, actor, { reimbursementId: String(b.reimbursementId ?? ''), reason: String(b.reason ?? ''), challengeId: String(b.challengeId ?? ''), nonce: String(b.nonce ?? '') });
      return c.redirect(`/review/${expenseId}?done=${r.state}`, 303);
    } catch (err) {
      if (!(err instanceof ReviewError)) throw err;
      if (err.status === 404) return c.html(errorPage(404, err.message, actor), 404);
      return withErrors(c, actor, () => renderCase(c, actor, expenseId, { error: err.message }, err.status));
    }
  });

  app.get('/evidence/:fileId', async (c) => {
    const actor = requireActor(c);
    if (actor instanceof Response) return actor;
    const file = await loadEvidence(deps, actor, c.req.param('fileId'));
    if (!file) return c.text('Not found', 404);
    const inline = file.mime.startsWith('image/') || file.mime === 'application/pdf';
    return c.body(new Uint8Array(file.bytes), 200, {
      'Content-Type': inline ? file.mime : 'text/plain; charset=utf-8',
      'Content-Disposition': inline ? 'inline' : 'attachment',
      // Untrusted documents: no scripts, no navigation, no same-origin access.
      'Content-Security-Policy': "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
      'Cache-Control': 'private, no-store',
    });
  });

  // ---- PRD §7.4 API -----------------------------------------------------------------------
  app.post('/api/card-events', async (c) => {
    const org = c.req.header('x-organisation-id') ?? '';
    if (!/^[0-9a-f-]{36}$/.test(org)) return c.json({ error: 'x-organisation-id required' }, 400);
    const r = await receiveCardEvent(deps, org, await c.req.text(), c.req.header(CARD_SIGNATURE_HEADER));
    if (r.status === 'REJECTED') return c.json(r, r.reason === 'MALFORMED' || r.reason === 'UNKNOWN_CARD' ? 400 : 401);
    return c.json(r, 202);
  });

  /** Verified inbound channel webhook (synthetic chat today; Slack / WhatsApp / Telegram adapters plug in here). */
  app.post('/api/inbox/:connectionId', async (c) => {
    const connectionId = c.req.param('connectionId');
    if (!/^[0-9a-f-]{36}$/.test(connectionId)) return c.json({ error: 'unknown connection' }, 404);
    const headers: Record<string, string> = {};
    c.req.raw.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
    try {
      const r = await receiveInbound(deps, connectionId, { body: Buffer.from(await c.req.arrayBuffer()), headers });
      return c.json(r, r.status === 'REJECTED' ? 401 : 202);
    } catch {
      return c.json({ error: 'unknown or inactive connection' }, 404);
    }
  });

  app.post('/api/expenses/:id/evaluate', async (c) => {
    const actor = requireActor(c);
    if (actor instanceof Response) return actor;
    if (!isReviewer(actor)) return c.json({ error: 'reviewer role required' }, 403);
    const id = c.req.param('id');
    const own = await deps.pool.query('SELECT 1 FROM expenses WHERE id = $1 AND organisation_id = $2', [/^[0-9a-f-]{36}$/.test(id) ? id : null, actor.organisationId]);
    if (!own.rowCount) return c.json({ error: 'not found' }, 404);
    // Safe replay: evaluation is idempotent and no-ops outside evaluable states.
    const job = await enqueue(deps.pool, 'evaluate-expense', { expenseId: id }, { organisationId: actor.organisationId });
    return c.json({ queued: true, jobId: job.id }, 202);
  });

  app.post('/api/expenses/:id/review', async (c) => {
    const actor = requireActor(c);
    if (actor instanceof Response) return actor;
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    try {
      const r = await reviewExpense(deps, actor, {
        expenseId: c.req.param('id'), action: b.action as ReviewAction, reason: String(b.reason ?? ''), expectedVersion: Number(b.version),
        challengeId: String(b.challengeId ?? ''), nonce: String(b.nonce ?? ''), question: String(b.question ?? ''), corrections: (b.corrections ?? {}) as Corrections,
      });
      return c.json(r);
    } catch (err) {
      if (err instanceof ReviewError) return c.json({ error: err.message }, err.status);
      throw err;
    }
  });

  app.post('/api/reimbursements/:id/simulate', async (c) => {
    const actor = requireActor(c);
    if (actor instanceof Response) return actor;
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    try {
      return c.json(await authorisePayment(deps, actor, { reimbursementId: c.req.param('id'), reason: String(b.reason ?? ''), challengeId: String(b.challengeId ?? ''), nonce: String(b.nonce ?? '') }));
    } catch (err) {
      if (err instanceof ReviewError) return c.json({ error: err.message }, err.status);
      throw err;
    }
  });

  app.get('/api/expenses/:id/evidence', async (c) => {
    const actor = requireActor(c);
    if (actor instanceof Response) return actor;
    try {
      return c.json(await loadCase(deps, actor, c.req.param('id')));
    } catch (err) {
      if (err instanceof ReviewError) return c.json({ error: err.message }, err.status);
      throw err;
    }
  });

  app.get('/api/evaluations/report', async (c) => {
    const actor = requireActor(c);
    if (actor instanceof Response) return actor;
    const split = c.req.query('split') ?? 'heldout';
    if (!['heldout', 'tune', 'all'].includes(split)) return c.json({ error: 'split must be heldout, tune or all' }, 400);
    const latest = await latestEvaluationReport(opts.reportsDir ?? path.resolve('eval/reports'), split);
    if (!latest) return c.json({ error: `no ${split} evaluation report yet` }, 404);
    return c.json(JSON.parse(await readFile(latest, 'utf8')));
  });

  app.notFound((c) => c.html(errorPage(404, 'There is nothing at this address.', c.get('actor')), 404));
  app.onError((err, c) => {
    console.error('[web]', err);
    return c.html(errorPage(500, 'Something went wrong. Nothing was changed.', c.get('actor') ?? null), 500);
  });
  return app;
}

/** Newest end-to-end report for a split; file names embed the ISO run time, so they sort by time. */
export async function latestEvaluationReport(dir: string, split: string): Promise<string | null> {
  const prefix = `pipeline-${split}-`;
  const name = (await readdir(dir).catch(() => [] as string[])).filter((f) => f.startsWith(prefix) && f.endsWith('.json')).sort().at(-1);
  return name ? path.join(dir, name) : null;
}
