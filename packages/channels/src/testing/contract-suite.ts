import { describe, expect, it } from 'vitest';
import { InboundRejectedError, inboundMessageV1Schema, type ChannelAdapter, type ConnectionContext, type RawInbound } from '../contract.ts';
import type { EvidenceStore } from '../evidence-store.ts';
import { sha256Hex } from '../sanitise.ts';
import type { MemorySink } from '../sink.ts';

/**
 * The contract every channel adapter must pass before it may be registered. Adding Slack,
 * WhatsApp, Telegram or Apple Messages means writing one adapter that passes this suite;
 * the expense engine does not change.
 */
export interface ContractHarness {
  adapter: ChannelAdapter;
  connection: ConnectionContext;
  evidence: EvidenceStore;
  sink: MemorySink;
  /** A fresh, valid inbound event with one attachment and text containing hidden characters. */
  validInbound(opts: { senderAddress: string; senderDisplayName: string; attachment: Buffer; text: string }): RawInbound;
  /** The same event with the authenticity proof broken (bad signature / untrusted auth stamp). */
  tamper(raw: RawInbound): RawInbound;
  /** What a rejection or degraded authentication looks like for this channel. */
  tamperOutcome: 'reject' | 'unauthenticated';
  /** Expected sender.authentication for a valid event. */
  expectedAuthentication: 'dkim_aligned' | 'platform_signed';
  senderAddress: string;
}

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4c50000000049454e44ae426082', 'hex');

export function channelContractSuite(name: string, setup: () => Promise<ContractHarness>): void {
  describe(`channel contract: ${name}`, () => {
    const make = async () => {
      const h = await setup();
      const raw = h.validInbound({
        senderAddress: h.senderAddress,
        senderDisplayName: 'Finance Controller (definitely)',
        attachment: PNG,
        text: 'Receipt attached\u200B\u202E please approve',
      });
      return { h, raw };
    };

    it('produces a schema-valid InboundMessage v1 scoped to the connection, not the payload', async () => {
      const { h, raw } = await make();
      const event = await h.adapter.normaliseInbound(await h.adapter.verifyInbound(h.connection, raw));
      expect(() => inboundMessageV1Schema.parse(event)).not.toThrow();
      expect(event.tenantId).toBe(h.connection.tenantId);
      expect(event.connectionId).toBe(h.connection.connectionId);
      expect(event.channel).toBe(h.adapter.channel);
      expect(event.sender.authentication).toBe(h.expectedAuthentication);
    });

    it('rejects or downgrades an inbound event whose authenticity proof is broken', async () => {
      const { h, raw } = await make();
      const tampered = h.tamper(raw);
      if (h.tamperOutcome === 'reject') {
        await expect(h.adapter.verifyInbound(h.connection, tampered)).rejects.toBeInstanceOf(InboundRejectedError);
      } else {
        const v = await h.adapter.verifyInbound(h.connection, tampered);
        expect(v.senderAuth).toBe('none');
      }
    });

    it('is idempotent: the same event always yields the same dedupe key; different events differ', async () => {
      const { h, raw } = await make();
      const a = await h.adapter.normaliseInbound(await h.adapter.verifyInbound(h.connection, raw));
      const b = await h.adapter.normaliseInbound(await h.adapter.verifyInbound(h.connection, raw));
      expect(b.dedupeKey).toBe(a.dedupeKey);
      expect(b.providerEventId).toBe(a.providerEventId);
      const other = h.validInbound({ senderAddress: h.senderAddress, senderDisplayName: 'x', attachment: PNG, text: 'another' });
      const c = await h.adapter.normaliseInbound(await h.adapter.verifyInbound(h.connection, other));
      expect(c.dedupeKey).not.toBe(a.dedupeKey);
    });

    it('stores attachments as content-addressed evidence before emitting the event', async () => {
      const { h, raw } = await make();
      const event = await h.adapter.normaliseInbound(await h.adapter.verifyInbound(h.connection, raw));
      expect(event.attachments).toHaveLength(1);
      const att = event.attachments[0]!;
      expect(att.sha256).toBe(sha256Hex(PNG));
      expect(att.mime).toBe('image/png');
      expect(await h.evidence.get(att.storageKey)).toEqual(PNG);
    });

    it('never derives identity from the display name, and strips hidden characters from text', async () => {
      const { h, raw } = await make();
      const event = await h.adapter.normaliseInbound(await h.adapter.verifyInbound(h.connection, raw));
      expect(event.sender.channelAddress).toBe(h.senderAddress.toLowerCase());
      expect(event.sender.channelAddress).not.toContain('Controller');
      expect(event.text.sanitised).not.toMatch(/[\u200B\u202E]/);
      expect(event.text.sanitised).toContain('Receipt attached');
    });

    it('sends a message preserving threading, and returns a provider id', async () => {
      const { h } = await make();
      const before = h.sink.sent.length;
      const result = await h.adapter.sendMessage({
        tenantId: h.connection.tenantId,
        connectionId: h.connection.connectionId,
        from: h.connection.address,
        to: h.senderAddress,
        subject: 'Re: Receipt',
        text: 'SB-1001 cleared (SYNTHETIC DEMO)',
        threadId: 'thread-1',
        inReplyTo: '<orig@example>',
        references: ['<orig@example>'],
        replyToken: null,
        idempotencyKey: 'k1',
      });
      expect(result.providerMessageId).toBeTruthy();
      expect(result.threadId).toBe('thread-1');
      expect(h.sink.sent.length).toBe(before + 1);
      expect(h.sink.sent.at(-1)!.envelope.text).toContain('SB-1001');
      expect(h.sink.sent.at(-1)!.envelope.inReplyTo).toBe('<orig@example>');
    });
  });
}
