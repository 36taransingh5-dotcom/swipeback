import { describe, expect, it } from 'vitest';
import type { SessionMember } from '@swipeback/engine';
import * as views from '../src/views.ts';

/** AC-11 for screens: every page carries the SYNTHETIC / simulated-payout banner. */

const BANNER = /<div class="demo-banner">SYNTHETIC DEMO — [^<]*payouts are simulated, no money moves\.<\/div>/;
const actor = { memberId: 'm1', organisationId: 'o1', displayName: 'Priya Shah (synthetic)', email: 'priya@example.com', roles: ['reviewer', 'payment_approver', 'admin'] } as unknown as SessionMember;
const mailbox = { designatedAddress: 'finance@example.com', connections: [] };

const PAGES: Record<string, () => unknown> = {
  loginPage: () => views.loginPage(),
  checkEmailPage: () => views.checkEmailPage(),
  errorPage: () => views.errorPage(404, 'Nothing here.', null),
  connectPage: () => views.connectPage(actor, mailbox, { configured: false, notice: null, error: null }),
  queuePage: () => views.queuePage(actor, { items: [], handledAutomatically: 0, waitingOnEmployees: 0 }, mailbox),
  // casePage needs a full case view; the browser test asserts its banner.
  casePage: () => null,
};

describe('synthetic labels on screens (AC-11)', () => {
  it('covers every page renderer', () => {
    const exported = Object.entries(views).filter(([name, v]) => typeof v === 'function' && name.endsWith('Page')).map(([name]) => name).sort();
    expect(exported).toEqual(Object.keys(PAGES).sort());
  });

  it.each(Object.keys(PAGES).filter((p) => p !== 'casePage'))('%s shows the SYNTHETIC banner', async (name) => {
    expect(String(await PAGES[name]!())).toMatch(BANNER);
  });
});
