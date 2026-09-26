import { describe, expect, it } from 'vitest';
import {
  claimedBotId,
  commandMenuState,
  readinessOf,
  webhookSecretState,
} from '../../apps/api/src/modules/platform/tenancy/domain/bot-readiness';

/**
 * The recorded-state rules of WP13's bot view (`docs/wp13-bots-management-audit.md` D5).
 * Pure, so every branch is pinned here rather than inferred from a fixture.
 */
const registered = new Date('2026-09-01T00:00:00Z');
const base = {
  webhookRouteEnabled: true,
  tenantActive: true,
  botStatus: 'ACTIVE' as const,
  webhookRegisteredAt: registered,
  secret: 'MATCHES' as const,
};

describe('bot readiness', () => {
  it('is REGISTERED only with everything in place, and never claims more', () => {
    expect(readinessOf(base)).toEqual({ state: 'REGISTERED', causes: [] });
  });

  it('holds a bot for the route, the tenant or the bot, in the bootstrap order', () => {
    expect(
      readinessOf({
        ...base,
        webhookRouteEnabled: false,
        tenantActive: false,
        botStatus: 'STOPPED',
      }),
    ).toEqual({
      state: 'HELD',
      causes: ['WEBHOOK_ROUTE_DISABLED', 'TENANT_INACTIVE', 'BOT_NOT_ACTIVE'],
    });
    // A missing secret makes the route unusable, whatever was registered.
    expect(readinessOf({ ...base, secret: 'NOT_CONFIGURED' }).causes).toEqual([
      'WEBHOOK_ROUTE_DISABLED',
    ]);
  });

  it('reports every cause at once, so fixing one does not reveal a surprise', () => {
    expect(readinessOf({ ...base, botStatus: 'STOPPED', webhookRegisteredAt: null })).toEqual({
      state: 'HELD',
      causes: ['BOT_NOT_ACTIVE', 'WEBHOOK_NEVER_REGISTERED'],
    });
  });

  it('separates a never-registered webhook from a changed or unknown secret', () => {
    expect(readinessOf({ ...base, webhookRegisteredAt: null }).causes).toEqual([
      'WEBHOOK_NEVER_REGISTERED',
    ]);
    expect(readinessOf({ ...base, secret: 'DIFFERS' })).toEqual({
      state: 'NOT_REGISTERED',
      causes: ['WEBHOOK_SECRET_CHANGED'],
    });
    expect(readinessOf({ ...base, secret: 'UNKNOWN' }).causes).toEqual(['WEBHOOK_SECRET_UNKNOWN']);
  });
});

describe('the comparisons behind it', () => {
  it('never reads an unknown fingerprint as a match', () => {
    expect(webhookSecretState(null, true)).toBe('UNKNOWN');
    expect(webhookSecretState(true, true)).toBe('MATCHES');
    expect(webhookSecretState(false, true)).toBe('DIFFERS');
    expect(webhookSecretState(true, false)).toBe('NOT_CONFIGURED');
  });

  it('never reads an unknown menu revision as current', () => {
    expect(commandMenuState(null, 'r1')).toBe('UNKNOWN');
    expect(commandMenuState('r1', 'r1')).toBe('CURRENT');
    expect(commandMenuState('r0', 'r1')).toBe('STALE');
  });
});

describe("a token's claimed bot id", () => {
  it('is the digits before the colon of a well-formed token', () => {
    expect(claimedBotId(`7000000001:${'A'.repeat(35)}`)).toBe('7000000001');
    expect(claimedBotId(`7000000001:AAH-_${'b'.repeat(30)}`)).toBe('7000000001');
  });

  it('refuses anything else rather than trimming it into shape', () => {
    for (const candidate of [
      '',
      'not a token',
      ` 7000000001:${'A'.repeat(35)}`,
      `7000000001:${'A'.repeat(35)} `,
      `7000000001:${'A'.repeat(10)}`,
      `07000000001:${'A'.repeat(35)}`,
      `7000000001:${'A'.repeat(20)}:${'A'.repeat(20)}`,
      `abc:${'A'.repeat(35)}`,
    ]) {
      expect(claimedBotId(candidate), candidate).toBeNull();
    }
  });
});
