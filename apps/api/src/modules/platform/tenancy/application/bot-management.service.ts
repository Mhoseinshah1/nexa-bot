import {
  BOT_ERROR_CODES,
  BOT_WEBHOOK_ERROR_MESSAGE_MAX,
  botInstanceIdSchema,
  errors,
  isNexaError,
  NexaError,
  PLATFORM_ERROR_CODES,
  replaceBotTokenRequestSchema,
  type ActorContext,
  type AuditWriter,
  type BotCommandSyncResult,
  type BotDiagnostic,
  type BotInstallationView,
  type BotInstanceId,
  type BotInstanceView,
  type BotOperatorStatus,
  type BotReplacementFailureDetails,
  type BotReplacementStage,
  type BotWebhookCompensation,
  type Clock,
  type IdempotencyStore,
  type IdGenerator,
  type OperationalEventRecorder,
  type PermissionKey,
  type TenantContext,
  type UnitOfWork,
} from '@nexa/contracts';
import { redactSecretText } from '../../../../infrastructure/redaction.js';
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
  liveProblems,
  readinessOf,
  webhookSecretState,
} from '../domain/bot-readiness.js';
import { tokenReplacementLeaseMs } from '../domain/token-replacement-lease.js';
import { allowedUpdatesNarrowed, expectedWebhookUrl } from '../domain/webhook-url.js';
import type {
  BotManagementRecord,
  BotManagementRepository,
  BotManagementTelegram,
  BotWebhookRead,
} from './bot-management-ports.js';
import type { BotIdentityProbe } from './ports.js';
import type { BotCommandSyncService } from './bot-command-sync.service.js';
import type { CommandMenu } from './command-menu.js';
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

/**
 * R4 — the operational-event codes a replacement writes. Part of the schema once shipped
 * (`CLAUDE.md`, Phase 3C): `operational_events` dedupes and recovers by code.
 *
 * `…_incomplete` is opened, per bot, by a replacement that asked Telegram to change and
 * then did not store its token; `…_completed` closes it when a later one succeeds.
 */
export const TOKEN_REPLACEMENT_INCOMPLETE_CODE = 'bot.token_replacement_incomplete';
export const TOKEN_REPLACEMENT_COMPLETED_CODE = 'bot.token_replacement_completed';

/** The shortest webhook secret the config schema accepts with the route enabled. */
const WEBHOOK_SECRET_MIN_LENGTH = 16;

const incompleteKey = (botId: BotInstanceId): string =>
  `${TOKEN_REPLACEMENT_INCOMPLETE_CODE}:${botId}`;

/** What Telegram held before a replacement touched it — what a compensation restores. */
type PriorRegistration = 'NONE' | 'THIS_INSTALLATION' | 'ELSEWHERE';

/**
 * Telegram's own reason for refusing a registration, as far as it may be shown: redacted
 * by content (`redactSecretText`), stripped of the token itself should Telegram ever echo
 * it, and bounded. The reason is Telegram's API description ("bad webhook: …"), never
 * transport text — a transport error is not a refusal and never reaches here.
 */
function telegramReasonOf(detail: string, token: string): string {
  return redactSecretText(detail.split(token).join('[redacted]')).slice(
    0,
    BOT_WEBHOOK_ERROR_MESSAGE_MAX,
  );
}

export interface BotManagementServiceDeps {
  readonly repository: BotManagementRepository;
  readonly telegram: BotManagementTelegram;
  /** Round P: the desired command menu's digest, for the view's `commandMenu` state. */
  readonly commandMenu: Pick<CommandMenu, 'desiredFor'>;
  /**
   * Round P: the sync a token replacement queues in its storing transaction and runs after
   * it. Its result rides on the answer as `commandSync`, and NEVER fails the replacement.
   */
  readonly commandSync: Pick<BotCommandSyncService, 'requestSync' | 'syncNow'>;
  readonly guard: PermissionGuard;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly audit: AuditWriter;
  readonly opsLog: OperationalEventRecorder;
  readonly sessions: SessionRepository;
  readonly idempotency: IdempotencyStore;
  readonly scopeActivity: ScopeActivityReader;
  readonly outbox: OutboxWriter;
  readonly clock: Clock;
  /** Mints a token replacement's claim id (R4). */
  readonly ids: IdGenerator;
  /**
   * The Telegram call timeout (`NOTIFICATION_SEND_TIMEOUT_MS`) the gateway was built with,
   * from which the claim's lease is derived (`tokenReplacementLeaseMs`).
   */
  readonly telegramCallTimeoutMs: number;
  /** `TELEGRAM_WEBHOOK_SECRET` as this process read it; empty means not configured. */
  readonly webhookSecret: () => string;
  /** `TELEGRAM_WEBHOOK_ENABLED` as this process read it. */
  readonly webhookEnabled: () => boolean;
}

