import { describe, expect, it } from 'vitest';
import {
  customerTransferPreviewRequestSchema,
  customerTransferRequestSchema,
} from '@nexa/contracts';

/**
 * Customer 360: a destination id an operator types on a Persian keyboard is the same id
 * (Codex review of #146). Normalised at the boundary, then held to the one Telegram-id rule.
 */
describe('the account-transfer request schemas', () => {
  it('reads Persian and Arabic-Indic digits as ASCII before validating', () => {
    expect(
      customerTransferPreviewRequestSchema.parse({ destinationTelegramUserId: ' ۹۵۱۰۰۲ ' }),
    ).toEqual({ destinationTelegramUserId: '951002' });
    expect(
      customerTransferPreviewRequestSchema.parse({ destinationTelegramUserId: '٩٥١٠٠٢' }),
    ).toEqual({ destinationTelegramUserId: '951002' });
    expect(
      customerTransferRequestSchema.parse({
        idempotencyKey: 'transfer-key-1',
        destinationTelegramUserId: '۷۷۷',
        fingerprint: 'a'.repeat(64),
        confirmTelegramUserId: '۷۷۷',
        reason: 'lost account',
      }).destinationTelegramUserId,
    ).toBe('777');
  });

  it('still refuses what is not a Telegram id at all', () => {
    for (const bad of ['abc', '0123', '-5', '۰۱۲', '']) {
      expect(
        customerTransferPreviewRequestSchema.safeParse({ destinationTelegramUserId: bad }).success,
      ).toBe(false);
    }
  });
});
