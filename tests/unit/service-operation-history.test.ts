import { describe, expect, it } from 'vitest';
import type { ActorContext, TenantContext } from '@nexa/contracts';
import {
  SERVICE_OPERATION_LIMIT,
  ServiceAdminService,
  type ServiceAdminServiceDeps,
} from '../../apps/api/src/modules/commerce/provisioning/application/service-admin.service.js';
import type {
  OperationRecord,
  ServiceRecord,
} from '../../apps/api/src/modules/commerce/provisioning/application/ports.js';

/**
 * The history bound, asked of the one place that knows it.
 *
 * Both surfaces print whether a service's operation history was CUT, and both take that
 * from the response rather than from a constant of their own. The rule that makes the
 * answer true is one line in `operations`: it asks the repository for `limit + 1` rows
 * and returns at most `limit`, so the extra row — never shown — is what distinguishes
 * "these are all of them" from "these are the newest of more". `length === limit` is
 * the wrong test and is the reason `hasMore` exists at all: a service with exactly the
 * bound has a full page and nothing behind it.
 *
 * A unit test rather than an integration one, deliberately. Proving this against a real
 * database means a service with fifty-one operations, which means fifty-one provider
 * round trips or fifty-one hand-written rows — and the rule under test is arithmetic,
 * not SQL. What IS SQL, the newest-first ordering, is proved in
 * `services-http.test.ts`; the repository here is a fake whose only job is to report
 * how many rows it was asked for.
 */

const scope: TenantContext = { tenantId: 'tenant' as never, botInstanceId: null };
const actor: ActorContext = {
  type: 'SYSTEM_JOB',
  id: null,
  label: 'test',
  surface: 'TELEGRAM',
  correlationId: 'c' as never,
};

/*
 * A real UUIDv7, because `get` runs every id through `serviceIdOrNotFound` before the
 * repository is reached — the shape that turns a malformed id into `SERVICE_NOT_FOUND`
 * rather than a 500 at the cast. A fake repository does not exempt the caller from it.
 */
const SERVICE_ID = '019250ab-cdef-7012-8345-6789abcdef01';
const service = { id: SERVICE_ID } as ServiceRecord;

/** One operation row, only as much of it as `operations` ever touches. */
const operation = (index: number): OperationRecord => ({ id: `op-${String(index)}` }) as never;

/**
 * A service admin service over a fake repository.
 *
 * `available` is how many operations the service HAS; `asked` records the bound the
 * caller passed, which is the other half of the rule — a version that asked for exactly
 * `SERVICE_OPERATION_LIMIT` could never answer `hasMore` truthfully no matter what it
 * did with the rows afterwards.
 */
function build(available: number): {
  readonly admin: ServiceAdminService;
  readonly asked: () => number | undefined;
} {
  let asked: number | undefined;
  const deps = {
    services: {
      findById: async () => service,
    },
    operations: {
      listRecentForService: async (_scope: unknown, _id: string, limit: number) => {
        asked = limit;
        return Array.from({ length: Math.min(available, limit) }, (_, index) => operation(index));
      },
    },
    guard: { check: async () => undefined },
    panels: {},
    contacts: {},
  } as unknown as ServiceAdminServiceDeps;
  return { admin: new ServiceAdminService(deps), asked: () => asked };
}

describe('a service operation history', () => {
  it('asks for one row beyond its bound, and never returns it', async () => {
    const { admin, asked } = build(SERVICE_OPERATION_LIMIT + 10);
    const history = await admin.operations(scope, actor, service.id);

    expect(asked(), 'the extra row is what answers hasMore').toBe(SERVICE_OPERATION_LIMIT + 1);
    expect(history.operations).toHaveLength(SERVICE_OPERATION_LIMIT);
    expect(history.limit).toBe(SERVICE_OPERATION_LIMIT);
    expect(history.hasMore).toBe(true);
  });

  it('reports a history of EXACTLY the bound as complete', async () => {
    /*
     * The case `length === limit` gets wrong, and the reason the extra row exists. A
     * surface told `hasMore` here sends an operator looking for rows that do not exist.
     */
    const { admin } = build(SERVICE_OPERATION_LIMIT);
    const history = await admin.operations(scope, actor, service.id);

    expect(history.operations).toHaveLength(SERVICE_OPERATION_LIMIT);
    expect(history.hasMore, 'a full page is not a truncated one').toBe(false);
  });

  it('reports a short history as complete, with its real length', async () => {
    const { admin } = build(3);
    const history = await admin.operations(scope, actor, service.id);

    expect(history.operations).toHaveLength(3);
    expect(history.hasMore).toBe(false);
    /* The bound is still the SERVER's, and is reported even when it did not bite. */
    expect(history.limit).toBe(SERVICE_OPERATION_LIMIT);
  });
});
