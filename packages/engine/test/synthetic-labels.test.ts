import { describe, expect, it } from 'vitest';
import * as templates from '../src/templates.ts';

/**
 * AC-11: every email Swipeback sends says it is a synthetic demo with simulated payouts. A new
 * template fails this test until it is listed (and labelled). Screens: apps/web/test/synthetic-labels.test.ts.
 */

const e = { ref: 'SB-1001', merchant: 'Pret A Manger', amountMinor: 1125, currency: 'GBP', date: '2026-10-16' };
const txn = { descriptor: 'PRET A MANGER LONDON GB', amountMinor: 1125, currency: 'GBP', date: '2026-10-16', last4: '4242' };

const RENDERERS: Record<string, () => templates.Rendered> = {
  clearedCardMessage: () => templates.clearedCardMessage(e, { descriptor: txn.descriptor, date: txn.date }),
  paidMessage: () => templates.paidMessage(e, 'SIMULATED-MP-ABC123'),
  awaitingPaymentAuthorisationMessage: () => templates.awaitingPaymentAuthorisationMessage(e),
  underReviewMessage: () => templates.underReviewMessage(e, ['it is above the limit']),
  rejectedMessage: () => templates.rejectedMessage(e, ['this merchant is not claimable'], ['Policy NW-12']),
  duplicateReceivedMessage: () => templates.duplicateReceivedMessage(e, 'EXPORTED'),
  questionMessage: () => templates.questionMessage(e, 'BUSINESS_PURPOSE', 'Policy NW-2'),
  receiptRequestMessage: () => templates.receiptRequestMessage(e, txn, 'Policy NW-1'),
  questionReminderMessage: () => templates.questionReminderMessage(e),
  reviewerQuestionMessage: () => templates.reviewerQuestionMessage(e, 'Priya Shah', 'Who attended?'),
  reviewOutcomeMessage: () => templates.reviewOutcomeMessage(e, 'APPROVED', 'Site visit confirmed'),
  loginLinkMessage: () => templates.loginLinkMessage('http://localhost:3000/auth/callback?t=x'),
  reviewerNotice: () => templates.reviewerNotice(e, 'Sam Taylor', ['it is above the limit'], ['Policy NW-5']),
  enrolmentMessage: () => templates.enrolmentMessage(),
  helpMessage: () => templates.helpMessage(),
  statusMessage: () => templates.statusMessage([]),
};

describe('synthetic and simulated labels (AC-11)', () => {
  it('covers every outbound template', () => {
    const exported = Object.entries(templates)
      .filter(([name, v]) => typeof v === 'function' && /(Message|Notice)$/.test(name))
      .map(([name]) => name)
      .sort();
    expect(exported).toEqual(Object.keys(RENDERERS).sort());
  });

  it.each(Object.keys(RENDERERS))('%s says SYNTHETIC DEMO and that payouts are simulated', (name) => {
    const { text } = RENDERERS[name]!();
    expect(text).toContain('SYNTHETIC DEMO');
    expect(text).toMatch(/simulated payouts only, no real money moves/);
  });

  it('a payout email names the payout as simulated in the subject', () => {
    expect(templates.paidMessage(e, 'SIMULATED-MP-ABC123').subject).toMatch(/simulated/i);
  });
});
