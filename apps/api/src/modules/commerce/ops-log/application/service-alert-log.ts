import type { Clock, ServiceReminderKind, TenantContext } from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import { publish } from './publish.js';
import { serviceAlert } from './presenters.js';
import type { OpsLogFacts, OpsLogLane, OpsLogWords } from './ports.js';

/** What the reminder sweep calls when it has told a customer about one service. */
export interface ServiceAlertHook {
  serviceAlerted(
    scope: TenantContext,
    input: {
      readonly reminderId: string;
      readonly serviceId: string;
      readonly kind: ServiceReminderKind;
      readonly remainingDays: number | null;
    },
    tx: TransactionScope,
  ): Promise<void>;
}

/**
 * L21: ONE message per service, like the previous bot — never a digest. The owner decided
 * the group wants to see each service that ran low on volume or time, with the customer, its
 * state, what is left and when it last connected; the customer's own notification is
 * unchanged.
 *
 * Posted when the customer was actually told (the reminder row is written once per service
 * and kind), so a sweep that finds the same service again says nothing twice. Remaining
 * traffic is `0 بایت`, never negative and never NaN.
 *
 * R10 B5 (the v0.8.2-e rule): the REMINDER is the alert's provenance, and only the sweep
 * writes one, after it told the customer — never the import. A threshold an imported service
 * had already crossed when it was imported is the sweep's import baseline
 * (`service_reminder_baselines`): the customer is not told, so this is never called for it.
 * A threshold crossed after the import is told to the customer like any other, so neither the
 * service's nor the customer's `MIRZA` source is a reason for silence here.
 */
export class ServiceAlertLog implements ServiceAlertHook {
  constructor(
    private readonly deps: {
      readonly lane: OpsLogLane;
      readonly facts: OpsLogFacts;
      readonly words: OpsLogWords;
      readonly clock: Clock;
    },
  ) {}

  async serviceAlerted(
    scope: TenantContext,
    input: {
      readonly reminderId: string;
      readonly serviceId: string;
      readonly kind: ServiceReminderKind;
      readonly remainingDays: number | null;
    },
    tx: TransactionScope,
  ): Promise<void> {
    const service = await this.deps.facts.service(scope, input.serviceId, tx);
    if (service === null) return;
    const customer = await this.deps.facts.customer(scope, service.customerId, tx);
    if (customer === null) return;
    const built = serviceAlert({
      kind: input.kind,
      service,
      customer,
      remainingDays: input.remainingDays,
      at: this.deps.clock.now(),
      words: this.deps.words,
    });
    await publish(this.deps.lane, scope, tx, built, {
      dedupeKey: `oplog:alert:${input.reminderId}`,
    });
  }
}
