import { describe, expect, it } from 'vitest';
import {
  developmentExposureWarnings,
  isPublicLookingOrigin,
  publicExposureSignals,
  systemEndpointEnabled,
} from '../../apps/api/src/infrastructure/config/exposure';

/**
 * FIX-04 (S2): the gate on the unauthenticated development endpoint, and the warning a
 * development process gives when its configuration looks public.
 */

const LOCAL = {
  NODE_ENV: 'development' as const,
  WEB_ADMIN_ORIGINS: [] as string[],
  DEPLOYMENT_TOPOLOGY: 'direct' as const,
  TELEGRAM_WEBHOOK_ENABLED: false,
  DEV_SYSTEM_ENDPOINT_ENABLED: false,
};

describe('systemEndpointEnabled', () => {
  it('needs the opt-in AND a development or test NODE_ENV', () => {
    expect(
      systemEndpointEnabled({ NODE_ENV: 'development', DEV_SYSTEM_ENDPOINT_ENABLED: false }),
    ).toBe(false);
    expect(systemEndpointEnabled({ NODE_ENV: 'test', DEV_SYSTEM_ENDPOINT_ENABLED: false })).toBe(
      false,
    );
    expect(
      systemEndpointEnabled({ NODE_ENV: 'production', DEV_SYSTEM_ENDPOINT_ENABLED: true }),
    ).toBe(false);
    expect(
      systemEndpointEnabled({ NODE_ENV: 'development', DEV_SYSTEM_ENDPOINT_ENABLED: true }),
    ).toBe(true);
    expect(systemEndpointEnabled({ NODE_ENV: 'test', DEV_SYSTEM_ENDPOINT_ENABLED: true })).toBe(
      true,
    );
  });
});

describe('isPublicLookingOrigin', () => {
  it.each([
    ['https://bot.shop.example.com', true],
    ['https://stage.bot.example-shop.com', true],
    ['https://admin.shop.ir', true],
    ['https://203.0.113.10', true],
    ['https://[2001:db8::1]', true],
    ['http://localhost:5173', false],
    ['http://app.localhost', false],
    ['http://127.0.0.1:3000', false],
    ['http://[::1]:3000', false],
    ['http://192.168.1.20', false],
    ['http://10.0.0.5', false],
    ['http://172.20.0.2', false],
    ['https://admin.test', false],
    ['http://nexa', false],
    ['not a url', true],
  ])('%s → %s', (origin, expected) => {
    expect(isPublicLookingOrigin(origin)).toBe(expected);
  });
});

describe('developmentExposureWarnings', () => {
  it('is silent on a local development configuration and in production', () => {
    expect(developmentExposureWarnings(LOCAL)).toEqual([]);
    expect(
      developmentExposureWarnings({
        ...LOCAL,
        NODE_ENV: 'production',
        WEB_ADMIN_ORIGINS: ['https://admin.shop.ir'],
        DEPLOYMENT_TOPOLOGY: 'reverse-proxy',
      }),
    ).toEqual([]);
  });

  it.each([
    [{ WEB_ADMIN_ORIGINS: ['https://admin.shop.ir'] }, 'WEB_ADMIN_ORIGINS'],
    [{ DEPLOYMENT_TOPOLOGY: 'reverse-proxy' as const }, 'reverse-proxy'],
    [{ TELEGRAM_WEBHOOK_ENABLED: true }, 'TELEGRAM_WEBHOOK_ENABLED'],
  ])('warns on development with a public signal (%o)', (override, named) => {
    const warnings = developmentExposureWarnings({ ...LOCAL, ...override });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(named);
    expect(warnings[0]).toContain('without Secure');
  });

  it('leaves the webhook out of the signals the refusal reads', () => {
    expect(
      publicExposureSignals({ ...LOCAL, TELEGRAM_WEBHOOK_ENABLED: true }, { webhook: false }),
    ).toEqual([]);
  });
});
