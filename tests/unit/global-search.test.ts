import { describe, expect, it, vi } from 'vitest';
import {
  GLOBAL_SEARCH_LIMIT_DEFAULT,
  GLOBAL_SEARCH_LIMIT_MAX,
  globalSearchQuerySchema,
  globalSearchResponseSchema,
  type ActorContext,
  type GlobalSearchKind,
  type PermissionKey,
  type TenantContext,
} from '@nexa/contracts';
import {
  GLOBAL_SEARCH_KIND_PERMISSIONS,
  GlobalSearchService,
  type GlobalSearchSource,
} from '../../apps/api/src/modules/commerce/global-search/application/global-search.service';
import {
  customerHit,
  orderHit,
  serviceHit,
} from '../../apps/api/src/modules/commerce/global-search/application/list-backed-sources';
import type { PermissionGuard } from '../../apps/api/src/modules/platform/access/application/permission-guard';

const scope = { tenantId: 't1', botInstanceId: null } as unknown as TenantContext;
const actor = { type: 'WEB_ADMIN', id: 'a1', surface: 'WEB' } as unknown as ActorContext;

function service(held: readonly PermissionKey[]) {
  const sources = Object.fromEntries(
    (['CUSTOMER', 'ORDER', 'SERVICE', 'PAYMENT', 'TICKET'] as const).map((kind) => [
      kind,
      {
        search: vi.fn(async (_s: unknown, _a: unknown, _t: unknown, limit: number) => ({
          hits: Array.from({ length: limit + 3 }, (_, i) => ({
            id: `${kind}-${i}`,
            title: `${kind} ${i}`,
            subtitle: null,
            state: null,
          })),
          hasMore: true,
        })),
      },
    ]),
  ) as unknown as Record<
    GlobalSearchKind,
    GlobalSearchSource & { search: ReturnType<typeof vi.fn> }
  >;
  const guard = { permissionsOf: vi.fn(async () => new Set(held)) } as unknown as PermissionGuard;
  return { svc: new GlobalSearchService({ guard, sources }), sources };
}

describe('GlobalSearchService', () => {
  it('returns each kind only when the actor holds that kind’s own read permissions', async () => {
    const { svc, sources } = service(['orders.view']);
    const out = await svc.search(scope, actor, { q: 'gold' });
    expect(out.groups.map((g) => g.kind)).toEqual(['ORDER']);
    expect(sources.CUSTOMER.search).not.toHaveBeenCalled();
    expect(sources.SERVICE.search).not.toHaveBeenCalled();
  });

  it('needs users.view AND users.search for customers (either alone is not enough)', async () => {
    for (const held of [['users.view'], ['users.search']] as PermissionKey[][]) {
      const { svc, sources } = service(held);
      const out = await svc.search(scope, actor, { q: 'ali' });
      expect(out.groups).toEqual([]);
      expect(sources.CUSTOMER.search).not.toHaveBeenCalled();
    }
    const { svc } = service(['users.view', 'users.search']);
    expect((await svc.search(scope, actor, { q: 'ali' })).groups.map((g) => g.kind)).toEqual([
      'CUSTOMER',
    ]);
  });

  it('answers nothing, and asks no source, for an actor holding none of the permissions', async () => {
    // Not tickets.view: since R12 F3 item 8 that permission finds tickets.
    const { svc, sources } = service(['settings.view' as PermissionKey]);
    expect(await svc.search(scope, actor, { q: 'ali' })).toEqual({ groups: [] });
    for (const source of Object.values(sources)) expect(source.search).not.toHaveBeenCalled();
  });

  it('returns the kinds in a fixed order and bounds the hits by the limit', async () => {
    const { svc } = service(['users.view', 'users.search', 'orders.view', 'services.view']);
    const out = await svc.search(scope, actor, { q: 'x' });
    expect(out.groups.map((g) => g.kind)).toEqual(['CUSTOMER', 'ORDER', 'SERVICE']);
    for (const group of out.groups) expect(group.hits).toHaveLength(GLOBAL_SEARCH_LIMIT_DEFAULT);
    const big = await svc.search(scope, actor, { q: 'x', limit: 999 });
    for (const group of big.groups) expect(group.hits).toHaveLength(GLOBAL_SEARCH_LIMIT_MAX);
    const small = await svc.search(scope, actor, { q: 'x', limit: 0 });
    for (const group of small.groups) expect(group.hits).toHaveLength(1);
    expect(() => globalSearchResponseSchema.parse(out)).not.toThrow();
  });

  it('treats whitespace as no search and never asks a source', async () => {
    const { svc, sources } = service(['users.view', 'users.search', 'orders.view']);
    expect(await svc.search(scope, actor, { q: '   ' })).toEqual({ groups: [] });
    expect(sources.ORDER.search).not.toHaveBeenCalled();
  });

  it('classifies the string once, exactly as a list q is (a Telegram id is whole, @ is a username)', async () => {
    const { svc, sources } = service(['orders.view']);
    await svc.search(scope, actor, { q: ' 123456789 ' });
    await svc.search(scope, actor, { q: '@Ali' });
    const terms = sources.ORDER.search.mock.calls.map((call) => call[2]);
    expect(terms).toEqual([
      { kind: 'TELEGRAM_ID', value: '123456789' },
      { kind: 'USERNAME', value: 'ali' },
    ]);
  });

  it('table: every kind has permissions, and none is a write permission', () => {
    expect(Object.keys(GLOBAL_SEARCH_KIND_PERMISSIONS).sort()).toEqual([
      'CUSTOMER',
      'ORDER',
      'PAYMENT',
      'SERVICE',
      'TICKET',
    ]);
    // R12 F3 item 8: payments and tickets, each behind its own list's read permission.
    expect(GLOBAL_SEARCH_KIND_PERMISSIONS.PAYMENT).toEqual(['payments.view']);
    expect(GLOBAL_SEARCH_KIND_PERMISSIONS.TICKET).toEqual(['tickets.view']);
    expect(GLOBAL_SEARCH_KIND_PERMISSIONS.CUSTOMER).toEqual(['users.view', 'users.search']);
    expect(GLOBAL_SEARCH_KIND_PERMISSIONS.ORDER).toEqual(['orders.view']);
    expect(GLOBAL_SEARCH_KIND_PERMISSIONS.SERVICE).toEqual(['services.view']);
  });
});

