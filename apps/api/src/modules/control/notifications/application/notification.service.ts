import {
  CONTROL_ERROR_CODES,
  errors,
  isMoneyValue,
  sendTestNotificationRequestSchema,
  templateDefinition,
  type ActorContext,
  type AuditWriter,
  type Clock,
  type IdempotencyStore,
  type IdGenerator,
  type NotificationDestination,
  type NotificationKind,
  type PermissionKey,
  type OperationalEventRecorder,
  type ScopeContext,
  type SettingKey,
  type TemplateKey,
  type TemplateValues,
  type UnitOfWork,
} from '@nexa/contracts';
import type { PermissionGuard } from '../../../platform/access/application/permission-guard.js';
import type { SessionRepository } from '../../../platform/identity/application/ports.js';
import {
  recordMutationDenial,
  runAuthorizedMutation,
} from '../../../platform/access/application/authorized-mutation.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import { hashRequest } from '../../../platform/idempotency/infrastructure/drizzle-idempotency-store.js';
import { rememberOnce } from '../../../platform/idempotency/application/remember-once.js';
import type { FeatureFlagResolver } from '../../features/application/feature-flags.service.js';
import type { SettingsResolver } from '../../settings/application/settings-resolver.js';
import type {
  DeliveryAttemptRecord,
  NotificationIntent,
  NotificationRepository,
  ReleasedClaimRecord,
} from './ports.js';

export const NOTIFICATIONS_VIEW: PermissionKey = 'opslog.view';

/**
 * Creating and reading notification intents.
 *
 * Reading is guarded by `opslog.view`: a notification is operational record, the
 * same family as an operational event, and it does not need a permission of its
 * own to make a screen convenient.
 *
 * Creating is NOT guarded, and that is the distinction that matters. Nobody
 * asks for an operational notification — a condition occurs and somebody should
 * be told. There is no actor to authorize. What creating does require is a
 * caller that has already decided, which is why `queue` takes a transaction: the
 * intent commits with the thing that caused it or not at all.
 */
export class NotificationService {
  constructor(
    private readonly guard: PermissionGuard,
    private readonly notifications: NotificationRepository,
    private readonly settings: SettingsResolver,
    private readonly features: FeatureFlagResolver,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly audit: AuditWriter,
    private readonly idempotency: IdempotencyStore,
    private readonly uow: UnitOfWork<TransactionScope>,
    /**
     * The RAW recorder, for denials only.
     *
     * A denial's operational event is written after its transaction has rolled
     * back, so it must not travel through the projector's own transaction.
     */
    private readonly opsLog: OperationalEventRecorder,
    /** For the mutation-time session-revocation check. */
    private readonly sessions: SessionRepository,
  ) {}

  /**
   * Records that something should be communicated.
   *
   * Returns `created: false` when an intent with this dedupe key already exists.
   * That is the normal case for a repeating condition, and it is the mechanism
   * by which sixty occurrences of one problem produce one message.
   */
  async queue(
    scope: ScopeContext,
    input: {
      readonly kind: NotificationKind;
      readonly dedupeKey: string;
      readonly templateKey: TemplateKey;
      readonly values: TemplateValues;
      readonly correlationId?: string;
    },
    tx?: unknown,
  ): Promise<{ readonly intent: NotificationIntent | null; readonly created: boolean }> {
    if (!(await this.features.isEnabled(scope, 'ops_notifications', tx))) {
      return { intent: null, created: false };
    }

    const destination = await this.destination(scope, tx);
    if (destination === null) return { intent: null, created: false };

    const maxAttempts = await this.settings.valueOf<number>(
      scope,
      'ops.notifications.max_attempts' as SettingKey,
      tx,
    );

    // The template key is checked here rather than at send time, so a typo is a
    // failure at the point that can still be fixed by a person, not a message
    // that fails silently at three in the morning.
    templateDefinition(input.templateKey);

    return this.notifications.create(
      scope,
      {
        id: this.ids.uuid(),
        kind: input.kind,
        dedupeKey: input.dedupeKey,
        // A snapshot. An attempt from March must still say which chat it was
        // addressed to after somebody repoints the destination in April.
        destination,
        payload: serialiseValues(input.values),
        templateKey: input.templateKey,
        maxAttempts,
        correlationId: input.correlationId ?? null,
        now: this.clock.now(),
      },
      tx,
    );
  }

