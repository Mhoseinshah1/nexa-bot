import { describe, expect, it } from 'vitest';
import type { ProviderUsage } from '@nexa/contracts';
import { allowanceReached } from '../../apps/api/src/modules/commerce/provisioning/application/provisioner.service';

/**
 * WP15 G2: the verdict of a verification READ, pinned as a table.
 *
 * "At least", in whole seconds for the expiry: panels store epoch SECONDS, so a target
 * counted from a millisecond clock is up to 999 ms past what the panel can hold even
 * when the renewal landed exactly.
 */
const usage = (expiresAt: Date | null, totalBytes: bigint | null): ProviderUsage => ({
  usedBytes: 0n,
  totalBytes,
  expiresAt,
  lastSeen: { kind: 'UNSUPPORTED' },
});

const T = new Date('2027-03-01T10:00:00.750Z');

describe('allowanceReached', () => {
  it('counts an expiry the panel holds to the second as reached, whatever the milliseconds', () => {
    expect(
      allowanceReached(
        { expiresAt: T, trafficLimitBytes: null },
        usage(new Date('2027-03-01T10:00:00.000Z'), null),
      ),
    ).toBe(true);
  });

  it('counts a later expiry as reached and an earlier one, by a second, as not', () => {
    expect(
      allowanceReached(
        { expiresAt: T, trafficLimitBytes: null },
        usage(new Date('2027-04-01T00:00:00Z'), null),
      ),
    ).toBe(true);
    expect(
      allowanceReached(
        { expiresAt: T, trafficLimitBytes: null },
        usage(new Date('2027-03-01T09:59:59.000Z'), null),
      ),
    ).toBe(false);
  });

  it('counts a panel with no expiry as holding any finite window', () => {
    expect(allowanceReached({ expiresAt: T, trafficLimitBytes: null }, usage(null, null))).toBe(
      true,
    );
  });

  it('reads traffic as at least the target, and a zero target as the unlimited one', () => {
    expect(allowanceReached({ expiresAt: null, trafficLimitBytes: 100n }, usage(null, 100n))).toBe(
      true,
    );
    expect(allowanceReached({ expiresAt: null, trafficLimitBytes: 100n }, usage(null, 99n))).toBe(
      false,
    );
    expect(allowanceReached({ expiresAt: null, trafficLimitBytes: 100n }, usage(null, null))).toBe(
      true,
    );
    expect(allowanceReached({ expiresAt: null, trafficLimitBytes: 0n }, usage(null, 100n))).toBe(
      false,
    );
    expect(allowanceReached({ expiresAt: null, trafficLimitBytes: 0n }, usage(null, null))).toBe(
      true,
    );
  });

  it('never calls an answer with no usage a verdict of reached', () => {
    expect(allowanceReached({ expiresAt: T, trafficLimitBytes: null }, null)).toBe(false);
  });
});