/**
 * What a completed mutation stores against its key: the response it produced, whole.
 *
 * A replay returns the FIRST result (`docs/conventions.md`), so the bot is snapshotted as
 * the command left it rather than re-read. A reply re-read on replay would pair the first
 * command's `changed` with whatever somebody did since — a stop replayed after a start
 * answering "changed" beside an ACTIVE bot. The view is JSON-native (ISO strings), so it
 * survives `jsonb` unchanged (the reason `SettingReplayRecord` gives).
 */
interface MutationResult {
  readonly botId: string;
  readonly changed: boolean;
  readonly bot: BotInstanceView;
  readonly installation: BotInstallationView;
  /** A token replacement's verification (R4). Absent on a status change, and on a
   * replacement remembered before R4. */
  readonly verification?: BotDiagnostic | null;
}

export interface BotMutationOutcome {
  readonly bot: BotInstanceView;
  readonly installation: BotInstallationView;
  readonly changed: boolean;
}

/** A token replacement's answer: the mutation, and what Telegram was verified to hold. */
export interface BotTokenReplacementOutcome extends BotMutationOutcome {
  readonly verification: BotDiagnostic | null;
  /** Round P: the command-menu sync run after storing, as a separate result; null on a replay. */
  readonly commandSync: Pick<BotCommandSyncResult, 'outcome' | 'errorCode'> | null;
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
    const desired = await this.desiredHash(scope);
    return {
      bots: records.map((record) => this.view(record, desired)),
      installation: this.installation(),
    };
  }

  async get(
    scope: TenantContext,
    actor: ActorContext,
    candidateId: string,
  ): Promise<{ readonly bot: BotInstanceView; readonly installation: BotInstallationView }> {
    await this.deps.guard.check(scope, actor, BOTS_VIEW_PERMISSION);
    const record = await this.require(scope, this.botId(candidateId));
    return {
      bot: this.view(record, await this.desiredHash(scope)),
      installation: this.installation(),
    };
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
    return runAuthorizedMutation(
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
          return this.remember(scope, input.idempotencyKey, requestHash, botId, false, tx);
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
        return this.remember(scope, input.idempotencyKey, requestHash, botId, true, tx);
      },
    );
  }

  /**
   * Replace the token of the SAME bot, and leave it able to receive updates (D4, R4).
   * Never a repoint, never a new bot.
   *
   * The defect this shape replaces: the old path proved the token with `getMe`, stored it,
   * and left the webhook to chance ("the webhook, secret and command menu are not
   * touched"). Whether Telegram keeps a registration across a BotFather revocation was
   * never established (`OQ-WP13-02`), and the owner's staging bot answered it the hard
   * way: the token was accepted and the bot stayed silent. `botctl telegram register`
   * could not repair it either before R4 — its rerun trusted the ROW's marker, which still
   * said registered (`BotBootstrapService.telegramStillHolds` now asks Telegram).
   *
   * The order is the point. Nothing is stored until Telegram has been shown to deliver to
   * this installation, and every step exists so the next one never has to run:
   *
   *   1. the permission, before anything is parsed;
   *   2. the token's own claim, locally — a token for another bot is sent nowhere;
   *   3. what this installation needs to be ABLE to receive (the route, the secret, the
   *      origin it registered at) — all local, so a replacement that could only fail is
   *      refused before the token leaves the host;
   *   4. the per-bot claim, so two replacements cannot interleave their Telegram calls;
   *   5. `getMe` — the token is valid, it is a bot, and it is THIS bot;
   *   6. `getWebhookInfo` — the prior registration, which is what compensation restores;
   *   7. `setWebhook` at the one URL this installation registers for this bot, with its
   *      secret and Telegram's default update set, keeping queued updates;
   *   8. `getWebhookInfo` again — the registration must be EXACTLY that URL;
   *   9. one transaction: token (if it changed), identity and the webhook marker, WHERE
   *      the row still names this bot and still holds this attempt's claim.
   *
   * DB and Telegram cannot be one transaction, so a failure after step 7 COMPENSATES —
   * puts Telegram back as far as it can be put back (`compensate`) — records an
   * operational event, and answers an error naming the stage and what was undone. Nothing
   * reports "replaced" unless step 9 committed.
   *
   * The same token as the one stored is NOT a short-cut any more: the webhook is still
   * registered and verified, and the answer is `changed: false` (the token did not change)
   * beside a verification that did happen. That is how a bot left silent by the old path
   * is repaired — its owner submits the token it already has.
   *
   * The token is not in the request hash: two replacements under one key with different
   * values must not be told apart by a digest of a secret kept in a table nothing else
   * protects (the rule `PanelService.create` records for panel credentials).
   */
  async replaceToken(
    scope: TenantContext,
    actor: ActorContext,
    input: { readonly idempotencyKey: string; readonly botId: string; readonly token: unknown },
  ): Promise<BotTokenReplacementOutcome> {
    const botId = this.botId(input.botId);
    const denial = {
      action: 'bot_instance.token_replace',
      entityType: 'BotInstance',
      entityId: botId as string,
    };
    await this.authorize(scope, actor, BOTS_TOKEN_PERMISSION, denial);

    // The token is validated only NOW, after the permission: the surface hands it over
    // unparsed, so a caller who may not replace a credential is refused (and the refusal
    // recorded) before anything about the value is judged — even its length.
    const token = replaceBotTokenRequestSchema.shape.token.parse(input.token);
    const claimed = claimedBotId(token);
    if (claimed === null) {
      throw errors.validation(
        BOT_ERROR_CODES.BOT_TOKEN_MALFORMED,
        'That is not a Telegram bot token. A token is the bot id, a colon, and the secret.',
      );
    }

    const requestHash = hashRequest({ botId, action: 'replace_token' });
    const replayed = await this.replayReplacement(scope, input.idempotencyKey, requestHash);
    if (replayed !== null) {
      /*
       * The hash cannot tell two tokens apart (it must not carry one), so the replay is
       * decided against the stored token instead: a key that already replaced this bot's
       * token answers as itself only when it is sent with THAT token. Sent with another —
       * another bot's, or a newer one from BotFather — it is a different request under a
       * reused key, and reporting it as "replaced" would tell the operator a token was
       * stored that never was.
       */
      if (!(await this.sameAsStored(scope, botId, token))) {
        throw errors.conflict(
          PLATFORM_ERROR_CODES.IDEMPOTENCY_PAYLOAD_MISMATCH,
          'This request key was already used to replace the token with a different value.',
        );
      }
      return replayed;
    }

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

    // Step 3 — everything the installation needs to RECEIVE, decided before the token
    // leaves the host. A webhook this installation cannot serve is not a success to
    // register and then report.
    const secret = this.deps.webhookSecret();
    if (!this.deps.webhookEnabled() || secret.length < WEBHOOK_SECRET_MIN_LENGTH) {
      throw errors.preconditionFailed(
        BOT_ERROR_CODES.BOT_WEBHOOK_ROUTE_UNAVAILABLE,
        'This installation does not serve the Telegram webhook route (TELEGRAM_WEBHOOK_ENABLED ' +
          'and TELEGRAM_WEBHOOK_SECRET), so no webhook it registered could work. Nothing was ' +
          'sent to Telegram and nothing was changed.',
      );
    }
    const expectedUrl = expectedWebhookUrl(record.webhookUrl, botId);
    if (expectedUrl === null) {
      throw errors.preconditionFailed(
        BOT_ERROR_CODES.BOT_WEBHOOK_ORIGIN_UNKNOWN,
        'This installation has not recorded the public address it receives Telegram updates ' +
          'on, so it cannot build the webhook URL to register. Run `botctl telegram register` ' +
          'once, then replace the token. Nothing was sent to Telegram.',
      );
    }
    if (!(await this.deps.scopeActivity.scopeIsActive(scope))) throw this.scopeInactive();

    // Step 4 — the per-bot claim. Its own short transaction, under the same session,
    // permission and scope checks as every write on this path.
    const now = this.deps.clock.now();
    const claimId = this.deps.ids.uuid();
    await runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      BOTS_TOKEN_PERMISSION,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        const taken = await this.deps.repository.claimTokenReplacement(
          scope,
          botId,
          {
            id: claimId,
            now,
            until: new Date(
              now.getTime() + tokenReplacementLeaseMs(this.deps.telegramCallTimeoutMs),
            ),
          },
          tx,
        );
        if (!taken) {
          throw errors.conflict(
            BOT_ERROR_CODES.BOT_TOKEN_REPLACEMENT_IN_PROGRESS,
            'Another replacement of this bot’s token is running. Wait for it to finish, then ' +
              'check the bot before trying again. Nothing was sent by this request.',
          );
        }
      },
    );

    let outcome: BotTokenReplacementOutcome;
    try {
      outcome = await this.replaceUnderClaim(scope, actor, {
        idempotencyKey: input.idempotencyKey,
        requestHash,
        botId,
        token,
        identity,
        secret,
        expectedUrl,
        claimId,
        previous: record,
      });
    } finally {
      // A no-op after a successful activation, which released the claim in its own
      // UPDATE; on every other exit it frees the bot for the operator's retry at once.
      await this.releaseClaim(scope, botId, claimId);
    }
    /*
     * Round P — the command menu, AFTER the token is stored and the claim released, as a
     * SEPARATE result. The webhook and the token are what "replaced" means; whether
     * Telegram keeps a bot's command list across a BotFather revocation is not established
     * (`OQ-WP13-02`'s neighbour), so the menu is re-registered with the new token — and a
     * failure here is a recoverable warning the lane retries with back-off, never a
     * replacement reported as failed for a menu. `syncNow` does not throw.
     */
    const { outcome: synced, errorCode } = await this.deps.commandSync.syncNow(scope, botId);
    return { ...outcome, commandSync: { outcome: synced, errorCode } };
  }

  /** Steps 5–9 of `replaceToken`, holding the claim. */
  private async replaceUnderClaim(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly idempotencyKey: string;
      readonly requestHash: string;
      readonly botId: BotInstanceId;
      readonly token: string;
      readonly identity: string;
      readonly secret: string;
      readonly expectedUrl: string;
      readonly claimId: string;
      readonly previous: BotManagementRecord;
    },
  ): Promise<BotTokenReplacementOutcome> {
    const { botId, token, identity, secret, expectedUrl } = input;

    // Step 5 — valid, a bot, and THIS bot. Nothing has been changed anywhere yet.
    const probe = await this.deps.telegram.identify(token);
    switch (probe.outcome) {
      case 'IDENTIFIED':
        if (probe.botId !== identity) throw this.differentBot();
        // The Bot API always sends `is_bot` for getMe, and it is always true for a token.
        // Anything else did not come from Telegram's Bot API.
        if (probe.isBot !== true) throw this.notTelegram();
        break;
      case 'REJECTED':
        throw errors.validation(
          BOT_ERROR_CODES.BOT_TOKEN_REJECTED,
          'Telegram rejected this token. Issue a new one in BotFather and try again.',
        );
      case 'NOT_TELEGRAM':
        throw this.notTelegram();
      case 'UNREACHABLE':
        throw this.unreachable();
    }

    // Step 6 — what Telegram holds now, which is what a compensation puts back.
    const prior = await this.deps.telegram.readWebhook(token);
    if (prior.outcome === 'REJECTED') {
      throw errors.validation(
        BOT_ERROR_CODES.BOT_TOKEN_REJECTED,
        'Telegram stopped accepting this token while it was being checked. Nothing was changed.',
      );
    }
    if (prior.outcome === 'UNREACHABLE') throw this.unreachable();
    const priorKind: PriorRegistration =
      prior.url === null ? 'NONE' : prior.url === expectedUrl ? 'THIS_INSTALLATION' : 'ELSEWHERE';

    // Step 7 — register. `dropPendingUpdates: false`: whatever Telegram queued while the
    // bot was silent is real customers' messages, and they are delivered, not discarded.
    const registered = await this.deps.telegram.registerWebhook({
      token,
      url: expectedUrl,
      secretToken: secret,
      dropPendingUpdates: false,
      resetAllowedUpdates: true,
    });
    if (registered.outcome === 'REFUSED') {
      // Telegram looked at the URL and said no, so nothing changed there to put back.
      throw this.replacementFailure(BOT_ERROR_CODES.BOT_WEBHOOK_REFUSED, 'PRECONDITION_FAILED', {
        message:
          'Telegram refused to register this installation’s webhook URL, so the token was not ' +
          'stored. The usual causes are a domain Telegram cannot resolve or reach over https.',
        details: {
          stage: 'SET_WEBHOOK',
          compensation: 'NOT_NEEDED',
          expectedUrl,
          actualUrl: null,
          telegramReason: telegramReasonOf(registered.detail, token),
          cause: null,
        },
      });
    }
    if (registered.outcome === 'UNREACHABLE') {
      // No answer is not "not applied": the registration may have landed. Put back.
      const compensation = await this.compensate(token, priorKind, expectedUrl);
      await this.recordIncomplete(scope, botId, 'SET_WEBHOOK', compensation);
      throw this.replacementFailure(BOT_ERROR_CODES.BOT_WEBHOOK_SETUP_FAILED, 'CONFLICT', {
        message:
          'Telegram did not confirm the webhook registration, so the token was not stored. ' +
          'Try again in a moment.',
        details: {
          stage: 'SET_WEBHOOK',
          compensation,
          expectedUrl,
          actualUrl: null,
          telegramReason: null,
          cause: null,
        },
      });
    }

    // Step 8 — read it back. Telegram's acceptance says it took the request; only the
    // registration it now reports says where updates will go.
    const after = await this.deps.telegram.readWebhook(token);
    const verified =
      after.outcome === 'READ' &&
      after.url === expectedUrl &&
      !allowedUpdatesNarrowed(after.allowedUpdates);
    if (!verified) {
      const compensation = await this.compensate(token, priorKind, expectedUrl);
      await this.recordIncomplete(scope, botId, 'VERIFY_WEBHOOK', compensation);
      throw this.replacementFailure(BOT_ERROR_CODES.BOT_WEBHOOK_VERIFICATION_FAILED, 'CONFLICT', {
        message:
          'Telegram accepted the webhook, but reading it back did not show exactly this ' +
          'installation’s URL, so the token was not stored.',
        details: {
          stage: 'VERIFY_WEBHOOK',
          compensation,
          expectedUrl,
          actualUrl:
            after.outcome === 'READ' ? shownWebhookUrl(after.url, input.previous.webhookUrl) : null,
          telegramReason: null,
          cause: null,
        },
      });
    }

    // Step 9 — activate. One transaction; everything above is proved.
    const now = this.deps.clock.now();
    try {
      return await runAuthorizedMutation(
        this.mutationDeps(),
        scope,
        actor,
        BOTS_TOKEN_PERMISSION,
        {
          action: 'bot_instance.token_replace',
          entityType: 'BotInstance',
          entityId: botId,
        },
        async (tx) => {
          await this.assertScopeActive(scope, tx);
          const locked = await this.deps.repository.lockManaged(scope, botId, tx);
          if (locked === null) throw this.notFound();
          if (locked.telegramBotId !== identity) throw this.differentBot();
          // Decided under the row lock: no other replacement can commit a token while it
          // is held, so a fresh read is final.
          const tokenChanged = !(await this.sameAsStored(scope, botId, token));
          const activated = await this.deps.repository.activateTokenReplacement(
            scope,
            botId,
            {
              claimId: input.claimId,
              token: tokenChanged ? token : null,
              telegramBotId: identity,
              username: probe.username,
              webhookUrl: expectedUrl,
              webhookSecretFingerprint: webhookSecretFingerprint(secret),
              now,
            },
            tx,
          );
          if (!activated) {
            throw errors.conflict(
              BOT_ERROR_CODES.BOT_TOKEN_REPLACEMENT_IN_PROGRESS,
              'This replacement’s hold on the bot lapsed and another one took it over.',
            );
          }
          await this.deps.audit.record(
            scope,
            actor,
            {
              action: tokenChanged
                ? 'bot_instance.token_replace'
                : 'bot_instance.webhook_registered',
              entityType: 'BotInstance',
              entityId: botId,
              before: {
                username: input.previous.username,
                webhookUrl: input.previous.webhookUrl,
              },
              // The identity and the registration that were proved, and never the value.
              // The audit writer would redact a key containing `token` anyway; this never
              // gives it one to redact.
              after: {
                telegramBotId: identity,
                username: probe.username,
                webhookUrl: expectedUrl,
                credentialChanged: tokenChanged,
                verifiedBy: ['getMe', 'setWebhook', 'getWebhookInfo'],
              },
              result: 'SUCCESS',
            },
            tx,
          );
          // Closes an earlier attempt's open "did not complete" event for this bot.
          await this.deps.opsLog.record(
            scope,
            {
              code: TOKEN_REPLACEMENT_COMPLETED_CODE,
              severity: 'INFO',
              message:
                'The bot’s Telegram token and webhook were verified with Telegram and stored.',
              recoversCode: TOKEN_REPLACEMENT_INCOMPLETE_CODE,
              recoversDedupeKey: incompleteKey(botId),
              context: { botInstanceId: botId, credentialChanged: tokenChanged },
            },
            tx,
          );
          // Round P: queued in the storing transaction, so a process that dies before the
          // sync below runs leaves a due row the worker's lane picks up.
          await this.deps.commandSync.requestSync(scope, botId, { due: true }, tx);
          return this.rememberReplacement(
            scope,
            input.idempotencyKey,
            input.requestHash,
            botId,
            tokenChanged,
            (current) => this.diagnosticOf(current, now, probe, after, expectedUrl),
            tx,
          );
        },
      );
    } catch (error) {
      /*
       * An error here does not prove nothing committed: a COMMIT that landed and whose
       * acknowledgement was lost throws exactly like one that did not. Compensating then
       * would delete a verified webhook for a token that WAS stored. So the durable
       * outcome is read first — the idempotency record is written in the activating
       * transaction, so it exists if and only if that transaction committed. Committed:
       * that is the answer, and nothing is undone. Unknowable: nothing destructive is run
       * on a guess; the compensation is reported FAILED and the operational event says so.
       */
      const durable = await this.durableOutcome(scope, input.idempotencyKey, input.requestHash);
      if (durable.state === 'COMMITTED') return durable.outcome;
      const compensation =
        durable.state === 'UNKNOWN'
          ? ('FAILED' as const)
          : await this.compensate(token, priorKind, expectedUrl);
      await this.recordIncomplete(scope, botId, 'ACTIVATE', compensation);
      throw this.replacementFailure(BOT_ERROR_CODES.BOT_TOKEN_ACTIVATION_FAILED, 'CONFLICT', {
        message:
          'The webhook was verified, but storing the new token did not complete, so it was not ' +
          'stored. Submit the same token again.',
        details: {
          stage: 'ACTIVATE',
          compensation,
          expectedUrl,
          actualUrl: expectedUrl,
          telegramReason: null,
          cause: isNexaError(error) ? error.code : null,
        },
        cause: error,
      });
    }
  }

  /** Whether a replacement's activation committed, read from its idempotency record. */
  private async durableOutcome(
    scope: TenantContext,
    idempotencyKey: string,
    requestHash: string,
  ): Promise<
    | { readonly state: 'COMMITTED'; readonly outcome: BotTokenReplacementOutcome }
    | { readonly state: 'NOT_COMMITTED' }
    | { readonly state: 'UNKNOWN' }
  > {
    try {
      const outcome = await this.replayReplacement(scope, idempotencyKey, requestHash);
      return outcome === null ? { state: 'NOT_COMMITTED' } : { state: 'COMMITTED', outcome };
    } catch (error) {
      // The read failed, so whether the activation committed cannot be established.
      void error;
      return { state: 'UNKNOWN' };
    }
  }

  /**
   * Put Telegram back as far as it CAN be put back, after a replacement that asked it to
   * change and then did not complete. Never throws; answers what was done.
   *
   *  - Prior registration was this installation's own URL: the URL is what it was, so
   *    there is nothing to undo (`NOT_NEEDED`).
   *  - Otherwise the webhook is REMOVED, and only if it is still the one this attempt set
   *    (compare, then delete — a registration somebody made meanwhile is left alone,
   *    `SUPERSEDED`). A bot that had no webhook has none again (`RESTORED`). A bot that
   *    was registered elsewhere cannot have that put back — Telegram never reveals the
   *    secret it was made with — so it too is left with none (`HELD`): Telegram holds the
   *    updates for up to a day, instead of delivering them to an installation whose stored
   *    token could not answer them.
   *  - Anything that cannot be done or confirmed is `FAILED`, and the operational event
   *    says so.
   *
   * With the NEW token: it is the credential Telegram just accepted, and a webhook belongs
   * to the bot, not to a token.
   */
  private async compensate(
    token: string,
    prior: PriorRegistration,
    expectedUrl: string,
  ): Promise<BotWebhookCompensation> {
    if (prior === 'THIS_INSTALLATION') return 'NOT_NEEDED';
    const restoredAs: BotWebhookCompensation = prior === 'NONE' ? 'RESTORED' : 'HELD';
    const current = await this.deps.telegram.readWebhook(token);
    if (current.outcome !== 'READ') return 'FAILED';
    if (current.url === null) return restoredAs;
    if (current.url !== expectedUrl) return 'SUPERSEDED';
    const removed = await this.deps.telegram.removeWebhook(token);
    if (removed.outcome === 'REMOVED') return restoredAs;
    // No answer may still have landed: ask rather than assume either way.
    const check = await this.deps.telegram.readWebhook(token);
    return check.outcome === 'READ' && check.url === null ? restoredAs : 'FAILED';
  }

  /**
   * The operational event a replacement that did not complete leaves behind: WHICH bot,
   * the stage, and what compensation did. Never the token or any URL. Deduplicated per
   * bot, and closed by the next replacement that completes.
   *
   * Written outside any transaction, and a failure to write it is swallowed on purpose:
   * the caller is about to report the replacement's own failure, which is the error the
   * operator must see, and a failed log write must not replace it with a different one.
   */
  private async recordIncomplete(
    scope: TenantContext,
    botId: BotInstanceId,
    stage: BotReplacementStage,
    compensation: BotWebhookCompensation,
  ): Promise<void> {
    try {
      await this.deps.opsLog.record(scope, {
        code: TOKEN_REPLACEMENT_INCOMPLETE_CODE,
        severity: compensation === 'FAILED' ? 'ERROR' : 'WARN',
        message:
          compensation === 'FAILED'
            ? 'A bot token replacement did not complete, and Telegram could not be put back as ' +
              'it was. Check the bot in the Web Admin and replace the token again.'
            : 'A bot token replacement did not complete; the token was not stored and Telegram ' +
              'was put back as far as possible. Replace the token again.',
        dedupeKey: incompleteKey(botId),
        context: { botInstanceId: botId, stage, compensation },
      });
    } catch (error) {
      // Deliberately not rethrown — see the docblock. Kept visible to a debugger.
      void error;
    }
  }

  /** Frees the claim if it is still this attempt's. A lapse is the fallback, never a leak. */
  private async releaseClaim(
    scope: TenantContext,
    botId: BotInstanceId,
    claimId: string,
  ): Promise<void> {
    try {
      // Not a business write: it only undoes this request's own claim, and it must run
      // even for a scope stopped meanwhile, or the bot stays claimed until the lease ends.
      await this.deps.uow.run(scope, (tx) =>
        this.deps.repository.releaseTokenReplacement(scope, botId, claimId, tx),
      );
    } catch (error) {
      // The lease lapses on its own; the replacement's own outcome is what is reported.
      void error;
    }
  }

  private replacementFailure(
    code: string,
    kind: 'PRECONDITION_FAILED' | 'CONFLICT',
    input: {
      readonly message: string;
      readonly details: BotReplacementFailureDetails;
      readonly cause?: unknown;
    },
  ): NexaError {
    /*
     * A 4xx kind on purpose, for all four: the error filter strips `details` from a 5xx,
     * and the details — the stage, what was undone, the URL expected and the one found —
     * are what the operator acts on. CONFLICT (409) says "the state did not end where it
     * must"; each is marked retryable except Telegram's refusal of the URL itself.
     */
    return new NexaError({
      kind,
      code,
      message: input.message,
      details: { ...input.details },
      retryable: kind === 'CONFLICT',
      ...(input.cause === undefined ? {} : { cause: input.cause }),
    });
  }

  /**
   * Ask Telegram what it holds for this bot (D5, R4). A read, stored nowhere.
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
   * R4 added the exact comparison: the URL this installation registers for this bot is
   * computed and set beside the one Telegram holds, and `verdict` answers "can it receive
   * an update now" from both and from this process's configuration.
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
    const webhook =
      probe.outcome === 'IDENTIFIED' ? await this.deps.telegram.readWebhook(token) : null;
    return this.diagnosticOf(
      record,
      checkedAt,
      probe,
      webhook,
      expectedWebhookUrl(record.webhookUrl, botId),
    );
  }

  /**
   * One diagnostic, from one `getMe` answer and one `getWebhookInfo` answer — the live
   * check's and the replacement's verification alike, so the two cannot disagree about
   * what "ready" means.
   */
  private diagnosticOf(
    record: BotManagementRecord,
    checkedAt: Date,
    probe: BotIdentityProbe,
    webhook: BotWebhookRead | null,
    expectedUrl: string | null,
  ): BotDiagnostic {
    const identified = probe.outcome === 'IDENTIFIED' ? probe : null;
    const read = webhook !== null && webhook.outcome === 'READ' ? webhook : null;
    const problems = liveProblems({
      webhookRouteEnabled: this.deps.webhookEnabled(),
      tenantActive: record.tenant.status === 'ACTIVE',
      botStatus: record.status,
      secret: webhookSecretState(record.webhookSecretMatches, this.deps.webhookSecret() !== ''),
      identified: identified !== null,
      isBot: identified?.isBot ?? null,
      sameBot:
        identified === null || record.telegramBotId === null
          ? null
          : identified.botId === record.telegramBotId,
      webhook:
        read === null
          ? null
          : { url: read.url, narrowed: allowedUpdatesNarrowed(read.allowedUpdates) },
      expectedUrl,
    });
    const empty = {
      url: null,
      urlMatchesRecorded: null,
      pendingUpdateCount: null,
      lastErrorAt: null,
      lastErrorMessage: null,
      maxConnections: null,
      expectedUrl,
      matchesExpected: null,
    };
    return {
      botInstanceId: record.id,
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
          ? { outcome: 'SKIPPED', ...empty }
          : read !== null
            ? {
                outcome: 'READ',
                url: shownWebhookUrl(read.url, record.webhookUrl, expectedUrl),
                urlMatchesRecorded:
                  record.webhookUrl === null ? null : read.url === record.webhookUrl,
                pendingUpdateCount: read.pendingUpdateCount,
                lastErrorAt: read.lastErrorAt?.toISOString() ?? null,
                lastErrorMessage:
                  read.lastErrorMessage === null
                    ? null
                    : read.lastErrorMessage.slice(0, BOT_WEBHOOK_ERROR_MESSAGE_MAX),
                maxConnections: read.maxConnections,
                expectedUrl,
                matchesExpected: expectedUrl === null ? null : read.url === expectedUrl,
              }
            : { outcome: webhook.outcome, ...empty },
      verdict: { readyToReceive: problems.length === 0, problems },
    };
  }

  // -------------------------------------------------------------------------

  /** The desired command menu's digest for this tenant, read once per request. */
  private async desiredHash(scope: TenantContext, tx?: unknown): Promise<string> {
    return (await this.deps.commandMenu.desiredFor(scope, tx)).hash;
  }

  private view(record: BotManagementRecord, desiredHash: string): BotInstanceView {
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
      commandMenu: commandMenuState(record.commandsRevision, desiredHash),
      readiness: { state: readiness.state, causes: [...readiness.causes] },
    };
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

  private notTelegram(): NexaError {
    // UPSTREAM_REJECTED rather than CONFIGURATION: the latter answers 500, which would
    // read as this installation breaking rather than as the address being wrong.
    return new NexaError({
      kind: 'UPSTREAM_REJECTED',
      code: BOT_ERROR_CODES.BOT_TELEGRAM_API_INVALID,
      message:
        'The configured Telegram API address answered with something that is not a bot. ' +
        'Check TELEGRAM_API_BASE_URL.',
    });
  }

  private scopeInactive(): NexaError {
    return errors.notFound(
      PLATFORM_ERROR_CODES.TENANT_NOT_FOUND,
      'This scope is not accepting work.',
    );
  }

  /** `replay`, keeping the verification a replacement stored beside its answer. */
  private async replayReplacement(
    scope: TenantContext,
    idempotencyKey: string,
    requestHash: string,
  ): Promise<BotTokenReplacementOutcome | null> {
    const found = await this.deps.idempotency.find<MutationResult>(
      scope,
      'WEB',
      idempotencyKey,
      requestHash,
    );
    if (found === null) return null;
    const { bot, installation, changed, verification } = found.result;
    return { bot, installation, changed, verification: verification ?? null, commandSync: null };
  }

  /**
   * `remember`, for a token replacement: the view AND the verification, built from the row
   * as this transaction leaves it, stored as one snapshot so a replay answers both.
   */
  private async rememberReplacement(
    scope: TenantContext,
    idempotencyKey: string,
    requestHash: string,
    botId: BotInstanceId,
    changed: boolean,
    verificationOf: (record: BotManagementRecord) => BotDiagnostic,
    tx: TransactionScope,
  ): Promise<BotTokenReplacementOutcome> {
    const record = await this.deps.repository.findManaged(
      scope,
      botId,
      this.currentFingerprint(),
      tx,
    );
    if (record === null) throw this.notFound();
    const outcome: BotTokenReplacementOutcome = {
      bot: this.view(record, await this.desiredHash(scope, tx)),
      installation: this.installation(),
      changed,
      verification: verificationOf(record),
      // The sync runs AFTER this transaction commits, so a replay cannot carry its result.
      commandSync: null,
    };
    await rememberOnce(
      this.deps.idempotency,
      scope,
      'WEB',
      idempotencyKey,
      requestHash,
      { botId, ...outcome } satisfies MutationResult,
      tx,
    );
    return outcome;
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
    const { bot, installation, changed } = found.result;
    return { bot, installation, changed };
  }

  private async remember(
    scope: TenantContext,
    idempotencyKey: string,
    requestHash: string,
    botId: BotInstanceId,
    changed: boolean,
    tx: TransactionScope,
  ): Promise<BotMutationOutcome> {
    // The bot as THIS transaction leaves it, read inside it: the response and the replay
    // are one snapshot, and neither can show a state a later command produced. Read
    // WITHOUT charging `settings.view`: the caller was just authorized for something
    // stronger, and a custom role holding `settings.edit` without the view key must not
    // have its committed stop answered with a 403.
    const record = await this.deps.repository.findManaged(
      scope,
      botId,
      this.currentFingerprint(),
      tx,
    );
    if (record === null) throw this.notFound();
    const outcome: BotMutationOutcome = {
      bot: this.view(record, await this.desiredHash(scope, tx)),
      installation: this.installation(),
      changed,
    };
    await rememberOnce(
      this.deps.idempotency,
      scope,
      'WEB',
      idempotencyKey,
      requestHash,
      { botId, ...outcome } satisfies MutationResult,
      tx,
    );
    return outcome;
  }

  private async assertScopeActive(scope: TenantContext, tx: TransactionScope): Promise<void> {
    if (await this.deps.scopeActivity.scopeIsActive(scope, tx)) return;
    // The answer `PanelService` gives: a scope that stopped accepting work is not a scope
    // this request can act in, and saying which part of it stopped is not this path's job.
    throw this.scopeInactive();
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

/**
 * The webhook URL Telegram holds, as far as it may be shown.
 *
 * In full only when it is the one this installation recorded registering, or the one it
 * would register now (R4's `expected`) — those URLs are ours and carry no secret. Anything
 * else is somebody else's registration (a legacy install, another system, a bot pointed
 * elsewhere), and the common shapes of those put the bot token or a webhook secret in the
 * PATH: `https://host/<token>`. The check is open to `settings.edit`, which may not read a
 * token, so a foreign URL is cut to its origin.
 */
export function shownWebhookUrl(
  held: string | null,
  recorded: string | null,
  expected: string | null = null,
): string | null {
  if (held === null) return null;
  if (recorded !== null && held === recorded) return held;
  if (expected !== null && held === expected) return held;
  try {
    const origin = new URL(held).origin;
    return origin === 'null' ? null : `${origin}/…`;
  } catch {
    return null;
  }
}