describe('the query and the hits', () => {
  it('bounds q and limit', () => {
    expect(globalSearchQuerySchema.safeParse({ q: '' }).success).toBe(false);
    expect(globalSearchQuerySchema.safeParse({ q: 'x'.repeat(65) }).success).toBe(false);
    expect(globalSearchQuerySchema.safeParse({ q: 'a', limit: '11' }).success).toBe(false);
    expect(globalSearchQuerySchema.parse({ q: ' a ', limit: '7' })).toEqual({ q: 'a', limit: 7 });
    expect(globalSearchQuerySchema.safeParse({ q: 'a', tenantId: 'other' }).success).toBe(false);
  });

  it('names a customer, an order and a service without ever showing a uuid or a credential', () => {
    const customer = customerHit({
      id: 'c1',
      telegramUserId: '111',
      username: 'ali',
      firstName: 'Ali',
      lastName: 'Rezaei',
      status: 'ACTIVE',
    } as never);
    expect(customer).toEqual({
      id: 'c1',
      title: 'Ali Rezaei',
      subtitle: '@ali · 111',
      state: 'ACTIVE',
    });
    expect(
      customerHit({
        id: 'c2',
        telegramUserId: '222',
        username: null,
        firstName: null,
        lastName: null,
        status: 'BLOCKED',
      } as never).title,
    ).toBe('222');
    expect(
      orderHit({ id: 'o1', code: 'ABCD2345', line: { title: 'Gold' }, state: 'PAID' } as never),
    ).toEqual({
      id: 'o1',
      title: 'ABCD2345',
      subtitle: 'Gold',
      state: 'PAID',
    });
    const service = serviceHit({
      id: 's1',
      code: null,
      providerUsername: 'nxali1',
      state: 'ACTIVE',
      subscriptionRef: 'SECRET',
      providerClientId: 'SECRET',
      subscriptionUrl: 'https://sub/SECRET',
    } as never);
    expect(service).toEqual({ id: 's1', title: 'nxali1', subtitle: null, state: 'ACTIVE' });
    expect(JSON.stringify(service)).not.toContain('SECRET');
  });
});
