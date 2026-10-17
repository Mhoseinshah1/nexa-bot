import { describe, expect, it } from 'vitest';
import {
  EXPIRY_REMINDER_STATES,
  ORDER_ORIGINS,
  SALE_ORDER_ORIGINS,
  SERVICE_MACHINE,
  SERVICE_REFUND_ELIGIBLE_SERVICE_STATES,
  SERVICE_TRANSFERABLE_STATES,
  USAGE_REMINDER_STATES,
  orderOriginIsSale,
} from '@nexa/contracts';
import { OPERATION_LEGAL_FROM } from '../../apps/api/src/modules/commerce/provisioning/application/provision-executor';

/**
 * An ENDED Mirza service (TERMINATED, never on a panel) and its LEGACY_HISTORY order must be
 * unreachable by every lane (owner decision 2026-10-17). Each lane gates on a state list, and
 * a state list is a promise: these tests fail the moment one of them admits TERMINATED, or an
 * order origin that is not a sale becomes one. The runtime half — the same lanes run against
 * real ended rows — is `tests/integration/legacy-ended-services-lanes.test.ts`.
 */
describe('nothing is legal from TERMINATED', () => {
  it('no provider operation may start from it, and TERMINATE itself is refused a second time', () => {
    for (const [operation, legalFrom] of Object.entries(OPERATION_LEGAL_FROM)) {
      expect(legalFrom, operation).not.toContain('TERMINATED');
    }
  });

  it('the service machine has no edge out of it', () => {
    expect(SERVICE_MACHINE.terminal).toContain('TERMINATED');
    expect(SERVICE_MACHINE.transitions.filter((t) => t.from === 'TERMINATED')).toEqual([]);
  });

  it('no reminder, refund request or transfer is offered on it', () => {
    expect(EXPIRY_REMINDER_STATES as readonly string[]).not.toContain('TERMINATED');
    expect(USAGE_REMINDER_STATES as readonly string[]).not.toContain('TERMINATED');
    expect(SERVICE_REFUND_ELIGIBLE_SERVICE_STATES as readonly string[]).not.toContain('TERMINATED');
    expect(SERVICE_TRANSFERABLE_STATES as readonly string[]).not.toContain('TERMINATED');
  });
});

describe('a history order is not a sale', () => {
  it('LEGACY_HISTORY is outside SALE_ORDER_ORIGINS, so no report counts its amount as revenue', () => {
    expect(ORDER_ORIGINS).toContain('LEGACY_HISTORY');
    expect(orderOriginIsSale('LEGACY_HISTORY')).toBe(false);
    expect(SALE_ORDER_ORIGINS).not.toContain('LEGACY_HISTORY');
    expect(SALE_ORDER_ORIGINS).toEqual(['STANDARD']);
  });
});
