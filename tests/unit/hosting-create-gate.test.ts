import { describe, expect, it } from 'vitest';
import {
  hostedBotCreateRefusal,
  HOSTED_BOTS_PRODUCTION_RELEASE_MARKER,
  HOSTED_BOTS_RELEASE_MARKER_VALUE,
} from '../../apps/api/src/modules/platform/hosting/domain/create-gate';
import { buildHosting } from '../../apps/api/src/modules/platform/hosting/infrastructure/build-hosting';
import {
  estimateCapacity,
  ESTIMATE_OWNER_RESERVED,
} from '../../apps/api/src/modules/platform/hosting/domain/capacity-estimate';
import { planTransition } from '../../apps/api/src/modules/platform/hosting/domain/hosted-bot-lifecycle';
import { HOSTED_BOT_TRANSITIONS, HOSTED_BOT_TENANT_STATUS, isNexaError } from '@nexa/contracts';

/**
 * Phase 6A PR-3 — the production gate on creating hosted bots, and the panel's pure rules.
 *
 * The gate is the owner's condition that no hosted bot exists in production before row-level
 * security (PR-1) and the isolation proof (PR-5) are merged. These cases are what make
 * opening it a deliberate edit: the marker is pinned as unreleased here, so PR-5 changes this
 * test in the same commit that flips it.
 */
describe('the hosted-bot create gate', () => {
  it('ships CLOSED: the compiled release marker is unset', () => {
    // PR-5 flips this (and this assertion) once tenant isolation is enforced and proven.
    expect(HOSTED_BOTS_PRODUCTION_RELEASE_MARKER).toBeNull();
  });

  it('is shut in production with the flag on and no marker — and with a wrong marker', () => {
    for (const releaseMarker of [
      null,
      '',
      'true',
      'p6a-pr1-rls',
      `${HOSTED_BOTS_RELEASE_MARKER_VALUE} `,
    ]) {
      expect(
        hostedBotCreateRefusal({ nodeEnv: 'production', flagEnabled: true, releaseMarker }),
      ).toBe('PRODUCTION_NOT_RELEASED');
    }
  });

  it('treats any NODE_ENV other than development and test as production', () => {
    for (const nodeEnv of ['production', 'staging', 'prod', '', 'Production']) {
      expect(hostedBotCreateRefusal({ nodeEnv, flagEnabled: true, releaseMarker: null })).toBe(
        'PRODUCTION_NOT_RELEASED',
      );
    }
  });

  it('needs the flag everywhere, even with the marker', () => {
    for (const nodeEnv of ['production', 'development', 'test']) {
      expect(
        hostedBotCreateRefusal({
          nodeEnv,
          flagEnabled: false,
          releaseMarker: HOSTED_BOTS_RELEASE_MARKER_VALUE,
        }),
      ).toBe('FLAG_OFF');
    }
  });

  it('opens in production only with both keys; outside production with the flag', () => {
    expect(
      hostedBotCreateRefusal({
        nodeEnv: 'production',
        flagEnabled: true,
        releaseMarker: HOSTED_BOTS_RELEASE_MARKER_VALUE,
      }),
    ).toBeNull();
    expect(
      hostedBotCreateRefusal({ nodeEnv: 'development', flagEnabled: true, releaseMarker: null }),
    ).toBeNull();
    expect(
      hostedBotCreateRefusal({ nodeEnv: 'test', flagEnabled: true, releaseMarker: null }),
    ).toBeNull();
  });

  it('the wired service reads the compiled marker: production with the flag on stays shut', () => {
    const fake = {} as never;
    const built = (nodeEnv: string) =>
      buildHosting({
        db: fake,
        config: { NODE_ENV: nodeEnv, HOSTED_BOTS_CREATE_ENABLED: true },
        uow: fake,
        guard: fake,
        audit: fake,
        opsLog: fake,
        outbox: fake,
        idempotency: fake,
        scopeActivity: fake,
        cipher: fake,
        hasher: fake,
        clock: fake,
        ids: fake,
        qr: null,
        admins: fake,
        roles: fake,
        sessions: fake,
        verifyOwnPassword: fake,
        capacityLimits: fake,
        capacityResolver: fake,
        systemProbe: fake,
        diskPaths: [],
        installationTenantId: () => null,
      }).hosting.createGate();
    expect(built('production')).toEqual({ enabled: false, refusal: 'PRODUCTION_NOT_RELEASED' });
    expect(built('development')).toEqual({ enabled: true, refusal: null });
  });
});

describe('the hosted-bot state machine', () => {
  const now = new Date('2026-11-05T12:00:00Z');

  it('moves each action only from its allowed states, and maps each state to a tenant status', () => {
    const states = ['ACTIVE', 'SUSPENDED', 'EXPIRED', 'DELETED', 'PURGED'] as const;
    for (const [action, rule] of Object.entries(HOSTED_BOT_TRANSITIONS)) {
      for (const state of states) {
        const attempt = () => planTransition(action as never, { state, expiresAt: null }, now);
        if ((rule.from as readonly string[]).includes(state)) {
          expect(attempt().to).toBe(rule.to);
        } else {
          expect(attempt).toThrow();
        }
      }
    }
    expect(HOSTED_BOT_TENANT_STATUS).toEqual({
      ACTIVE: 'ACTIVE',
      SUSPENDED: 'STOPPED',
      EXPIRED: 'STOPPED',
      DELETED: 'DISABLED',
      PURGED: 'DISABLED',
    });
  });

  it('refuses to activate a bot whose expiry has passed', () => {
    try {
      planTransition('ACTIVATE', { state: 'EXPIRED', expiresAt: now }, now);
      throw new Error('expected a refusal');
    } catch (error) {
      expect(isNexaError(error) && error.code).toBe('hosting.expiry_passed');
    }
    expect(
      planTransition('ACTIVATE', { state: 'EXPIRED', expiresAt: new Date(now.getTime() + 1) }, now)
        .to,
    ).toBe('ACTIVE');
  });
});

describe('the server card’s estimate', () => {
  const base = {
    cores: 4,
    liveHostedBots: 0,
    availableMemoryBytes: 4 * 1024 ** 3,
    memoryFloorBytes: 512 * 1024 ** 2,
    diskUsedPercents: [40],
  };

  it('is docs/capacity/after-guards.md’s budget less the owner and one per live bot', () => {
    expect(estimateCapacity(base)).toMatchObject({
      budgetConcurrentCustomers: 75,
      ownerReserved: ESTIMATE_OWNER_RESERVED,
      headroom: 50,
      moreSmallBots: 50,
      moreMediumBots: 16,
      moreLargeBots: 5,
      blockedBy: null,
    });
    expect(estimateCapacity({ ...base, liveHostedBots: 20 }).moreSmallBots).toBe(30);
    // More cores do not raise it (one API process); fewer lower it.
    expect(estimateCapacity({ ...base, cores: 16 }).budgetConcurrentCustomers).toBe(75);
    expect(estimateCapacity({ ...base, cores: 2 }).moreSmallBots).toBe(12);
    expect(estimateCapacity({ ...base, liveHostedBots: 80 }).moreSmallBots).toBe(0);
  });

  it('fits nothing more while memory is under the floor or a disk is at 90 %', () => {
    expect(estimateCapacity({ ...base, availableMemoryBytes: 100 * 1024 ** 2 })).toMatchObject({
      moreSmallBots: 0,
      blockedBy: 'MEMORY',
    });
    expect(estimateCapacity({ ...base, diskUsedPercents: [10, 91] })).toMatchObject({
      moreSmallBots: 0,
      blockedBy: 'DISK',
    });
  });
});