  async list(
    scope: ScopeContext,
    actor: ActorContext,
    options: { limit?: number; before?: Date } = {},
  ): Promise<NotificationIntent[]> {
    await this.guard.check(scope, actor, NOTIFICATIONS_VIEW);
    return this.notifications.list(scope, {
      limit: Math.min(Math.max(options.limit ?? 50, 1), 200),
      ...(options.before ? { before: options.before } : {}),
    });
  }

  async get(
    scope: ScopeContext,
    actor: ActorContext,
    id: string,
  ): Promise<{
    intent: NotificationIntent;
    attempts: DeliveryAttemptRecord[];
    releasedClaims: ReleasedClaimRecord[];
  }> {
    await this.guard.check(scope, actor, NOTIFICATIONS_VIEW);
    const intent = await this.notifications.findById(scope, id);
    if (intent === null) {
      throw errors.notFound(
        CONTROL_ERROR_CODES.NOTIFICATION_NOT_FOUND,
        'No such notification in this tenant.',
      );
    }
    // The intent says what we meant to say; the attempts say what happened;
    // the released claims say where the rest of the claims went. Returning the
    // three together is the whole point of keeping them apart — and without
    // the third, a withdrawn sweep reads as a permanent failure on an intent
    // that is somehow pending again.
    return {
      intent,
      attempts: await this.notifications.attempts(scope, id),
      releasedClaims: await this.notifications.releasedClaims(scope, id),
    };
  }

