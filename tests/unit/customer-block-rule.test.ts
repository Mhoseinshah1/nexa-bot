import { describe, expect, it } from 'vitest';
import {
  CUSTOMER_BLOCK_REASON_MAX_LENGTH,
  blockCustomerRequestSchema,
  unblockCustomerRequestSchema,
} from '@nexa/contracts';
import { normaliseBlockReason } from '../../apps/api/src/modules/commerce/customers/application/customer.service.js';

/**
 * The one block rule, at its two edges (WP10G, closing OQ-WP10F-03): the HTTP schema in front
 * of the service, and the service's own normaliser that every surface ends in. Both refuse the
 * same three things — nothing, whitespace, and more than the bound — and neither cuts.
 */
describe('a block needs a reason; an unblock does not', () => {
  const key = { idempotencyKey: 'a-long-enough-key' };

  it('the block schema refuses a missing, empty or whitespace-only reason', () => {
    expect(blockCustomerRequestSchema.safeParse(key).success).toBe(false);
    expect(blockCustomerRequestSchema.safeParse({ ...key, reason: '' }).success).toBe(false);
    expect(blockCustomerRequestSchema.safeParse({ ...key, reason: ' \t\n ' }).success).toBe(false);
  });

  it('the block schema trims and bounds a real reason', () => {
    const parsed = blockCustomerRequestSchema.parse({ ...key, reason: '  spam  ' });
    expect(parsed.reason).toBe('spam');
    expect(
      blockCustomerRequestSchema.safeParse({
        ...key,
        reason: 'x'.repeat(CUSTOMER_BLOCK_REASON_MAX_LENGTH),
      }).success,
    ).toBe(true);
    expect(
      blockCustomerRequestSchema.safeParse({
        ...key,
        reason: 'x'.repeat(CUSTOMER_BLOCK_REASON_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
  });

  it('both schemas count the bound in code points, as the service does', () => {
    // 500 emoji are 500 code points and 1000 UTF-16 units. Zod 4 counts a string's length in
    // code points, as the service does; this pins that, so a UTF-16 check cannot replace it.
    const emoji = '😀'.repeat(CUSTOMER_BLOCK_REASON_MAX_LENGTH);
    expect(blockCustomerRequestSchema.safeParse({ ...key, reason: emoji }).success).toBe(true);
    expect(blockCustomerRequestSchema.safeParse({ ...key, reason: `${emoji}😀` }).success).toBe(
      false,
    );
    expect(unblockCustomerRequestSchema.safeParse({ ...key, reason: emoji }).success).toBe(true);
    expect(unblockCustomerRequestSchema.safeParse({ ...key, reason: `${emoji}😀` }).success).toBe(
      false,
    );
  });

  it('the unblock schema keeps its reason optional, so the block rule cannot leak onto it', () => {
    expect(unblockCustomerRequestSchema.safeParse(key).success).toBe(true);
    expect(unblockCustomerRequestSchema.parse({ ...key, reason: '  note ' }).reason).toBe('note');
  });

  it('the service normaliser refuses rather than cuts, counting code points', () => {
    expect(normaliseBlockReason(null)).toBeNull();
    expect(normaliseBlockReason(undefined)).toBeNull();
    expect(normaliseBlockReason('')).toBeNull();
    expect(normaliseBlockReason('   ')).toBeNull();
    expect(normaliseBlockReason('  spam  ')).toBe('spam');
    // 500 emoji are 500 code points and 1000 UTF-16 units: accepted whole, never halved.
    const emoji = '😀'.repeat(CUSTOMER_BLOCK_REASON_MAX_LENGTH);
    expect(normaliseBlockReason(emoji)).toBe(emoji);
    expect(normaliseBlockReason(`${emoji}😀`)).toBeNull();
  });
});
