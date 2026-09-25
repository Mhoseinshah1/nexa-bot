import {
  BOT_ERROR_CODES,
  BOT_WEBHOOK_ERROR_MESSAGE_MAX,
  botInstanceIdSchema,
  errors,
  NexaError,
  PLATFORM_ERROR_CODES,
  type ActorContext,
  type AuditWriter,
  type BotDiagnostic,
  type BotInstallationView,
  type BotInstanceId,
  type BotInstanceView,
  type BotOperatorStatus,
  type Clock,
  type IdempotencyStore,
  type OperationalEventRecorder,
  type PermissionKey,
  type TenantContext,
  type UnitOfWork,
} from '@nexa/contracts';
import type { PermissionGuard } from '../../access/application/permission-guard.js';
import {
  recordMutationDenial,
  runAuthorizedMutation,
} from '../../access/application/authorized-mutation.js';
import type { OutboxWriter } from '../../eventing/infrastructure/outbox-writer.js';
import { rememberOnce } from '../../idempotency/application/remember-once.js';
import { hashRequest } from '../../idempotency/infrastructure/drizzle-idempotency-store.js';
import type { SessionRepository } from '../../identity/application/ports.js';
import type { ScopeActivityReader } from '../../system/application/record-ping.service.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import {
  claimedBotId,
  commandMenuState,
  readinessOf,
  webhookSecretState,
} from '../domain/bot-readiness.js';
import type {
  BotManagementRecord,
  BotManagementRepository,
  BotManagementTelegram,
} from './bot-management-ports.js';
import { webhookSecretFingerprint } from './webhook-fingerprint.js';

/**
 * The three permissions, each an existing key (`docs/wp13-bots-management-audit.md` D3–D6).
 *
 * No `bots.*` key exists and adding one would need a backfill, because role grants are
 * stored rows. `settings.edit` and `settings.destructive` are seeded to `owner` alone;
 * `settings.view` also to operator and technical, who need to see why customers are not
 * being answered.
 */
export const BOTS_VIEW_PERMISSION = 'settings.view' satisfies PermissionKey;
export const BOTS_OPERATE_PERMISSION = 'settings.edit' satisfies PermissionKey;
export const BOTS_TOKEN_PERMISSION = 'settings.destructive' satisfies PermissionKey;

export interface BotManagementServiceDeps {
  readonly repository: BotManagementRepository;
  readonly telegram: BotManagementTelegram;
  readonly guard: PermissionGuard;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly audit: AuditWriter;
  readonly opsLog: OperationalEventRecorder;
  readonly sessions: SessionRepository;
  readonly idempotency: IdempotencyStore;
  readonly scopeActivity: ScopeActivityReader;
  readonly outbox: OutboxWriter;
  readonly clock: Clock;
  /** `TELEGRAM_WEBHOOK_SECRET` as this process read it; empty means not configured. */
  readonly webhookSecret: () => string;
  /** `TELEGRAM_WEBHOOK_ENABLED` as this process read it. */
  readonly webhookEnabled: () => boolean;
}

/** What a replay needs to answer as the first run did. */
interface MutationResult {
  readonly botId: string;
  readonly changed: boolean;
}

export interface BotMutationOutcome {
  readonly bot: BotInstanceView;
  readonly installation: BotInstallationView;
  readonly changed: boolean;
}

/**
 * Web Admin management of the tenant's Telegram bot instances (WP13).
 *
 * Three acts and two reads, and what is absent is as deliberate as what is here — the
 * audit's §3 table names each absence and the decision behind it. The two that matter
 * most: there is no way to CREATE a bot (the bootstrap is fenced from every surface, and
 * the owner decided there is no "add primary bot"), and no way to REGISTER a webhook
 * (the API process does not know the public origin, and `setWebhook` belongs to the
 * bootstrap).
 *
 * Every Telegram call happens outside a transaction; the call core asserts it.
 */
export class BotManagementService {
  constructor(private readonly deps: BotManagementServiceDeps) {}

  async list(
    scope: TenantContext,
    actor: ActorContext,
  ): Promise<{ readonly bots: BotInstanceView[]; readonly installation: BotInstallationView }> {
    await this.deps.guard.check(scope, actor, BOTS_VIEW_PERMISSION);
    const records = await this.deps.repository.listManaged(scope, this.currentFingerprint());
    return { bots: records.map((record) => this.view(record)), installation: this.installation() };
  }

