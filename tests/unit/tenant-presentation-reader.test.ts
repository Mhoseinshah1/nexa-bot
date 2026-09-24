import { describe, expect, it } from 'vitest';
import { asId, type ScopeContext, type SystemContext, type Tenant } from '@nexa/contracts';
import { DEFAULT_TEMPLATE_PRESENTATION } from '@nexa/i18n';
import { FixedClock } from '../../apps/api/src/infrastructure/clock';
import {
  CachedTenantPresentationReader,
  PRESENTATION_CACHE_TTL_MS,
} from '../../apps/api/src/modules/control/templates/infrastructure/cached-tenant-presentation.reader';

/**
 * The tenant's zone and calendar, read once a minute per tenant, by the injected clock.
 */

const TENANT_A = asId<'TenantId'>('019210ab-cdef-7012-8345-6789abcdef01');
const TENANT_B = asId<'TenantId'>('019210ab-cdef-7012-8345-6789abcdef02');

const scopeA: ScopeContext = { tenantId: TENANT_A, botInstanceId: null };
const scopeB: ScopeContext = { tenantId: TENANT_B, botInstanceId: null };
const system: SystemContext = { kind: 'SYSTEM', reason: 'test' };

function tenantRow(id: Tenant['id'], displayTimezone: string, calendar: Tenant['calendar']) {
  return { id, displayTimezone, calendar } as unknown as Tenant;
}

function harness() {
  const rows = new Map<string, Tenant>([
    [TENANT_A, tenantRow(TENANT_A, 'Asia/Tehran', 'jalali')],
    [TENANT_B, tenantRow(TENANT_B, 'Europe/Berlin', 'gregorian')],
  ]);
  let reads = 0;
  const clock = new FixedClock(new Date('2026-09-24T18:30:00Z'));
  const reader = new CachedTenantPresentationReader(
    {
      findById: async (id) => {
        reads += 1;
        return rows.get(id) ?? null;
      },
    },
    clock,
  );
  return { reader, clock, rows, reads: () => reads };
}

describe('CachedTenantPresentationReader', () => {
  it('answers a tenant scope from the tenant row', async () => {
    const h = harness();
    expect(await h.reader.presentationFor(scopeA)).toEqual({
      timezone: 'Asia/Tehran',
      calendar: 'jalali',
    });
    expect(await h.reader.presentationFor(scopeB)).toEqual({
      timezone: 'Europe/Berlin',
      calendar: 'gregorian',
    });
  });

  it('answers a system scope with the one declared default, without a read', async () => {
    const h = harness();
    expect(await h.reader.presentationFor(system)).toBe(DEFAULT_TEMPLATE_PRESENTATION);
    expect(h.reads()).toBe(0);
  });

  it('reads each tenant once within the cache window', async () => {
    const h = harness();
    await h.reader.presentationFor(scopeA);
    await h.reader.presentationFor(scopeA);
    await h.reader.presentationFor(scopeB);
    h.clock.advanceMs(PRESENTATION_CACHE_TTL_MS - 1);
    await h.reader.presentationFor(scopeA);
    expect(h.reads()).toBe(2);
  });

  it('reads again once the window has passed, by the injected clock', async () => {
    const h = harness();
    await h.reader.presentationFor(scopeA);
    h.rows.set(TENANT_A, tenantRow(TENANT_A, 'Asia/Dubai', 'gregorian'));
    // Still the cached answer: the bound is the whole point of the cache.
    expect((await h.reader.presentationFor(scopeA)).timezone).toBe('Asia/Tehran');
    h.clock.advanceMs(PRESENTATION_CACHE_TTL_MS);
    expect(await h.reader.presentationFor(scopeA)).toEqual({
      timezone: 'Asia/Dubai',
      calendar: 'gregorian',
    });
    expect(h.reads()).toBe(2);
  });

  it('keeps the two tenants apart in the cache', async () => {
    const h = harness();
    await h.reader.presentationFor(scopeA);
    expect((await h.reader.presentationFor(scopeB)).calendar).toBe('gregorian');
    expect((await h.reader.presentationFor(scopeA)).calendar).toBe('jalali');
  });

  it('falls back to the default for a tenant that is not there, and does not remember the miss', async () => {
    const h = harness();
    const missing: ScopeContext = {
      tenantId: asId<'TenantId'>('019210ab-cdef-7012-8345-6789abcdef03'),
      botInstanceId: null,
    };
    expect(await h.reader.presentationFor(missing)).toBe(DEFAULT_TEMPLATE_PRESENTATION);
    h.rows.set(missing.tenantId, tenantRow(missing.tenantId, 'UTC', 'gregorian'));
    expect((await h.reader.presentationFor(missing)).timezone).toBe('UTC');
    expect(h.reads()).toBe(2);
  });
});
