import { createHash } from 'node:crypto';
import { ACCESS_VERSION, LANDING_HTML } from './landing.ts';
import { html, raw } from 'hono/html';
import type { HtmlEscapedString } from 'hono/utils/html';
import { CATEGORIES } from '@swipeback/domain';
import type { CaseView, QueueItem, SessionMember } from '@swipeback/engine';

type H = HtmlEscapedString | Promise<HtmlEscapedString>;

const SYMBOL: Record<string, string> = { GBP: '£', EUR: '€', USD: '$' };
export const money = (minor: number | null, cur: string | null) =>
  minor === null || !cur ? '—' : `${SYMBOL[cur] ?? `${cur} `}${(minor / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const when = (d: Date) => d.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' });
const words = (s: string) => s.toLowerCase().replace(/_/g, ' ');

const STATE_TONE: Record<string, string> = {
  REVIEW_REQUIRED: 'warn', NEEDS_INFO: 'info', NEEDS_MATCH: 'info', AUTO_CLEARED: 'ok', APPROVED: 'ok', EXPORTED: 'ok', REJECTED: 'bad',
  POLICY_CHECK: 'info', EXTRACTING: 'info', RECEIVED: 'info', SIMULATED_PAID: 'ok', PAYOUT_QUEUED: 'info', ELIGIBILITY_CHECK: 'warn', FAILED: 'bad',
};
const pill = (state: string) => html`<span class="pill ${STATE_TONE[state] ?? 'info'}">${words(state)}</span>`;

export function layout(title: string, body: H, actor: SessionMember | null = null): H {
  return html`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Swipeback</title><link rel="stylesheet" href="/static/app.css?v=${ASSET_VERSION}"><script src="/static/app.js?v=${ASSET_VERSION}" defer></script></head>
<body>
<div class="demo-banner">SYNTHETIC DEMO — all people, receipts and cards are fictitious; payouts are simulated, no money moves.</div>
<header class="top"><a class="brand" href="/review">swipe<b>back</b></a>
${actor ? html`<div class="who"><span>${actor.displayName}</span><form method="post" action="/logout"><button class="link">Sign out</button></form></div>` : ''}
</header>
<main>${body}</main>
<footer>Finance only deals with exceptions. Everything else is handled, evidenced and audited automatically.</footer>
</body></html>`;
}

function accessLayout(title: string, body: H, actor: SessionMember | null = null): H {
  return html`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#123bcc"><title>${title} · Swipeback</title>
