import { describe, expect, it, vi } from 'vitest';
import type { ActorContext, ListTotal, TenantContext } from '@nexa/contracts';
import { CustomerService } from '../../apps/api/src/modules/commerce/customers/application/customer.service';
import { OrderService } from '../../apps/api/src/modules/commerce/orders/application/order.service';
import { ServiceAdminService } from '../../apps/api/src/modules/commerce/provisioning/application/service-admin.service';
import { DrizzleOrderRepository } from '../../apps/api/src/modules/commerce/orders/infrastructure/drizzle-order.repository';
import { totalWithin } from '../../apps/api/src/modules/commerce/list-total-deadline';

/**
 * The count chip's total is opt-in, first-page-only, and can never fail or hold up the list
 * that asked for it (web redesign PR-10, Opus review).
 */
const scope = { tenantId: '01900000-0000-7000-8000-000000000001' } as unknown as TenantContext;
const actor = { type: 'WEB_ADMIN', id: 'a1' } as unknown as ActorContext;
const guard = { check: vi.fn(async () => undefined) };
const TOTAL: ListTotal = { value: 12, estimated: true };
const page = { items: [], nextCursor: null };

type Case = {
  name: string;
  build: (total: ReturnType<typeof vi.fn>) => {
    list: (extra: {
      withTotal?: boolean;
      cursor?: unknown;
    }) => Promise<{ total: ListTotal | null }>;
    listCalls: ReturnType<typeof vi.fn>;
  };
};

const cases: Case[] = [
  {
    name: 'customers',
    build: (total) => {
      const list = vi.fn(async () => page);
      const svc = new CustomerService({ guard, repository: { list, total } } as never);
      return { list: (extra) => svc.list(scope, actor, extra as never), listCalls: list };
    },
  },
  {
    name: 'orders',
    build: (total) => {
      const list = vi.fn(async () => page);
      const svc = new OrderService({
        guard,
        repository: { list, total, productIdsTitled: vi.fn(async () => []) },
      } as never);
      return {
        list: (extra) => svc.list(scope, actor, { search: {}, ...extra } as never),
        listCalls: list,
      };
    },
  },
  {
    name: 'services',
    build: (total) => {
      const list = vi.fn(async () => page);
      const svc = new ServiceAdminService({ guard, services: { list, total } } as never);
      return {
        list: (extra) => svc.list(scope, actor, { search: {}, ...extra } as never),
        listCalls: list,
      };
    },
  },
];

describe.each(cases)('the $name list total', ({ build }) => {
  it('is not asked for unless the caller opts in (global search, Telegram flows)', async () => {
    const total = vi.fn(async () => TOTAL);
    const { list } = build(total);
    expect((await list({})).total).toBeNull();
    expect(total).not.toHaveBeenCalled();
  });

  it('is returned for an opted-in first page', async () => {
    const total = vi.fn(async () => TOTAL);
    const { list } = build(total);
    expect((await list({ withTotal: true })).total).toEqual(TOTAL);
    expect(total).toHaveBeenCalledTimes(1);
  });

  it('is not computed for a page with a cursor', async () => {
    const total = vi.fn(async () => TOTAL);
    const { list } = build(total);
    const out = await list({ withTotal: true, cursor: { createdAt: 'x', id: 'y' } });
    expect(out.total).toBeNull();
    expect(total).not.toHaveBeenCalled();
  });

  it('never fails the list when the total path rejects or throws', async () => {
    for (const total of [
      vi.fn(async () => {
        throw new Error('boom');
      }),
      vi.fn(() => {
        throw new Error('sync boom');
      }),
    ]) {
      const { list, listCalls } = build(total);
      const out = await list({ withTotal: true });
      expect(out.total).toBeNull();
      expect(listCalls).toHaveBeenCalledTimes(1);
    }
  });
});

describe('the order list total', () => {
  it('resolves the product-name arm once and hands it to the page and the total', async () => {
    const productIdsTitled = vi.fn(async () => ['p1']);
    const list = vi.fn(async () => page);
    const total = vi.fn(async () => TOTAL);
    const svc = new OrderService({ guard, repository: { list, total, productIdsTitled } } as never);
    const text = { kind: 'TEXT', folded: 'gold' };
    await svc.list(scope, actor, { search: { text }, withTotal: true } as never);
    expect(productIdsTitled).toHaveBeenCalledTimes(1);
    expect((list.mock.calls[0] as unknown[])[5]).toEqual(['p1']);
    expect((total.mock.calls[0] as unknown[])[2]).toEqual(['p1']);
  });

  it('survives a repository whose total throws, all the way down to the database', async () => {
    const db = {
      transaction: () => {
        throw new Error('pool gone');
      },
    };
    const repository = new DrizzleOrderRepository(db as never);
    await expect(repository.total(scope, {}, [])).resolves.toBeNull();
  });
});

describe('totalWithin', () => {
  it('gives up with null when the total is slow, and clears its timer', async () => {
    const started = performance.now();
    const out = await totalWithin(() => new Promise<ListTotal>(() => undefined), 30);
    expect(out).toBeNull();
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('returns a total that arrives in time', async () => {
    expect(await totalWithin(async () => TOTAL, 1_000)).toEqual(TOTAL);
  });
});
