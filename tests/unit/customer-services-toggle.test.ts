import { describe, expect, it } from 'vitest';
import {
  COMMERCE_ERROR_CODES,
  PLATFORM_ERROR_CODES,
  errors,
  type ActorContext,
  type CorrelationId,
  type PermissionKey,
  type TenantContext,
} from '@nexa/contracts';
import { CustomerServicesToggleService } from '../../apps/api/src/modules/commerce/provisioning/application/customer-services-toggle.service';

/**
 * Customer 360's enable/disable-all-configurations command, against fakes (Codex review of
 * #146): every service is processed however many there are, `services.view` is required,
 * the command's key is claimed before anything is planned, and only per-service refusals
 * are reported beside a service — a command-level refusal propagates.
 */

const SCOPE: TenantContext = {
  tenantId: '01900000-0000-7000-8000-000000000001' as never,
  botInstanceId: null,
};
const ACTOR: ActorContext = {
  type: 'WEB_ADMIN',
  id: 'admin',
  label: 'admin',
  surface: 'WEB',
  correlationId: 'c' as CorrelationId,
};
const CUSTOMER = '019210ab-cdef-7012-8345-6789abcdef01';
const OTHER = '019210ab-cdef-7012-8345-6789abcdef02';

function harness(options: {
  services: number;
  permissions?: readonly string[];
  refuse?: (serviceId: string, call: number) => Error | null;
}) {
  const permissions = new Set(
    options.permissions ?? ['users.view', 'services.view', 'services.edit'],
  );
  const memory = new Map<string, { hash: string; result: unknown }>();
  const planned: string[] = [];
  const audits: { action: string; result: string }[] = [];
  const all = Array.from({ length: options.services }, (_, index) => ({
    id: `svc-${String(index).padStart(4, '0')}`,
    providerUsername: `nx${String(index)}`,
  }));
  let call = 0;
  const service = new CustomerServicesToggleService({
    services: {
      list: async (_scope: unknown, _search: unknown, limit: number, cursor: unknown) => {
        const start = cursor === null ? 0 : Number(cursor);
        const items = all.slice(start, start + limit);
        const next = start + limit < all.length ? String(start + limit) : null;
        return { items, nextCursor: next } as never;
      },
    },
    provisioning: {
      requestFromOperator: async (_scope: unknown, _actor: unknown, serviceId: string) => {
        call += 1;
        const refusal = options.refuse?.(serviceId, call) ?? null;
        if (refusal !== null) throw refusal;
        planned.push(serviceId);
        return {} as never;
      },
    },
    guard: {
      check: async (_scope: unknown, _actor: unknown, permission: PermissionKey) => {
        if (!permissions.has(permission)) {
          throw errors.permissionDenied(PLATFORM_ERROR_CODES.PERMISSION_DENIED, permission);
        }
      },
    } as never,
    audit: {
      record: async (
        _scope: unknown,
        _actor: unknown,
        entry: { action: string; result: string },
      ) => {
        audits.push({ action: entry.action, result: entry.result });
      },
    } as never,
    uow: {
      run: async (_scope: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
    } as never,
    idempotency: {
      find: async (_scope: unknown, ns: string, key: string, hash: string) => {
        const held = memory.get(`${ns}:${key}`);
        if (held === undefined) return null;
        if (held.hash !== hash) {
          throw errors.conflict(PLATFORM_ERROR_CODES.IDEMPOTENCY_PAYLOAD_MISMATCH, 'mismatch');
        }
        return { result: held.result } as never;
      },
      remember: async (_scope: unknown, ns: string, key: string, hash: string, result: unknown) => {
        if (memory.has(`${ns}:${key}`)) return false;
        memory.set(`${ns}:${key}`, { hash, result });
        return true;
      },
    } as never,
  });
  const toggle = (customerId = CUSTOMER, idempotencyKey = 'toggle-key-1') =>
    service.toggle(SCOPE, ACTOR, { idempotencyKey, customerId, action: 'SUSPEND' });
  return { toggle, planned, audits };
}

describe('CustomerServicesToggleService', () => {
  it('plans every service, past any single page, and says so for each', async () => {
    const h = harness({ services: 523 });
    const results = await h.toggle();
    expect(results).toHaveLength(523);
    expect(h.planned).toHaveLength(523);
    expect(results.every((result) => result.outcome === 'PLANNED')).toBe(true);
  });

  it('requires services.view before it lists a service', async () => {
    const h = harness({ services: 3, permissions: ['users.view', 'services.edit'] });
    await expect(h.toggle()).rejects.toMatchObject({
      code: PLATFORM_ERROR_CODES.PERMISSION_DENIED,
    });
    expect(h.planned).toHaveLength(0);
  });

  it('refuses the same key for another customer before planning anything', async () => {
    const h = harness({ services: 3 });
    await h.toggle(CUSTOMER, 'shared-key');
    expect(h.planned).toHaveLength(3);
    await expect(h.toggle(OTHER, 'shared-key')).rejects.toMatchObject({
      code: PLATFORM_ERROR_CODES.IDEMPOTENCY_PAYLOAD_MISMATCH,
    });
    expect(h.planned).toHaveLength(3);
  });

  it('reports a per-service refusal beside it, and keeps going', async () => {
    const h = harness({
      services: 3,
      refuse: (id) =>
        id === 'svc-0001'
          ? errors.conflict(COMMERCE_ERROR_CODES.PANEL_NOT_OPERABLE, 'cannot suspend')
          : null,
    });
    const results = await h.toggle();
    expect(results.map((result) => result.outcome)).toEqual(['PLANNED', 'REFUSED', 'PLANNED']);
    expect(results[1]?.code).toBe(COMMERCE_ERROR_CODES.PANEL_NOT_OPERABLE);
  });

  it('propagates a command-level refusal instead of reporting the run as a success', async () => {
    const h = harness({
      services: 3,
      refuse: (_id, call) =>
        call === 2
          ? errors.permissionDenied(PLATFORM_ERROR_CODES.PERMISSION_DENIED, 'revoked')
          : null,
    });
    await expect(h.toggle()).rejects.toMatchObject({
      code: PLATFORM_ERROR_CODES.PERMISSION_DENIED,
    });
    expect(h.audits.map((audit) => audit.result)).toEqual(['FAILED']);
  });
});
