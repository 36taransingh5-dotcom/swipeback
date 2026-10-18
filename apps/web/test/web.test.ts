import type { AddressInfo } from 'node:net';
import { serve, type ServerType } from '@hono/node-server';
import { chromium, type Browser } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyAuditChain } from '@swipeback/db';
import { signCardEvent } from '@swipeback/engine';
import { createApp } from '@swipeback/web';
import { textReceipt } from '../../../test/fixtures/receipts.ts';
import { CARD_SECRET, CONTROLLER, createHarness, ukDate, type Harness } from '../../../packages/engine/test/harness.ts';

/** AC-08 end to end in a real browser: approval email -> sign-in -> decision -> separate payment authorisation. */

let h: Harness;
let server: ServerType;
let base: string;
let browser: Browser;

beforeAll(async () => {
  h = await createHarness();
  server = serve({ fetch: createApp(h.deps, { secureCookies: false }).fetch, port: 0, hostname: '127.0.0.1' });
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  h.deps.config.appUrl = base;
  browser = await chromium.launch({ headless: true });
}, 120_000);

afterAll(async () => {
  await browser?.close();
  server?.close();
  const audit = await verifyAuditChain(h.db.pool, h.org.organisationId);
  expect(audit.ok).toBe(true);
  await h.close();
});

const hotel = () =>
  textReceipt({ merchant: 'Premier Stay Hotel Watford', receiptNo: 'H-7781', date: ukDate(2), items: [['Room, 1 night', '210.00']], total: '210.00', vat: '35.00', vatNumber: 'GB000000000', paidWith: { card: '9911' } });
const linkIn = (text: string, re: RegExp) => re.exec(text)?.[0] ?? null;