  /**
   * Sends a test message to the configured destination.
   *
   * Exists because the legacy log group could not be tested at all: its forum
   * topic id was never captured anywhere (UNK-GS-002), and a destination that
   * cannot be tested is a destination discovered to be wrong during an incident.
   *
   * Requires `settings.edit`, not a permission of its own — it is part of
   * configuring the destination, and it sends one message to an operations
   * channel, not to a customer.
   */
  async sendTest(
    scope: ScopeContext,
    actor: ActorContext,
    input: unknown,
  ): Promise<{
    readonly intent: NotificationIntent;
    /**
     * What has been tried, read here rather than by the caller.
     *
     * The controller used to call `get` for these, which guards on
     * `opslog.view` while this guards on `settings.edit`. They are different
     * permissions with different risk levels and nothing forces them to be
     * held together — the roles are a seed and per-admin overrides exist. An
     * administrator holding `settings.edit` with `opslog.view` denied would
     * therefore have their test QUEUED and then be answered 403, permanently:
     * the retry replays the write and fails at the same read, so the caller
     * could never see the result of a write that had happened. Reading them
     * inside the already-authorized command removes the second check rather
     * than widening the first.
     */
    readonly attempts: readonly DeliveryAttemptRecord[];
    /**
     * The claims this intent gave back, read on the same argument.
     *
     * A replay whose claims were handed back has an `attemptCount` larger than
     * its attempt list, and without these rows nothing on the reply explains
     * the difference.
     */
    readonly releasedClaims: readonly ReleasedClaimRecord[];
    readonly created: boolean;
    readonly replayed: boolean;
  }> {
    // The early rejection, audited. This is the check an ordinary
    // unauthorized request actually hits; the decision that counts is re-run
    // inside the transaction below.
    try {
      await this.guard.check(scope, actor, 'settings.edit');
    } catch (denial) {
      // One recorder for every early refusal in the codebase. The inline
      // version this replaces wrote a DENIED row for ANY throw — including a
      // missing tenant context, which is not a denial of this permission — and
      // emitted no operational event, so the same refusal was recorded
      // differently depending on which phase wrote the endpoint.
      await recordMutationDenial(
        { guard: this.guard, audit: this.audit, opsLog: this.opsLog },
        scope,
        actor,
        'settings.edit',
        { action: 'notifications.test', entityType: 'Notification', entityId: null },
        denial,
      );
      throw denial;
    }
    const command = sendTestNotificationRequestSchema.parse(input);

    // A state-changing command, so it takes an idempotency key like every
    // other one. That is a different mechanism from the intent's dedupe key
    // below and answers a different question: the key stops a double-clicked
    // button producing two messages, while the dedupe key expresses that two
    // DELIBERATE tests are two separate questions.
    //
    // The hash covers the REQUEST and nothing else. It used to include the
    // resolved destination, which is server state rather than something the
    // caller sent — so a retry of an accepted test, after somebody changed the
    // chat id, hashed differently and was rejected as a payload mismatch: the
    // caller was told their key had been reused with different input when they
    // had sent the same input twice. The request carries only a key, so that is
    // all there is to identify it by.
    const requestHash = hashRequest({ command: 'notifications.test' });

    // The replay lookup comes BEFORE the destination is resolved, for the same
    // reason. An accepted test does not become un-accepted when the destination
    // is later cleared; looking the other way round meant a replay of a
    // committed request answered `destination_not_configured` about a message
    // that had already been queued and possibly already sent.
    const existing = await this.idempotency.find<{ notificationId: string }>(
      scope,
      actor.surface,
      command.idempotencyKey,
      requestHash,
    );
    if (existing) {
      const intent = await this.notifications.findById(scope, existing.result.notificationId);
      if (intent === null) {
        // The key says a test was created and the intent it names is gone.
        // Nothing in this system deletes a notification, so this is a
        // corruption rather than an ordinary miss — and FALLING THROUGH to
        // create a new one would invert the whole mechanism: every replay of
        // that key would mint another message, so N retries of one request
        // would send N of them. Refusing says what is wrong.
        throw errors.conflict(
          // Its own code. Reusing NOT_FOUND here made "no such notification"
          // and "your idempotency record points at nothing" indistinguishable,
          // and only one of those is worth retrying.
          CONTROL_ERROR_CODES.NOTIFICATION_RECORD_ORPHANED,
          `Idempotency key "${command.idempotencyKey}" names notification ` +
            `${existing.result.notificationId}, which no longer exists.`,
          { notificationId: existing.result.notificationId },
        );
      }
      // Both reads in one REPEATABLE READ transaction, which is the part that
      // matters and which a bare transaction does not give.
      //
      // The connection's default is READ COMMITTED, where every statement takes
      // its own snapshot — so wrapping two reads in `db.transaction` bought a
      // round trip and nothing else, while the comment here claimed it stopped
      // the dispatcher pairing an older status with newer attempts. Under
      // REPEATABLE READ both statements see one snapshot, so the reply cannot
      // report PENDING beside a successful send: a state the database never
      // held.
      return this.uow.runSnapshot(scope, async (tx) => {
        const current = await this.notifications.findById(scope, intent.id, tx);
        return {
          intent: current ?? intent,
          attempts: await this.notifications.attempts(scope, intent.id, tx),
          releasedClaims: await this.notifications.releasedClaims(scope, intent.id, tx),
          created: false,
          replayed: true,
        };
      });
    }

    // Only a NEW test needs a destination to send to.
    const destination = await this.destination(scope);
    if (destination === null) {
      throw errors.validation(
        CONTROL_ERROR_CODES.DESTINATION_NOT_CONFIGURED,
        'No operations destination is configured, so there is nothing to test.',
      );
    }

    const now = this.clock.now();
    const maxAttempts = await this.settings.valueOf<number>(
      scope,
      'ops.notifications.max_attempts' as SettingKey,
    );

    // The intent's own id is its dedupe key. A timestamp was the obvious choice
    // and is wrong at the edge: two clicks inside one millisecond would
    // collide, and the second would report success while pointing at the first
    // test's outcome.
    const id = this.ids.uuid();

    // The intent, its audit row and the idempotency record commit together.
    // An audit row outside the transaction of the write it describes can
    // survive a write that rolled back, and then it is a record of something
    // that did not happen.
    return runAuthorizedMutation(
      {
        uow: this.uow,
        guard: this.guard,
        audit: this.audit,
        opsLog: this.opsLog,
        sessions: this.sessions,
        clock: this.clock,
      },
      scope,
      actor,
      'settings.edit',
      { action: 'notifications.test', entityType: 'Notification', entityId: null },
      async (tx) => {
        const result = await this.notifications.create(
          scope,
          {
            id,
            kind: 'OPERATIONS_TEST',
            dedupeKey: `ops-test:${id}`,
            destination,
            // `label` is nullable on an actor; the template requires a name, so
            // say what we actually know rather than rendering the word "null".
            payload: serialiseValues({ requestedBy: actor.label ?? actor.type, at: now }),
            templateKey: 'ops.notification.test',
            maxAttempts,
            correlationId: actor.correlationId,
            now,
          },
          tx,
        );

        await this.audit.record(
          scope,
          actor,
          {
            action: 'notifications.test',
            entityType: 'Notification',
            entityId: result.intent.id,
            before: null,
            after: { destination: describeDestination(destination) },
            result: 'SUCCESS',
          },
          tx,
        );

        await rememberOnce(
          this.idempotency,
          scope,
          actor.surface,
          command.idempotencyKey,
          requestHash,
          { notificationId: result.intent.id },
          tx,
        );

        // A brand-new intent has no attempts and no returned claims yet; saying
        // so is a fact rather than the hard-coded empty list the controller
        // used to invent. Both lists are empty for the same reason: the intent
        // has never been claimed.
        return { ...result, attempts: [], releasedClaims: [], replayed: false };
      },
    );
  }

