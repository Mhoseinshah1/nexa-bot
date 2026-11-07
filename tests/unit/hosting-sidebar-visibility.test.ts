import { describe, expect, it } from 'vitest';
import type { PermissionKey } from '@nexa/contracts';
import { withoutForeignHostingPermission } from '../../apps/api/src/modules/platform/hosting/application/hosting-owner-guard';

/**
 * Phase 6A PR-3: the «میزبانی‌ها» sidebar entry is drawn for the installation owner only.
 * A hosted (or reseller) bot's owner holds EVERY key in their own tenant, `hosting.manage`
 * included, so the session's chrome list drops it for anyone but the installation tenant's
 * `owner`. Chrome only: the server's `HostingOwnerGuard` refuses every hosting route anyway.
 *
 * Mutation check: return `[...permissions]` unconditionally and the hosted-owner and the
 * delegated-operator cases fail.
 */
const INSTALLATION = '0190a1b2-0000-7000-8000-000000000001';
const HOSTED = '0190a1b2-0000-7000-8000-000000000002';
const ALL = ['hosting.manage', 'admins.view'] as unknown as PermissionKey[];

describe('withoutForeignHostingPermission', () => {
  it('keeps the key for the installation tenant’s owner (case-insensitive id)', () => {
    expect(
      withoutForeignHostingPermission(ALL, {
        tenantId: INSTALLATION.toUpperCase(),
        roleKeys: ['owner'],
        installationTenantId: INSTALLATION,
      }),
    ).toEqual(ALL);
  });

  it('drops it for a hosted bot’s own owner, who holds every key in their tenant', () => {
    expect(
      withoutForeignHostingPermission(ALL, {
        tenantId: HOSTED,
        roleKeys: ['owner'],
        installationTenantId: INSTALLATION,
      }),
    ).toEqual(['admins.view']);
  });

  it('drops it for an installation operator handed the key, and when no tenant is resolved', () => {
    expect(
      withoutForeignHostingPermission(ALL, {
        tenantId: INSTALLATION,
        roleKeys: ['operator'],
        installationTenantId: INSTALLATION,
      }),
    ).toEqual(['admins.view']);
    expect(
      withoutForeignHostingPermission(ALL, {
        tenantId: INSTALLATION,
        roleKeys: ['owner'],
        installationTenantId: null,
      }),
    ).toEqual(['admins.view']);
  });
});
