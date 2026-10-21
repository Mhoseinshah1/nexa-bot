import { describe, expect, it } from 'vitest';
import { OPERATION_TYPES, type TenantContext } from '@nexa/contracts';
import { ProvisionerLoop } from '../../apps/api/src/modules/commerce/provisioning/application/provisioner-loop';
import { ProvisionerService } from '../../apps/api/src/modules/commerce/provisioning/application/provisioner.service';
import type { ExecutionResult } from '../../apps/api/src/modules/commerce/provisioning/application/provision-executor';
import type { DeliveryService } from '../../apps/api/src/modules/commerce/provisioning/application/delivery.service';
import type { OperationOutcomeAnnouncer } from '../../apps/api/src/modules/commerce/messaging/application/operation-outcome-announcer';

/**
 * R5C-2 C3 — every `provisioning attempted` / `provisioning refused` line names the operation
 * TYPE. Before this, 350 harmless usage syncs a day read as 350 account creations, because the
 * line carried an operation id and nothing that said what the operation was.
 *
 * MUTATION: dropping `operationType` from `refusal()` or `attempted()` fails the first test;
 * dropping the loop's spread of the result fails the second.
 */
const scope = { tenantId: 'tenant-1', botInstanceId: null } as unknown as TenantContext;

/** The two private constructors of an `ExecutionResult`, called without a database. */
const service = Object.create(ProvisionerService.prototype) as unknown as {
  refusal(operation: unknown, reason: string, terminal: boolean): ExecutionResult;
  attempted(
    operation: unknown,
    serviceId: string,
    outcome: string,
    failureKind: string | null,
  ): ExecutionResult;
};

const operationOf = (type: string) => ({
  id: `op-${type}`,
  type,
  serviceId: 'svc-1',
  orderId: null,
  panelId: 'panel-1',
  attempts: 1,
});

describe('the result of an operation carries its type', () => {
  it.each(OPERATION_TYPES)('%s: in a refusal and in an attempt', (type) => {
    const refused = service.refusal(operationOf(type), 'TENANT_STOPPED', false);
    const attempted = service.attempted(operationOf(type), 'svc-1', 'SUCCEEDED', null);
    expect(refused).toMatchObject({ kind: 'REFUSED', operationType: type });
    expect(attempted).toMatchObject({ kind: 'ATTEMPTED', operationType: type });
  });
});

describe('the provisioner loop logs the type on every line', () => {
  it('a usage sync is not logged as a creation: PROVISION and SYNC_USAGE are told apart', async () => {
    const lines: { context: Record<string, unknown>; message: string }[] = [];
    const results: ExecutionResult[] = [
      service.attempted(operationOf('SYNC_USAGE'), 'svc-1', 'SUCCEEDED', null),
      service.attempted(operationOf('PROVISION'), 'svc-2', 'SUCCEEDED', null),
      service.refusal(operationOf('RENEW'), 'TENANT_STOPPED', false),
    ];
    let call = 0;
    const loop = new ProvisionerLoop(
      { runOnce: async () => results[call++] ?? { kind: 'IDLE' } } as unknown as ProvisionerService,
      { deliverDue: async () => undefined } as unknown as DeliveryService,
      {
        announce: async () => undefined,
        announceDue: async () => undefined,
      } as unknown as OperationOutcomeAnnouncer,
      {
        scope: () => scope,
        cashback: { settleDue: async () => 0 },
        referrals: { settleDue: async () => 0 },
        serviceRefunds: { settleDue: async () => 0 },
        tickMs: 60_000,
        now: () => 0,
        logger: {
          info: (context, message) => lines.push({ context, message }),
          error: () => undefined,
        },
      },
    );
    await loop.tick();
    const operations = lines.filter(
      (line) =>
        line.message === 'provisioning attempted' || line.message === 'provisioning refused',
    );
    expect(operations.map((line) => [line.message, line.context['operationType']])).toEqual([
      ['provisioning attempted', 'SYNC_USAGE'],
      ['provisioning attempted', 'PROVISION'],
      ['provisioning refused', 'RENEW'],
    ]);
  });
});
