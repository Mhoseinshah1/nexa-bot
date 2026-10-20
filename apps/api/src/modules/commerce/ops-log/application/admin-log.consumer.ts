import { EVENT_PAYLOAD_SCHEMAS, type DomainEvent, type EventType } from '@nexa/contracts';
import type { EventConsumer } from '../../../platform/eventing/application/event-consumer.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import { isAdminActor, publish, scopeOf } from './publish.js';
import { adminChanged } from './presenters.js';
import type { OpsLogFacts, OpsLogLane, OpsLogWords } from './ports.js';

/**
 * L19, in the SECURITY topic: an administrator was added, had their roles changed, or was
 * switched off or on — who, which roles before and after, how many permissions those grant,
 * and who did it. It replaces the generic operational event the same fact used to produce
 * (an English code and a column of ids).
 *
 * A CONSUMER of the identity module's own events, so it runs AFTER the change — possibly
 * after a later one too. The roles it prints are therefore the ones the EVENT carries (the
 * sets under the change's own lock, Codex review of #301), never the roles as they stand when
 * the consumer runs; only an event written before those fields falls back to the current
 * roles, with its additions taken away and its removals put back for "before".
 */
export class AdminLogConsumer implements EventConsumer {
  readonly name = 'ops-log.admins';
  readonly subscribesTo: readonly EventType[] = [
    'AdminCreated',
    'AdminRolesChanged',
    'AdminStatusChanged',
  ];

  constructor(
    private readonly deps: {
      readonly lane: OpsLogLane;
      readonly facts: OpsLogFacts;
      readonly words: OpsLogWords;
    },
  ) {}

  async handle(event: DomainEvent, tx: TransactionScope): Promise<void> {
    const scope = scopeOf(event);
    if (scope === null) return;
    const target = await this.deps.facts.admin(scope, event.aggregateId, tx);
    if (target === null) return;
    const actor =
      isAdminActor(event.actor.type) && event.actor.id !== null && event.actor.id !== target.id
        ? await this.deps.facts.admin(scope, event.actor.id, tx)
        : isAdminActor(event.actor.type) && event.actor.id === target.id
          ? target
          : null;
    const at = new Date(event.occurredAt);

    // The roles as of the event, when it carries them: names and the permissions they grant.
    const asOf = async (keys: readonly string[] | undefined) => {
      if (keys === undefined) return undefined;
      const names = await this.deps.facts.roleNames(scope, keys, tx);
      return {
        roleNames: [...keys].map((key) => names.get(key) ?? key).sort((a, b) => a.localeCompare(b)),
        permissionCount: await this.deps.facts.permissionCountOf(scope, keys, tx),
      };
    };

    let built;
    if (event.eventType === 'AdminCreated') {
      const payload = EVENT_PAYLOAD_SCHEMAS.AdminCreated.parse(event.payload);
      built = adminChanged({
        kind: 'created',
        target,
        rolesBefore: null,
        asOfEvent: await asOf(payload.roleKeys),
        actor,
        at,
        words: this.deps.words,
      });
    } else if (event.eventType === 'AdminRolesChanged') {
      const payload = EVENT_PAYLOAD_SCHEMAS.AdminRolesChanged.parse(event.payload);
      const beforeKeys = payload.before ?? [
        ...target.roleKeys.filter((key) => !payload.added.includes(key)),
        ...payload.removed,
      ];
      const names = await this.deps.facts.roleNames(scope, beforeKeys, tx);
      built = adminChanged({
        kind: 'rolesChanged',
        target,
        rolesBefore: beforeKeys.map((key) => names.get(key) ?? key),
        asOfEvent: await asOf(payload.after),
        actor,
        at,
        words: this.deps.words,
      });
    } else {
      const payload = EVENT_PAYLOAD_SCHEMAS.AdminStatusChanged.parse(event.payload);
      built = adminChanged({
        kind: payload.to === 'ACTIVE' ? 'enabled' : 'disabled',
        target,
        rolesBefore: null,
        asOfEvent: await asOf(payload.roleKeys),
        actor,
        at,
        words: this.deps.words,
      });
    }
    await publish(this.deps.lane, scope, tx, built, {
      dedupeKey: `oplog:admin:${event.eventId}`,
      correlationId: event.correlationId,
    });
  }
}