describe('reviewer web app', () => {
  it('serves the landing page stylesheet and script', async () => {
    const page = await fetch(`${base}/`);
    const html = await page.text();
    expect(page.status).toBe(200);
    expect(html).toContain('/static/landing.css?v=');
    expect(html).toContain('/static/landing.js?v=');

    const css = await fetch(`${base}/static/landing.css`);
    expect(css.status).toBe(200);
    expect(css.headers.get('content-type')).toContain('text/css');
    expect(await css.text()).toContain('--blue: #123bcc');

    const js = await fetch(`${base}/static/landing.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toContain('javascript');

    const accessCss = await fetch(`${base}/static/access.css`);
    expect(accessCss.status).toBe(200);
    expect(await accessCss.text()).toContain('--lime: #e0fa83');
  });

  it('unauthenticated pages redirect to sign-in; APIs return 401; security headers are set', async () => {
    const page = await (await browser.newContext()).newPage();
    const res = await page.goto(`${base}/review`);
    expect(page.url()).toBe(`${base}/login?next=%2Freview`);
    const headers = res!.headers();
    expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(headers['referrer-policy']).toBe('no-referrer');
    expect(headers['x-frame-options']).toBe('DENY');
    await page.goto(`${base}/login/connect`);
    expect(page.url()).toBe(`${base}/login?next=%2Flogin%2Fconnect`);
    expect(await page.textContent('h1')).toContain('Welcome');
    const api = await fetch(`${base}/api/expenses/00000000-0000-0000-0000-000000000000/review`, { method: 'POST', body: '{}' });
    expect(api.status).toBe(401);
    await page.context().close();
  });

  it('approval link -> magic-link sign-in -> approve -> separate payment authorisation -> simulated payout, exactly once', async () => {
    await h.email({ attachments: [{ filename: 'receipt.txt', mime: 'text/plain', content: hotel() }] });
    await h.drain();
    const approvalMail = h.sentTo(CONTROLLER).find((m) => m.kind === 'approval_request')!;
    const approvalLink = linkIn(Buffer.from(approvalMail.raw.split('\r\n\r\n')[1]!, 'base64').toString('utf8'), new RegExp(`${base}/a/[0-9a-f-]{36}\\?n=[\\w-]+`))!;
    expect(approvalLink).toBeTruthy();

    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(approvalLink);
    expect(new URL(page.url()).pathname).toBe('/login');
    await page.fill('input[name=email]', CONTROLLER);
    await page.click('button[type=submit]');
    await page.waitForSelector('[data-testid=check-email]');
    await h.drain();
    const loginMail = h.sentTo(CONTROLLER).at(-1)!;
    const loginLink = linkIn(loginMail.envelope.text, new RegExp(`${base}/auth/callback\\?t=[\\w-]+`))!;

    await page.goto(loginLink);
    expect(page.url()).toBe(approvalLink); // lands back on the case the email was about
    const cookie = (await context.cookies()).find((c) => c.name === 'sb_session')!;
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Lax' });
    await expect(page.textContent('[data-testid=why]')).resolves.toContain('NW-5');
    expect(await page.textContent('.demo-banner')).toMatch(/^SYNTHETIC DEMO — .*payouts are simulated, no money moves\.$/); // AC-11 on the case page
    // Regression: the Connect form redirects to Google, so only /connect may allow that form target.
    const connectCsp = (await context.request.get(`${base}/connect`)).headers()['content-security-policy'];
    expect(connectCsp).toContain("form-action 'self' https://accounts.google.com");
    const connections = await context.request.get(`${base}/login/connect`);
    expect(connections.status()).toBe(200);
    const connectionHtml = await connections.text();
    expect(connectionHtml).toContain('Connect Slack');
    expect(connectionHtml).toContain('Connect iMessage');
    expect(connectionHtml).toContain('/static/access.css?v=');
    expect((await context.request.get(`${base}/review`)).headers()['content-security-policy']).toContain("form-action 'self';");
    expect(await page.getAttribute('[data-testid=case]', 'data-state')).toBe('REVIEW_REQUIRED');

    await page.check('input[name=action][value=APPROVE]');
    await page.fill('textarea[name=reason]', 'One-night stay for the Watford install; rate agreed with the client');
    await page.click('[data-testid=decision-form] button[type=submit]');
    await page.waitForSelector('[data-testid=notice]');
    expect(await page.getAttribute('[data-testid=case]', 'data-state')).toBe('APPROVED');

    // Clearing is not paying: the reimbursement waits for a payment approver.
    await h.drain();
    await page.reload();
    expect(await page.getAttribute('[data-testid=reimbursement]', 'data-reimbursement-state')).toBe('ELIGIBILITY_CHECK');
    expect(await h.payouts.ledgerCount()).toBe(0);
    await page.fill('[data-testid=payment-form] textarea[name=reason]', 'Within the accommodation budget for the install');
    await page.click('[data-testid=payment-form] button[type=submit]');
    await page.waitForSelector('[data-testid=notice]');
    await h.drain();
    await page.reload();
    expect(await page.getAttribute('[data-testid=reimbursement]', 'data-reimbursement-state')).toBe('SIMULATED_PAID');
    expect(await page.textContent('[data-testid=reimbursement]')).toMatch(/SIMULATED-MP-/);
    expect(await h.payouts.ledgerCount()).toBe(1);

    // The approval link was single-use.
    const reused = await page.goto(approvalLink);
    expect(reused!.status()).toBe(410);

    // The evidence API returns the source trail and audit for the signed-in reviewer only.
    const expenseId = (await h.db.pool.query('SELECT id FROM expenses')).rows[0].id;
    const trail = await page.request.get(`${base}/api/expenses/${expenseId}/evidence`);
    const body = await trail.json();
    expect(body.audit.map((a: { action: string }) => a.action)).toEqual(expect.arrayContaining(['expense.approved', 'reimbursement.authorised', 'reimbursement.simulated_paid']));
    expect((await fetch(`${base}/api/expenses/${expenseId}/evidence`)).status).toBe(401);
    await context.close();
  }, 120_000);

  it('card-event API verifies the HMAC signature', async () => {
    const body = JSON.stringify({ provider: 'card-sim', transactionId: 'web-1', cardLast4: '4242', amountMinor: 1125, currency: 'GBP', merchantDescriptor: 'PRET A MANGER', transactedAt: new Date().toISOString(), synthetic: true });
    const headers = { 'content-type': 'application/json', 'x-organisation-id': h.org.organisationId };
    const good = await fetch(`${base}/api/card-events`, { method: 'POST', body, headers: { ...headers, 'x-card-feed-signature': signCardEvent(CARD_SECRET, body, Math.floor(Date.now() / 1000)) } });
    expect(good.status).toBe(202);
    const bad = await fetch(`${base}/api/card-events`, { method: 'POST', body, headers: { ...headers, 'x-card-feed-signature': signCardEvent('wrong-secret-0123456789', body, Math.floor(Date.now() / 1000)) } });
    expect(bad.status).toBe(401);
  });
});