  async get(
    scope: TenantContext,
    actor: ActorContext,
    candidateId: string,
  ): Promise<{ readonly bot: BotInstanceView; readonly installation: BotInstallationView }> {
    await this.deps.guard.check(scope, actor, BOTS_VIEW_PERMISSION);
    const record = await this.require(scope, this.botId(candidateId));
    return { bot: this.view(record), installation: this.installation() };
  }

  /**
   * Stop or start a bot: ACTIVE ⇄ STOPPED, and nothing else (D3).
   *
   * A request for the state the bot is already in answers `changed: false` and writes no
   * audit row — a row saying a bot was stopped, written when nothing changed, records
   * something that did not happen. It is still REMEMBERED under its key, so a redelivery
   * arriving after somebody else's change cannot re-apply it.
   */
  async setStatus(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly idempotencyKey: string;
      readonly botId: string;
      readonly status: BotOperatorStatus;
    },
  ): Promise<BotMutationOutcome> {
    const botId = this.botId(input.botId);
    const denial = {
      action: 'bot_instance.status_change',
      entityType: 'BotInstance',
      entityId: botId as string,
    };
    await this.authorize(scope, actor, BOTS_OPERATE_PERMISSION, denial);

    const requestHash = hashRequest({ botId, status: input.status });
    const replayed = await this.replay(scope, input.idempotencyKey, requestHash);
    if (replayed !== null) return replayed;

    const now = this.deps.clock.now();
    const changed = await runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      BOTS_OPERATE_PERMISSION,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        const locked = await this.deps.repository.lockManaged(scope, botId, tx);
        if (locked === null) throw this.notFound();
        if (locked.status === 'DISABLED') {
          throw errors.preconditionFailed(
            BOT_ERROR_CODES.BOT_STATUS_NOT_MANAGED,
            'This bot is DISABLED, which the Web Admin neither sets nor clears.',
          );
        }
        if (locked.status === input.status) {
          await this.remember(scope, input.idempotencyKey, requestHash, botId, false, tx);
          return false;
        }

        const moved = await this.deps.repository.transitionStatus(
          scope,
          botId,
          { from: locked.status, to: input.status, now },
          tx,
        );
        /*
         * Under the row lock the conditional UPDATE cannot miss, so a miss is a
         * contradiction rather than a race — refused rather than reported as a change.
         * The `from` state is in the WHERE clause anyway, for the reason `CLAUDE.md`
         * gives about every state change: the predicate is what keeps a replay, a
         * double-click and two replicas safe, and a lock taken by a later refactor's
         * caller is not something this method may assume.
         */
        if (!moved) {
          throw errors.conflict(
            BOT_ERROR_CODES.BOT_STATUS_NOT_MANAGED,
            'The bot changed state while this request held it. Reload and try again.',
          );
        }

        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'bot_instance.status_change',
            entityType: 'BotInstance',
            entityId: botId,
            before: { status: locked.status },
            after: { status: input.status },
            result: 'SUCCESS',
          },
          tx,
        );
        await this.deps.outbox.write(tx, actor, {
          eventType: 'BotInstanceStatusChanged',
          aggregateType: 'BotInstance',
          aggregateId: botId,
          payload: { from: locked.status, to: input.status },
        });
        await this.remember(scope, input.idempotencyKey, requestHash, botId, true, tx);
        return true;
      },
    );

    return this.outcome(scope, botId, changed);
  }

  /**
   * Replace the token of the SAME bot (D4). Never a repoint, never a new bot.
   *
   * The order is the point, and each step exists so the next one never has to run:
   *
   *   1. the permission, before anything is parsed, so a caller who may not replace a
   *      credential learns nothing about which tokens would have been accepted;
   *   2. the token's own claim, locally — a token for another bot is refused without
   *      being sent anywhere;
   *   3. the stored token, decrypted and compared — the same token is a no-op;
   *   4. `getMe`, outside any transaction — a token Telegram refuses is never stored,
   *      because a stored credential that never worked is indistinguishable from one
   *      that stopped working;
   *   5. the write, under the row lock, WHERE the row still names the identity step 4
   *      proved.
   *
   * The token is not in the request hash: two replacements under one key with different
   * values must not be told apart by a digest of a secret kept in a table nothing else
   * protects (the rule `PanelService.create` records for panel credentials).
   */
  async replaceToken(
    scope: TenantContext,
    actor: ActorContext,
    input: { readonly idempotencyKey: string; readonly botId: string; readonly token: string },
  ): Promise<BotMutationOutcome> {
    const botId = this.botId(input.botId);
    const denial = {
      action: 'bot_instance.token_replace',
      entityType: 'BotInstance',
      entityId: botId as string,
    };
    await this.authorize(scope, actor, BOTS_TOKEN_PERMISSION, denial);

    const claimed = claimedBotId(input.token);
    if (claimed === null) {
      throw errors.validation(
        BOT_ERROR_CODES.BOT_TOKEN_MALFORMED,
        'That is not a Telegram bot token. A token is the bot id, a colon, and the secret.',
      );
    }

    const requestHash = hashRequest({ botId, action: 'replace_token' });
    const replayed = await this.replay(scope, input.idempotencyKey, requestHash);
    if (replayed !== null) return replayed;

    const record = await this.require(scope, botId);
    if (record.telegramBotId === null) {
      throw errors.preconditionFailed(
        BOT_ERROR_CODES.BOT_IDENTITY_UNKNOWN,
        'This bot has no recorded Telegram id to compare a token against. ' +
          'Run `botctl telegram register` once to record it.',
      );
    }
    const identity = record.telegramBotId;
    if (claimed !== identity) throw this.differentBot();

    if (await this.sameAsStored(scope, botId, input.token)) {
      await this.deps.uow.run(scope, async (tx) => {
        await this.assertScopeActive(scope, tx);
        await this.remember(scope, input.idempotencyKey, requestHash, botId, false, tx);
      });
      return this.outcome(scope, botId, false);
    }

    const probe = await this.deps.telegram.identify(input.token);
    switch (probe.outcome) {
      case 'IDENTIFIED':
        if (probe.botId !== identity) throw this.differentBot();
        break;
      case 'REJECTED':
        throw errors.validation(
          BOT_ERROR_CODES.BOT_TOKEN_REJECTED,
          'Telegram rejected this token. Issue a new one in BotFather and try again.',
        );
      case 'NOT_TELEGRAM':
        // UPSTREAM_REJECTED rather than CONFIGURATION: the latter answers 500, which would
        // read as this installation breaking rather than as the address being wrong.
        throw new NexaError({
          kind: 'UPSTREAM_REJECTED',
          code: BOT_ERROR_CODES.BOT_TELEGRAM_API_INVALID,
          message:
            'The configured Telegram API address answered with something that is not a bot. ' +
            'Check TELEGRAM_API_BASE_URL.',
        });
      case 'UNREACHABLE':
        throw this.unreachable();
    }

    const now = this.deps.clock.now();
    await runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      BOTS_TOKEN_PERMISSION,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        const locked = await this.deps.repository.lockManaged(scope, botId, tx);
        if (locked === null) throw this.notFound();
        if (locked.telegramBotId !== identity) throw this.differentBot();
        const replaced = await this.deps.repository.replaceToken(
          scope,
          botId,
          { token: input.token, telegramBotId: identity, now },
          tx,
        );
        if (!replaced) throw this.differentBot();
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'bot_instance.token_replace',
            entityType: 'BotInstance',
            entityId: botId,
            before: null,
            // The identity that was proved, and never the value. The audit writer would
            // redact a key containing `token` anyway; this never gives it one to redact.
            after: { telegramBotId: identity, verifiedBy: 'getMe' },
            result: 'SUCCESS',
          },
          tx,
        );
        await this.remember(scope, input.idempotencyKey, requestHash, botId, true, tx);
      },
    );

    return this.outcome(scope, botId, true);
  }

  /**
   * Ask Telegram what it holds for this bot (D5). A read, stored nowhere.
   *
   * Authorized BEFORE the credential is used, and the refusal recorded the way a
   * mutation's is (`recordMutationDenial`): a permission checked after the side effect is
   * not a permission check, and the side effect here is decrypting the token and sending
   * it to Telegram. `settings.edit`, because that is the line `panels.edit` draws for the
   * panel connection test.
   *
   * ACTIVE bots only. `OQ-5R-02` records that a stopped bot's credential is not used for
   * reads either, and a diagnostic is the same widening that entry declines.
   *
   * Transport error text is never returned. It can carry the token (`redaction.ts`
   * records the shape); the outcome codes say everything an operator can act on.
   */
  async diagnose(
    scope: TenantContext,
    actor: ActorContext,
    candidateId: string,
  ): Promise<BotDiagnostic> {
    const botId = this.botId(candidateId);
    await this.authorize(scope, actor, BOTS_OPERATE_PERMISSION, {
      action: 'bot_instance.diagnose',
      entityType: 'BotInstance',
      entityId: botId,
    });
    const record = await this.require(scope, botId);
    const token =
      record.status === 'ACTIVE'
        ? await this.deps.repository.tokenForBotInstance(scope, botId)
        : null;
    if (token === null) {
      throw errors.preconditionFailed(
        BOT_ERROR_CODES.BOT_NOT_ACTIVE,
        'Only an active bot is checked; a stopped bot’s token is not used.',
      );
    }

    const checkedAt = this.deps.clock.now();
    const probe = await this.deps.telegram.identify(token);
    const identified = probe.outcome === 'IDENTIFIED' ? probe : null;
    const webhook = identified === null ? null : await this.deps.telegram.readWebhook(token);

    return {
      botInstanceId: botId,
      checkedAt: checkedAt.toISOString(),
      identity: {
        outcome: probe.outcome,
        telegramBotId: identified?.botId ?? null,
        username: identified?.username ?? null,
        idMatches:
          identified === null || record.telegramBotId === null
            ? null
            : identified.botId === record.telegramBotId,
        usernameMatches: identified === null ? null : identified.username === record.username,
      },
      webhook:
        webhook === null
          ? {
              outcome: 'SKIPPED',
              url: null,
              urlMatchesRecorded: null,
              pendingUpdateCount: null,
              lastErrorAt: null,
              lastErrorMessage: null,
              maxConnections: null,
            }
          : webhook.outcome === 'READ'
            ? {
                outcome: 'READ',
                url: webhook.url,
                urlMatchesRecorded:
                  record.webhookUrl === null ? null : webhook.url === record.webhookUrl,
                pendingUpdateCount: webhook.pendingUpdateCount,
                lastErrorAt: webhook.lastErrorAt?.toISOString() ?? null,
                lastErrorMessage:
                  webhook.lastErrorMessage === null
                    ? null
                    : webhook.lastErrorMessage.slice(0, BOT_WEBHOOK_ERROR_MESSAGE_MAX),
                maxConnections: webhook.maxConnections,
              }
            : {
                outcome: webhook.outcome,
                url: null,
                urlMatchesRecorded: null,
                pendingUpdateCount: null,
                lastErrorAt: null,
                lastErrorMessage: null,
                maxConnections: null,
              },
    };
  }

  // -------------------------------------------------------------------------

  private view(record: BotManagementRecord): BotInstanceView {
    const secretConfigured = this.deps.webhookSecret() !== '';
    const secret = webhookSecretState(record.webhookSecretMatches, secretConfigured);
    const readiness = readinessOf({
      webhookRouteEnabled: this.deps.webhookEnabled(),
      tenantActive: record.tenant.status === 'ACTIVE',
      botStatus: record.status,
      webhookRegisteredAt: record.webhookRegisteredAt,
      secret,
    });
    return {
      id: record.id,
      username: record.username,
      telegramBotId: record.telegramBotId,
      status: record.status,
      tenant: {
        id: record.tenant.id,
        slug: record.tenant.slug,
        displayName: record.tenant.displayName,
        kind: record.tenant.kind,
      },
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
      webhook: {
        registeredAt: record.webhookRegisteredAt?.toISOString() ?? null,
        url: record.webhookUrl,
        secret,
      },
      commandMenu: commandMenuState(record.commandsRevision, this.deps.telegram.commandsRevision()),
      readiness: { state: readiness.state, causes: [...readiness.causes] },
    };
  }

  /**
   * The bot as it stands after a mutation, read WITHOUT charging `settings.view`.
   *
   * The caller was just authorized for something stronger, and a custom role holding
   * `settings.edit` without the view key must not have its committed stop answered with
   * a 403 — that would report a failure for a change that happened.
   */
  private async outcome(
    scope: TenantContext,
    botId: BotInstanceId,
    changed: boolean,
  ): Promise<BotMutationOutcome> {
    const record = await this.require(scope, botId);
    return { bot: this.view(record), installation: this.installation(), changed };
  }

  private installation(): BotInstallationView {
    return {
      webhookRouteEnabled: this.deps.webhookEnabled(),
      webhookSecretConfigured: this.deps.webhookSecret() !== '',
    };
  }

  private currentFingerprint(): string | null {
    const secret = this.deps.webhookSecret();
    return secret === '' ? null : webhookSecretFingerprint(secret);
  }

  /**
   * Whether the supplied token IS the stored one. The stored value never leaves here.
   *
   * A stored token that cannot be decrypted answers false rather than failing the
   * request: replacing an unreadable credential is precisely what this path is for.
   */
  private async sameAsStored(
    scope: TenantContext,
    botId: BotInstanceId,
    token: string,
  ): Promise<boolean> {
    try {
      return (await this.deps.repository.resolveToken(scope, botId)) === token;
    } catch (error) {
      if (error instanceof NexaError && error.kind === 'NOT_FOUND') throw this.notFound();
      return false;
    }
  }

  private async require(scope: TenantContext, botId: BotInstanceId): Promise<BotManagementRecord> {
    const record = await this.deps.repository.findManaged(scope, botId, this.currentFingerprint());
    if (record === null) throw this.notFound();
    return record;
  }

  /** A uuid, validated here; anything else is answered as an unknown bot. */
  private botId(candidate: string): BotInstanceId {
    const parsed = botInstanceIdSchema.safeParse(candidate);
    if (!parsed.success) throw this.notFound();
    return parsed.data;
  }

  private notFound(): NexaError {
    return errors.notFound(BOT_ERROR_CODES.BOT_NOT_FOUND, 'Unknown bot instance.');
  }

  private differentBot(): NexaError {
    return errors.validation(
      BOT_ERROR_CODES.BOT_TOKEN_DIFFERENT_BOT,
      'This token belongs to a different bot. A replacement token must be for the same bot; ' +
        'a bot is never repointed.',
    );
  }

  private unreachable(): NexaError {
    return new NexaError({
      kind: 'UPSTREAM_UNAVAILABLE',
      code: BOT_ERROR_CODES.BOT_TELEGRAM_UNREACHABLE,
      message: 'Telegram could not be reached. Nothing was changed; try again later.',
    });
  }

  private async replay(
    scope: TenantContext,
    idempotencyKey: string,
    requestHash: string,
  ): Promise<BotMutationOutcome | null> {
    const found = await this.deps.idempotency.find<MutationResult>(
      scope,
      'WEB',
      idempotencyKey,
      requestHash,
    );
    if (found === null) return null;
    const record = await this.require(scope, found.result.botId as BotInstanceId);
    return {
      bot: this.view(record),
      installation: this.installation(),
      changed: found.result.changed,
    };
  }

  private async remember(
    scope: TenantContext,
    idempotencyKey: string,
    requestHash: string,
    botId: BotInstanceId,
    changed: boolean,
    tx: TransactionScope,
  ): Promise<void> {
    await rememberOnce(
      this.deps.idempotency,
      scope,
      'WEB',
      idempotencyKey,
      requestHash,
      { botId, changed } satisfies MutationResult,
      tx,
    );
  }

  private async assertScopeActive(scope: TenantContext, tx: TransactionScope): Promise<void> {
    if (await this.deps.scopeActivity.scopeIsActive(scope, tx)) return;
    // The answer `PanelService` gives: a scope that stopped accepting work is not a scope
    // this request can act in, and saying which part of it stopped is not this path's job.
    throw errors.notFound(
      PLATFORM_ERROR_CODES.TENANT_NOT_FOUND,
      'This scope is not accepting work.',
    );
  }

  /** `recordMutationDenial`, not a bare check — an early refusal leaves the same trace. */
  private async authorize(
    scope: TenantContext,
    actor: ActorContext,
    permission: PermissionKey,
    denial: { action: string; entityType: string; entityId: string | null },
  ): Promise<void> {
    try {
      await this.deps.guard.check(scope, actor, permission);
    } catch (error) {
      await recordMutationDenial(this.mutationDeps(), scope, actor, permission, denial, error);
      throw error;
    }
  }

  private mutationDeps() {
    return {
      uow: this.deps.uow,
      guard: this.deps.guard,
      audit: this.deps.audit,
      opsLog: this.deps.opsLog,
      sessions: this.deps.sessions,
      clock: this.deps.clock,
    };
  }
}