  /** The configured destination, or null when there is none. */
  private async destination(
    scope: ScopeContext,
    tx?: unknown,
  ): Promise<NotificationDestination | null> {
    const chatId = await this.settings.valueOf<string>(
      scope,
      'ops.notifications.telegram_chat_id' as SettingKey,
      tx,
    );
    // Empty means "not configured", which the registry states as this key's
    // declared zero meaning rather than leaving a reader to guess.
    if (chatId.trim() === '') return null;

    const topicId = await this.settings.valueOf<number | null>(
      scope,
      'ops.notifications.telegram_topic_id' as SettingKey,
      tx,
    );
    return { transport: 'TELEGRAM', chatId, topicId };
  }
}

/** A destination as it may appear in an audit row. Carries no credential. */
function describeDestination(destination: NotificationDestination): Record<string, unknown> {
  return destination.transport === 'TELEGRAM'
    ? { transport: 'TELEGRAM', chatId: destination.chatId, topicId: destination.topicId }
    : { transport: destination.transport };
}

/**
 * Turns template values into something a `jsonb` column can hold.
 *
 * Dates become ISO strings and bigints become decimal strings, because JSON has
 * neither. `Money` survives as its two fields, so the amount is still minor
 * units plus a currency when it comes back out and is still rendered by the one
 * formatter.
 */
export function serialiseValues(values: TemplateValues): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [token, value] of Object.entries(values)) {
    if (value instanceof Date) {
      out[token] = value.toISOString();
    } else if (typeof value === 'bigint') {
      out[token] = value.toString();
    } else if (isMoneyValue(value)) {
      // Minor units as a string, currency alongside. JSON has no bigint, and a
      // number would silently lose precision above 2^53 — which is well inside
      // the range of an amount denominated in Rial.
      out[token] = { amountMinor: value.amountMinor.toString(), currency: value.currency };
    } else {
      out[token] = value;
    }
  }
  return out;
}