<link rel="stylesheet" href="/static/access.css?v=${ACCESS_VERSION}"></head>
<body class="access-page"><a class="access-skip" href="#main">Skip to content</a>
<header class="access-header"><a class="access-brand" href="/" aria-label="Swipeback home"><span aria-hidden="true">↩</span> swipeback</a>
<nav aria-label="Account navigation"><a href="/">Home <span aria-hidden="true">↗</span></a><a href="/start">Get started <span aria-hidden="true">↗</span></a>
${actor ? html`<form method="post" action="/logout"><button type="submit">Sign out <span aria-hidden="true">↗</span></button></form>` : html`<a class="access-nav-cta" href="/login">Sign in <span aria-hidden="true">↗</span></a>`}</nav></header>
<main id="main">${body}</main>
<footer class="access-footer"><span>↩ SWIPEBACK</span><span>LESS ADMIN. MORE LIVING.</span></footer>
<div class="demo-banner">SYNTHETIC DEMO — all people, receipts and cards are fictitious; payouts are simulated, no money moves.</div>
</body></html>`;
}

export function loginPage(opts: { next?: string; error?: string } = {}): H {
  return accessLayout('Sign in', html`<section class="access-hero access-hero--login">
  <div class="access-hero-meta"><span>YOUR SPACE / SWIPEBACK</span><span>EXPENSES, OFF YOUR PLATE.</span></div>
  <div class="access-login-grid"><div class="access-intro"><p class="access-eyebrow"><i aria-hidden="true"></i> GOOD TO SEE YOU</p>
    <h1>Welcome<br><em>back.</em></h1><p class="access-subline">A little less admin starts here.</p></div>
  <div class="access-login-card"><span class="access-card-index">01 / SIGN IN</span><h2>Come on in.</h2>
    ${opts.error ? html`<p class="access-alert" role="alert">${opts.error}</p>` : ''}
    <form method="post" action="/login" class="access-form">
      <label for="access-email">Work email</label><input id="access-email" type="email" name="email" required autocomplete="email" placeholder="you@company.com" autofocus>
      <input type="hidden" name="next" value="${opts.next ?? ''}">
      <button class="access-button" type="submit">Send sign-in link <span aria-hidden="true">↗</span></button>
    </form><p class="access-card-note">We’ll email you a one-time link.</p></div></div>
  <div class="access-hero-bottom"><span>ONE LESS THING.</span><span>↩ &nbsp; STAY IN YOUR FLOW</span></div>
  </section>`);
}

export function checkEmailPage(): H {
  return accessLayout('Check your email', html`<section class="access-hero access-hero--login" data-testid="check-email">
  <div class="access-hero-meta"><span>YOUR SPACE / SWIPEBACK</span><span>EXPENSES, OFF YOUR PLATE.</span></div>
  <div class="access-login-grid"><div class="access-intro"><p class="access-eyebrow"><i aria-hidden="true"></i> ALMOST THERE</p>
    <h1>Check your<br><em>inbox.</em></h1><p class="access-subline">Your sign-in link is on its way.</p></div>
  <div class="access-login-card"><span class="access-card-index">02 / CHECK EMAIL</span><h2>See you in a sec.</h2>
    <p class="access-card-note">If your address has access, you’ll receive a link that works once for 15 minutes.</p>
    <a class="access-button" href="/login">Try another email <span aria-hidden="true">↗</span></a></div></div>
  <div class="access-hero-bottom"><span>ONE LESS THING.</span><span>↩ &nbsp; STAY IN YOUR FLOW</span></div>
  </section>`);
}

export function onboardingPage(opts: { sent?: boolean; error?: string } = {}): H {
  return accessLayout('Get started', html`<section class="access-connect access-onboarding" data-testid="onboarding">
    <div class="access-connect-hero"><div class="access-hero-meta"><span>YOUR SPACE / SWIPEBACK</span><span>ONE LESS THING.</span></div>
      <div class="access-connect-heading"><p class="access-eyebrow"><i aria-hidden="true"></i> GET STARTED</p>
        <h1>Try it <em>out.</em></h1><p>Your email. Your channels. You’re off.</p></div></div>
    <div class="access-connect-content access-onboarding-content">
      <div class="access-onboarding-card"><div><span class="access-card-index">01 / YOUR EMAIL</span>
        <h2>${opts.sent ? 'Check your inbox.' : 'Come on in.'}</h2>
        <p>${opts.sent ? 'Your sign-in link is on its way.' : 'One email to get started.'}</p></div>
        <div class="access-onboarding-action">
          ${opts.error ? html`<p class="access-alert" role="alert">${opts.error}</p>` : ''}
          ${opts.sent ? html`<a class="access-button" href="/start">Use another email <span aria-hidden="true">↗</span></a>` : html`
            <form method="post" action="/start" class="access-form"><label for="start-email">Work email</label>
              <input id="start-email" name="email" type="email" required autocomplete="email" placeholder="you@company.com" autofocus>
              <button class="access-button" type="submit">Continue with email <span aria-hidden="true">↗</span></button></form>`}
        </div></div>
      <div class="access-section-title"><span>02 / YOUR CHANNELS</span><span>READY WHEN YOU ARE</span></div>
      <div class="access-channel-grid">
        <article class="access-channel"><div class="access-channel-top"><span class="access-channel-icon">✉</span><span class="access-status">After email</span></div>
          <div><h2>Gmail</h2><p>Your finance inbox.</p></div><button class="access-button" type="button" disabled>Connect Gmail <span aria-hidden="true">↗</span></button></article>
        <article class="access-channel"><div class="access-channel-top"><span class="access-channel-icon">▣</span><span class="access-status">Sandbox</span></div>
          <div><h2>Card feed</h2><p>TrueLayer sandbox, locally.</p></div><button class="access-button" type="button" disabled>Connect card feed <span aria-hidden="true">↗</span></button></article>
        <article class="access-channel" data-channel="slack"><div class="access-channel-top"><span class="access-channel-icon">#</span><span class="access-status">Coming soon</span></div>
          <div><h2>Slack</h2><p>Team updates where you work.</p></div><button class="access-button" type="button" disabled>Connect Slack <span aria-hidden="true">↗</span></button></article>
        <article class="access-channel" data-channel="imessage"><div class="access-channel-top"><span class="access-channel-icon">●</span><span class="access-status">Coming soon</span></div>
          <div><h2>iMessage</h2><p>Expense updates in a message.</p></div><button class="access-button" type="button" disabled>Connect iMessage <span aria-hidden="true">↗</span></button></article>
      </div>
    </div></section>`);
}

export function errorPage(status: number, message: string, actor: SessionMember | null): H {
  return layout('Not available', html`<section class="narrow card" data-testid="error" data-status="${status}">
  <h1>${status === 404 ? 'Not found' : status === 403 ? 'Not allowed' : status === 410 ? 'Link no longer valid' : 'Something needs attention'}</h1>
  <p>${message}</p><p><a href="/review">Back to your queue</a></p></section>`, actor);
}

export interface MailboxStatus {
  designatedAddress: string | null;
  connections: { id: string; provider: string; address: string; status: string; scopes: string[]; last_sync_at: Date | null; last_error: string | null; consented_at: Date | null }[];
}

function mailboxBanner(m: MailboxStatus): H | '' {
  const gmail = m.connections.find((c) => c.provider === 'gmail');
  if (gmail?.status === 'RECONNECT_REQUIRED') return html`<p class="alert bad" data-testid="mailbox-banner">The finance mailbox ${gmail.address} needs reconnecting — new receipts are not being read. <a href="/login/connect">Reconnect</a></p>`;
  if (!gmail || gmail.status !== 'ACTIVE') return html`<p class="alert info" data-testid="mailbox-banner">No live mailbox connected${m.connections.some((c) => c.status === 'ACTIVE') ? ' (offline replay transport in use)' : ''}. <a href="/login/connect">Connect the finance mailbox</a></p>`;
  return '';
}

export function connectPage(actor: SessionMember, m: MailboxStatus, o: {
  configured: boolean; notice: string | null; error: string | null;
  cardFeed?: { configured: boolean; connection: {
    id: string; status: string; last_sync_at: Date | null; last_error: string | null;
    cards: { last4: string; enrolledTo: string | null }[];
  } | null; members: { id: string; name: string }[] };
}): H {
  const gmail = m.connections.find((c) => c.provider === 'gmail');
  const admin = actor.roles.includes('admin');
  return accessLayout('Get started', html`<section class="access-connect" data-testid="connect" data-status="${gmail?.status ?? 'NONE'}">
  <div class="access-connect-hero"><div class="access-hero-meta"><span>YOUR SPACE / SWIPEBACK</span><span>ONE LESS THING.</span></div>
    <div class="access-connect-heading"><p class="access-eyebrow"><i aria-hidden="true"></i> GET STARTED</p>
      <h1>Make it <em>yours.</em></h1><p>Choose where Swipeback meets you.</p></div></div>
  <div class="access-connect-content">
    ${o.notice ? html`<p class="access-notice" role="status">${o.notice}</p>` : ''}
    ${o.error ? html`<p class="access-alert" role="alert" data-testid="connect-error">${o.error}</p>` : ''}
    <div class="access-section-title"><span>02 / YOUR CHANNELS</span><span>CONNECT WHAT YOU USE</span></div>
    <div class="access-channel-grid">
      <article class="access-channel" data-channel="gmail"><div class="access-channel-top"><span class="access-channel-icon">✉</span><span class="access-status ${gmail?.status === 'ACTIVE' ? 'is-active' : ''}" data-testid="mailbox-status">${gmail?.status === 'ACTIVE' ? 'Connected' : 'Available'}</span></div>
        <div><h2>Gmail</h2><p>${gmail?.status === 'ACTIVE' ? gmail.address : m.designatedAddress ?? 'Your finance inbox'}</p></div>
        ${o.configured && admin ? html`<form method="post" action="/connect/gmail"><button class="access-button" type="submit">${gmail?.status === 'ACTIVE' ? 'Reconnect Gmail' : 'Connect Gmail'} <span aria-hidden="true">↗</span></button></form>`
          : html`<button class="access-button" type="button" disabled>${admin ? 'Unavailable here' : 'Admin only'} <span aria-hidden="true">↗</span></button>`}
        ${gmail && gmail.status !== 'DISCONNECTED' && admin ? html`<form method="post" action="/connect/gmail/disconnect" class="access-minor-action"><button type="submit">Disconnect Gmail</button></form>` : ''}
        ${gmail?.last_error ? html`<p class="access-inline-error">${gmail.last_error}</p>` : ''}
      </article>
      <article class="access-channel" data-channel="card" data-testid="sandbox-card-feed"><div class="access-channel-top"><span class="access-channel-icon">▣</span><span class="access-status ${o.cardFeed?.connection?.status === 'ACTIVE' ? 'is-active' : ''}">${o.cardFeed?.connection?.status === 'ACTIVE' ? 'Connected' : 'Sandbox'}</span></div>
        <div><h2>Card feed</h2><p>TrueLayer sandbox</p></div>
        ${o.cardFeed?.configured && admin ? html`<form method="post" action="/connect/truelayer"><button class="access-button" type="submit">${o.cardFeed.connection?.status === 'ACTIVE' ? 'Reconnect card feed' : 'Connect card feed'} <span aria-hidden="true">↗</span></button></form>`
          : html`<button class="access-button" type="button" disabled>${admin ? 'Local sandbox only' : 'Admin only'} <span aria-hidden="true">↗</span></button>`}
        ${o.cardFeed?.connection?.status === 'ACTIVE' && admin ? html`<form method="post" action="/connect/truelayer/sync" class="access-minor-action"><button type="submit">Sync now</button></form>` : ''}
        ${o.cardFeed?.connection?.last_error ? html`<p class="access-inline-error">${o.cardFeed.connection.last_error}</p>` : ''}
      </article>
      <article class="access-channel" data-channel="slack"><div class="access-channel-top"><span class="access-channel-icon">#</span><span class="access-status">Coming soon</span></div>
        <div><h2>Slack</h2><p>Team updates, right where you work.</p></div>
        <button class="access-button" type="button" disabled>Connect Slack <span aria-hidden="true">↗</span></button>
      </article>
      <article class="access-channel" data-channel="imessage"><div class="access-channel-top"><span class="access-channel-icon">●</span><span class="access-status">Coming soon</span></div>
        <div><h2>iMessage</h2><p>A quick message. Expense handled.</p></div>
        <button class="access-button" type="button" disabled>Connect iMessage <span aria-hidden="true">↗</span></button>
      </article>
    </div>
    ${o.cardFeed?.connection?.cards.length ? html`<section class="access-cards"><div class="access-section-title"><span>03 / SANDBOX CARDS</span><span>TRUE LAYER</span></div>
      <div class="access-card-list">${o.cardFeed.connection.cards.map((card) => html`<div><strong>Card ••${card.last4}</strong><span>${card.enrolledTo ? `Assigned to ${card.enrolledTo}` : 'Unassigned'}</span></div>`)}</div>
      ${admin && o.cardFeed.connection.status === 'ACTIVE' && o.cardFeed.connection.cards.some((card) => !card.enrolledTo) ? html`
        <form method="post" action="/connect/truelayer/card" class="access-assign">
          <label>Card<select name="last4" required>${o.cardFeed.connection.cards.filter((card) => !card.enrolledTo).map((card) => html`<option value="${card.last4}">Card ••${card.last4}</option>`)}</select></label>
          <label>Employee<select name="memberId" required>${o.cardFeed.members.map((member) => html`<option value="${member.id}">${member.name}</option>`)}</select></label>
          <button class="access-button" type="submit">Assign card <span aria-hidden="true">↗</span></button>
        </form>` : ''}</section>` : ''}
  </div></section>`, actor);
}

export function queuePage(actor: SessionMember, q: { items: QueueItem[]; handledAutomatically: number; waitingOnEmployees: number }, mailbox?: MailboxStatus): H {
  const rows = q.items.map(
    (i) => html`<a class="row" href="/review/${i.expenseId}" data-testid="queue-item" data-ref="${i.ref}">
      <div><strong>${i.ref}</strong> <span class="muted">${i.employee}</span>${i.sandbox ? html` <span class="pill info">Sandbox</span>` : ''}${i.ownExpense ? html` <span class="pill info">your own — another reviewer decides</span>` : ''}</div>
      <div>${i.merchant ?? 'Unreadable receipt'} · ${money(i.amountMinor, i.currency)}${i.date ? html` · <span class="muted">${i.date}</span>` : ''}</div>
      <div class="muted small">${i.kind === 'PAYMENT_AUTHORISATION' ? 'Payment needs authorisation: ' : 'Needs a decision: '}${i.reasons.join('; ') || '—'}</div>
    </a>`,
  );
  return layout('Exceptions', html`<section>
  ${mailbox ? mailboxBanner(mailbox) : ''}
  <h1>Exceptions for you <span class="count" data-testid="queue-count">${q.items.length}</span></h1>
  <p class="muted">Handled automatically, no finance action: <strong>${q.handledAutomatically}</strong> · Waiting on an employee's answer: <strong>${q.waitingOnEmployees}</strong></p>
  ${q.items.length ? html`<div class="list">${rows}</div>` : html`<div class="card empty">Nothing needs you right now.</div>`}
  </section>`, actor);
}

export interface CasePageOptions {
  actor: SessionMember;
  review: { challengeId: string; nonce: string } | null;
  payment: { challengeId: string; nonce: string } | null;
  notice?: string | null;
  error?: string | null;
}

export function casePage(v: CaseView, o: CasePageOptions): H {
  const e = v.expense;
  const own = e.memberId === o.actor.memberId;
  const fields = v.extraction?.fields ?? [];
  return layout(e.ref, html`<section data-testid="case" data-state="${e.state}" data-version="${e.version}">
  <p><a href="/review">← Exceptions</a></p>
  <div class="case-head">
    <div><h1>${e.ref} ${pill(e.state)}</h1>
      <p class="muted">${e.employee} · received ${when(e.createdAt)} · policy v${e.policyVersion ?? '—'} · ${words(e.paymentType)} payment</p></div>
    <div class="amount">${money(e.amountMinor, e.currency)}<div class="muted small">${e.merchant ?? 'merchant unclear'}${e.date ? ` · ${e.date}` : ''}</div></div>
  </div>
  ${o.notice ? html`<p class="alert ok" data-testid="notice">${o.notice}</p>` : ''}
  ${o.error ? html`<p class="alert bad" data-testid="action-error">${o.error}</p>` : ''}

  ${v.decision && v.decision.outcome !== 'CLEAR' ? html`<div class="card why" data-testid="why">
    <h2>${e.state === 'REVIEW_REQUIRED' ? 'Why this needs you' : 'Why this went to review'}</h2>
    <ul>${v.decision.reasons.map((r) => html`<li><strong>${r.text}</strong>${r.detail ? html` — <span class="muted">${r.detail}</span>` : ''}${r.clauseText ? html`<div class="clause">${r.clauseText}</div>` : ''}</li>`)}</ul>
  </div>` : ''}

  <div class="grid">
    <div class="card">
      <h2>Receipt</h2>
      ${v.evidence
        ? v.evidence.mime.startsWith('image/')
          ? html`<img class="receipt" src="/evidence/${v.evidence.fileId}" alt="Receipt image" data-testid="receipt-image">`
          : v.evidence.mime === 'application/pdf'
            ? html`<p><a href="/evidence/${v.evidence.fileId}" target="_blank" rel="noopener">Open PDF receipt</a></p>`
            : v.evidence.scan === 'REJECTED'
              ? html`<p class="alert bad">This attachment failed safety screening and is not displayed.</p>`
              : html`<p><a href="/evidence/${v.evidence.fileId}" target="_blank" rel="noopener">Open receipt (${v.evidence.mime})</a></p>`
        : html`<p class="muted">No receipt.</p>`}
      ${e.matchedTransaction ? html`<p class="muted small">Matched card transaction: ${e.matchedTransaction.descriptor} · ${money(e.matchedTransaction.amountMinor, e.matchedTransaction.currency)} · ${e.matchedTransaction.date} · card ••${e.matchedTransaction.last4} ${e.matchedTransaction.sandbox ? html`<span class="pill info">Sandbox</span>` : ''}</p>` : ''}
    </div>
    <div class="card">
      <h2>What Swipeback read ${v.extraction ? html`<span class="muted small">${v.extraction.model ?? v.extraction.extractor}</span>` : ''}</h2>
      ${v.extraction ? html`<table class="fields" data-testid="fields">${fields.map(
        (f) => html`<tr class="${f.uncertain ? 'uncertain' : ''}" data-field="${f.name}" data-uncertain="${f.uncertain}"><th>${f.name}</th>
          <td>${f.value ?? html`<span class="muted">not found</span>`}${f.uncertain ? html` <span class="pill warn">uncertain</span>` : ''}
          ${f.quote ? html`<div class="quote">“${f.quote}”${f.value ? html` <span class="muted">· ${Math.round(f.confidence * 100)}%</span>` : ''}</div>` : ''}</td></tr>`,
      )}</table>
      ${v.extraction.notes.length ? html`<ul class="notes">${v.extraction.notes.map((n) => html`<li>${n}</li>`)}</ul>` : ''}` : html`<p class="muted">Not extracted yet.</p>`}
      ${e.businessPurpose ? html`<p><strong>Business purpose (employee's words):</strong> ${e.businessPurpose}</p>` : ''}
      ${e.flags.length ? html`<p>${e.flags.map((f) => html`<span class="pill bad">${words(f)}</span> `)}</p>` : ''}
    </div>
  </div>

  ${e.state === 'REVIEW_REQUIRED' && o.review && !own ? decisionForm(v, o.review) : ''}
  ${e.state === 'REVIEW_REQUIRED' && own ? html`<p class="alert info">This is your own expense: another reviewer must decide it.</p>` : ''}
  ${v.reimbursement?.state === 'ELIGIBILITY_CHECK' && o.payment && !own ? paymentForm(v, o.payment) : ''}
  ${v.reimbursement ? html`<div class="card" data-testid="reimbursement" data-reimbursement-state="${v.reimbursement.state}">
    <h2>Reimbursement ${pill(v.reimbursement.state)}</h2>
    <p>${money(v.reimbursement.amountMinor, v.reimbursement.currency)}${v.reimbursement.authorisation ? html` · authorised ${v.reimbursement.authorisation.kind === 'AUTO' ? 'automatically within policy limits' : html`by ${v.reimbursement.authorisation.by}: “${v.reimbursement.authorisation.reason}”`}` : ' · not yet authorised'}
    ${v.reimbursement.payoutRef ? html` · simulated payout <code>${v.reimbursement.payoutRef}</code>` : ''}</p></div>` : ''}

  <div class="grid">
    <div class="card"><h2>Conversation</h2>
      ${v.conversation.length ? html`<ol class="timeline">${v.conversation.map((m) => html`<li class="${m.direction}"><div class="muted small">${m.direction === 'in' ? `From ${m.who}` : `To ${m.who}`} · ${when(m.at)}</div>${m.text.trim() ? html`<pre>${m.text.slice(0, 1200)}</pre>` : html`<p class="muted small">(no message text — receipt attached)</p>`}</li>`)}</ol>` : html`<p class="muted">No messages.</p>`}
      ${v.questions.filter((q) => q.kind === 'REVIEWER_QUESTION').map((q) => html`<p><strong>Finance asked:</strong> ${q.question}<br><strong>Answer:</strong> ${q.answer ?? html`<span class="muted">${words(q.status)}</span>`}</p>`)}
    </div>
    <div class="card"><h2>Audit trail</h2>
      <ol class="audit" data-testid="audit">${v.audit.map((a) => html`<li><span class="muted small">#${a.seq} · ${when(a.at)}</span> ${words(a.action.replace('.', ' '))} <span class="muted">— ${a.actor}</span></li>`)}</ol>
      ${v.reviews.length ? html`<h3>Decisions</h3><ul>${v.reviews.map((r) => html`<li><strong>${words(r.action)}</strong> by ${r.reviewer}: “${r.reason}”</li>`)}</ul>` : ''}
    </div>
  </div>
  </section>`, o.actor);
}

function decisionForm(v: CaseView, ch: { challengeId: string; nonce: string }): H {
  const e = v.expense;
  return html`<form class="card decide" method="post" action="/review/${e.id}/decision" data-testid="decision-form">
  <h2>Your decision</h2>
  <input type="hidden" name="version" value="${e.version}"><input type="hidden" name="challengeId" value="${ch.challengeId}"><input type="hidden" name="nonce" value="${ch.nonce}">
  <div class="choices">
    <label><input type="radio" name="action" value="APPROVE" required> Approve</label>
    <label><input type="radio" name="action" value="DECLINE"> Decline</label>
    <label><input type="radio" name="action" value="REQUEST_INFO"> Ask the employee</label>
    <label><input type="radio" name="action" value="CORRECT"> Correct details &amp; re-check</label>
  </div>
  <label>Reason (recorded in the audit trail)<textarea name="reason" required minlength="3" rows="2"></textarea></label>
  <fieldset data-when="REQUEST_INFO"><legend>Question for the employee</legend><textarea name="question" rows="2" placeholder="e.g. Who attended this dinner and which client was it for?"></textarea></fieldset>
  <fieldset data-when="APPROVE CORRECT"><legend>Payment type ${e.paymentType === 'UNKNOWN' ? html`<span class="pill warn">required to approve</span>` : ''}</legend>
    <select name="paymentType"><option value="">${e.paymentType === 'UNKNOWN' ? 'Choose…' : `Keep: ${words(e.paymentType)}`}</option><option value="CORPORATE">Company card</option><option value="PERSONAL">Personal (reimburse)</option></select></fieldset>
  <fieldset data-when="CORRECT"><legend>Corrections (leave blank to keep)</legend>
    <div class="row4"><label>Merchant<input name="merchant"></label><label>Amount<input name="amount" inputmode="decimal" placeholder="42.10"></label>
    <label>Currency<input name="currency" maxlength="3" placeholder="${e.currency ?? 'GBP'}"></label><label>Date<input name="date" type="date"></label></div>
    <label>Category<select name="category"><option value="">Keep${e.category ? `: ${words(e.category)}` : ''}</option>${CATEGORIES.map((c) => html`<option value="${c}">${words(c)}</option>`)}</select></label>
  </fieldset>
  <button class="primary" type="submit">Record decision</button>
  <p class="muted small">Approving clears the expense; any reimbursement still goes through the separate payment authorisation and limits.</p>
  </form>`;
}

function paymentForm(v: CaseView, ch: { challengeId: string; nonce: string }): H {
  const r = v.reimbursement!;
  return html`<form class="card decide" method="post" action="/review/${v.expense.id}/payment" data-testid="payment-form">
  <h2>Authorise simulated payout of ${money(r.amountMinor, r.currency)}</h2>
  <p class="muted">This reimbursement is above the automatic payment limits. Authorising releases a <strong>simulated</strong> payout to ${v.expense.employee}'s pre-verified destination.</p>
  <input type="hidden" name="reimbursementId" value="${r.id}"><input type="hidden" name="challengeId" value="${ch.challengeId}"><input type="hidden" name="nonce" value="${ch.nonce}">
  <label>Reason<textarea name="reason" required minlength="3" rows="2"></textarea></label>
  <button class="primary" type="submit">Authorise payout</button></form>`;
}


export function landingPage(): H {
  return raw(LANDING_HTML);
}

export const STATIC_CSS = raw(`
:root { --ink:#15171a; --paper:#f5f4ef; --card:#fff; --line:#e4e1d8; --muted:#6b6a64; --accent:#1f6f54; --ok:#1f6f54; --warn:#9a5b00; --bad:#a3262a; --info:#355c8a; }
* { box-sizing: border-box; } [hidden] { display: none !important; } body { margin:0; background:var(--paper); color:var(--ink); font:15px/1.5 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
.demo-banner { background:#2b2b28; color:#f3e9c6; font-size:12px; text-align:center; padding:5px 12px; letter-spacing:.2px; }
.top { display:flex; justify-content:space-between; align-items:center; padding:14px 28px; border-bottom:1px solid var(--line); background:var(--card); }
.brand { font-size:20px; text-decoration:none; color:var(--ink); letter-spacing:-.3px; } .brand b { color:var(--accent); }
.who { display:flex; gap:12px; align-items:center; } .who form { margin:0; }
main { max-width:1080px; margin:0 auto; padding:24px 28px 40px; } footer { text-align:center; color:var(--muted); font-size:12px; padding:20px; }
h1 { font-size:24px; margin:4px 0 8px; } h2 { font-size:16px; margin:0 0 12px; } h3 { font-size:14px; margin:16px 0 6px; }
.card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:18px 20px; margin:14px 0; }
.narrow { max-width:440px; margin:40px auto; } .muted { color:var(--muted); } .small { font-size:12.5px; }
.stack { display:grid; gap:12px; } label { display:grid; gap:4px; font-weight:500; font-size:14px; }
input, textarea, select { font:inherit; padding:8px 10px; border:1px solid #cfccc2; border-radius:7px; background:#fff; width:100%; }
button { font:inherit; cursor:pointer; } .primary { background:var(--accent); color:#fff; border:0; border-radius:8px; padding:10px 16px; font-weight:600; justify-self:start; }
.link { background:none; border:0; color:var(--info); padding:0; text-decoration:underline; }
.pill { display:inline-block; font-size:11.5px; font-weight:600; padding:2px 8px; border-radius:999px; vertical-align:middle; text-transform:lowercase; }
.pill.ok { background:#e2f1ea; color:var(--ok);} .pill.warn { background:#fbeed6; color:var(--warn);} .pill.bad { background:#f8e1e1; color:var(--bad);} .pill.info { background:#e4ecf6; color:var(--info);}
.alert { padding:10px 14px; border-radius:8px; } .alert.ok { background:#e2f1ea; } .alert.bad { background:#f8e1e1; } .alert.info { background:#e4ecf6; }
.count { background:var(--ink); color:#fff; border-radius:999px; font-size:14px; padding:2px 10px; vertical-align:middle; }
.list { display:grid; gap:8px; } .row { display:grid; gap:2px; background:var(--card); border:1px solid var(--line); border-radius:10px; padding:12px 16px; text-decoration:none; color:inherit; }
.row:hover { border-color:var(--accent); } .empty { text-align:center; color:var(--muted); }
.case-head { display:flex; justify-content:space-between; align-items:flex-start; gap:20px; } .amount { font-size:28px; font-weight:700; text-align:right; }
.why { border-left:4px solid var(--warn); } .why ul { margin:0; padding-left:18px; } .clause { font-size:13px; color:var(--muted); margin:2px 0 6px; }
.grid { display:grid; grid-template-columns:1fr 1fr; gap:14px; } .grid .card { margin:0; } @media (max-width:820px) { .grid { grid-template-columns:1fr; } }
.receipt { max-width:100%; border:1px solid var(--line); border-radius:6px; }
.fields { width:100%; border-collapse:collapse; font-size:14px; } .fields th { text-align:left; width:110px; color:var(--muted); font-weight:500; vertical-align:top; padding:6px 8px 6px 0; }
.fields td { padding:6px 0; border-bottom:1px solid #f0eee8; } .fields tr.uncertain td { background:#fff8ea; }
.quote { font-size:12px; color:var(--muted); font-family: ui-monospace, Menlo, monospace; } .notes { font-size:12.5px; color:var(--warn); }
.decide { border:2px solid var(--accent); display:grid; gap:12px; } .choices { display:flex; flex-wrap:wrap; gap:16px; } .choices label { display:flex; gap:6px; align-items:center; font-weight:600; }
.choices input { width:auto; } fieldset { border:1px dashed var(--line); border-radius:8px; padding:10px 12px; display:grid; gap:8px; } legend { font-size:13px; color:var(--muted); }
.row4 { display:grid; grid-template-columns:2fr 1fr 1fr 1.4fr; gap:8px; }
.timeline, .audit { list-style:none; padding:0; margin:0; display:grid; gap:8px; } .timeline pre { white-space:pre-wrap; font:13px/1.45 inherit; margin:4px 0 0; background:#faf9f5; padding:8px; border-radius:6px; }
.timeline li.out pre { background:#eef5f1; } code { font-size:12.5px; background:#f0eee8; padding:1px 5px; border-radius:4px; }

`);

export const STATIC_JS = raw(`
document.addEventListener('DOMContentLoaded', () => {
  const form = document.querySelector('[data-testid=decision-form]');
  if (!form) return;
  const sync = () => {
    const v = (form.querySelector('input[name=action]:checked') || {}).value || '';
    form.querySelectorAll('fieldset[data-when]').forEach((f) => { f.hidden = !f.dataset.when.split(' ').includes(v); });
  };
  form.addEventListener('change', sync); sync();
});
`);

/** Content hash for cache-busting static assets (changes whenever CSS or JS changes). */
export const ASSET_VERSION = createHash('sha256').update(String(STATIC_CSS)).update(String(STATIC_JS)).digest('hex').slice(0, 10);
