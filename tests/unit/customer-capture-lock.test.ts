import { describe, expect, it } from 'vitest';
import { CUSTOMER_CAPTURE_LOCK_CLASS } from '../../apps/api/src/modules/commerce/customers/infrastructure/drizzle-customer-capture.repository.js';
import { USERNAME_CAPTURE_LOCK_CLASS } from '../../apps/api/src/modules/commerce/provisioning/infrastructure/drizzle-username-capture.repository.js';

/**
 * The three customer text windows — username, discount code and the generic capture —
 * answer one question, what the customer's next plain message means, and opening any
 * one closes the other two. That is only true if every opener waits on the SAME lock:
 * under a class of its own, two prompt-opening updates for one customer could each
 * close what the other had not yet inserted and both commit open.
 */
describe('the customer text windows', () => {
  it('serialise every window-opening path on one advisory lock class', () => {
    expect(CUSTOMER_CAPTURE_LOCK_CLASS).toBe(USERNAME_CAPTURE_LOCK_CLASS);
  });
});
