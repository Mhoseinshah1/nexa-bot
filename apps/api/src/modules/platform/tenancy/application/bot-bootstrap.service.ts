import {
  errors,
  NexaError,
  PLATFORM_ERROR_CODES,
  systemJobActor,
  type ActorContext,
  type AuditWriter,
  type BotInstanceId,
  type Clock,
  type CorrelationId,
  type IdGenerator,
  type ScopeContext,
  type TenantContext,
  type UnitOfWork,
} from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { ScopeActivityReader } from '../../system/application/record-ping.service.js';
import type {
  BotBootstrapRepository,
  BotBootstrapTelegram,
  BotBootstrapView,
  BotInstanceRepository,
  WebhookRegistration,
} from './ports.js';

/** The identity `getMe` reported, once the probe outcome has been unwrapped. */
interface BotIdentity {
  readonly botId: string;
  readonly username: string;
}

/**
 * What the installer asks before it decides whether to prompt.
 *
 *  - `none`       — no bot instance. Prompt for a token and create one.
 *  - `incomplete` — a bot instance exists and its webhook is not registered, or
 *                   is registered at a different URL. Rerun to finish; do NOT
 *                   prompt, the token is already stored.
 *  - `ready`      — the bot exists and Telegram is delivering to this
 *                   installation's own webhook URL. Nothing to do.
 *
 * Three values rather than two, for the reason `BootstrapStatus` has three: "a
 * bot instance exists, therefore the bootstrap succeeded" is exactly the
 * reasoning that lets an installer announce a working bot that has never been
 * told where to send anything.
 */
export type BotBootstrapStatus = 'none' | 'incomplete' | 'ready';

export interface BotBootstrapInput {
  /**
   * The token, and ONLY used when no bot instance exists yet.
   *
   * On a reconcile it is ignored rather than applied — see `execute`. Null when
   * the caller determined through `status` that none was needed.
   */
  readonly token: string | null;
  /**
   * The installation's public origin, e.g. `https://bot.example.com`.
   *
   * The origin, not the full webhook URL: the path carries the bot instance id,
   * which does not exist until the row does. Composing it in one place is what
   * keeps the registered URL and the served route from drifting apart.
   */
  readonly publicBaseUrl: string;
}

export type BotBootstrapOutcomeKind =
  /** The row did not exist and now does, with its webhook registered. */
  | 'CREATED'
  /** The row existed; this run registered or re-registered the webhook. */
  | 'RECONCILED'
  /** The row existed and Telegram was already pointed here. Nothing was done. */
  | 'ALREADY_COMPLETE';

export interface BotBootstrapResult {
  readonly kind: BotBootstrapOutcomeKind;
  readonly botInstanceId: BotInstanceId;
  readonly username: string;
  readonly telegramBotId: string;
  readonly webhookUrl: string;
}

export interface BotBootstrapDeps {
  readonly uow: UnitOfWork<TransactionScope>;
  readonly bots: BotBootstrapRepository & Pick<BotInstanceRepository, 'resolveToken'>;
  readonly scopeActivity: ScopeActivityReader;
  readonly audit: AuditWriter;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly telegram: BotBootstrapTelegram;
  /**
   * The installation-wide webhook secret, read at the moment it is needed.
   *
   * A getter rather than a value because the installer mints the secret and
   * starts the stack in the same run: a container composed from a config object
   * read before that would register a webhook signed with a secret this
   * installation does not hold, and every update would be refused by the route
   * that checks it.
   */
  readonly webhookSecret: () => string;
}

/**
 * The fresh-install Telegram bootstrap: create-or-reconcile, never rotate.
 *
 * PROVISIONING, not a request — the same shape as `BootstrapOwnerService` and
 * fenced the same way. There is no caller to authorize: whoever runs it already
 * holds the database credentials, and `scripts/check-boundaries.sh` fails the
 * build if a surface imports it. Exposed over HTTP it would be an
 * unauthenticated route that accepts a bot token.
 *
 * ADR-0029 is the decision record. Four of its rules are load-bearing here and
 * each one is a way to produce something that looks like a configured bot and is
 * not:
 *
 *  1. `getMe` runs BEFORE a brand-new token is persisted. A stored credential
 *     that has never worked is indistinguishable from one that stopped working,
 *     and an operator debugging the second would be looking in the wrong place.
 *  2. A rerun RECONCILES. It never asks for a token, never rotates one, never
 *     re-encrypts one. The repository has no method that could.
 *  3. Both Telegram calls happen OUTSIDE the transaction. They are made through
 *     the `BotBootstrapTelegram` port, whose adapter goes through the shared
 *     call core, which asserts it — so a call cannot be rolled back after
 *     Telegram acted on it, and a slow Telegram cannot hold a database
 *     transaction open while the connection pool waits.
 *  4. `webhook_registered_at` is written AFTER Telegram accepted, so a crash on
 *     either side of the call leaves the same recoverable state, and the install
 *     does not report success until the bot can actually receive an update.
 */
export class BotBootstrapService {
  constructor(private readonly deps: BotBootstrapDeps) {}

  /**
   * Read-only, and the thing that stops the installer prompting twice.
   *
   * It creates nothing and it is not a way in. The question it answers is not
   * "is there a bot" but "can that bot receive an update", which is the only
   * version an installer may act on.
   */
  async status(scope: TenantContext, publicBaseUrl: string): Promise<BotBootstrapStatus> {
    const existing = await this.deps.bots.findBootstrapTarget(scope);
    if (existing === null) return 'none';
    // Normalised through the SAME function `execute` uses, so a trailing slash
    // in the configured origin cannot make `status` report `incomplete` for a
    // webhook `execute` would then find already registered — an installer that
    // re-registers on every rerun, discarding queued updates each time.
    const url = this.webhookUrlFor(this.requireOrigin(publicBaseUrl), existing.id);
    return existing.webhookRegisteredAt !== null && existing.webhookUrl === url
      ? 'ready'
      : 'incomplete';
  }

  async execute(scope: TenantContext, input: BotBootstrapInput): Promise<BotBootstrapResult> {
    // Validated before anything else, because a bad origin would otherwise be
    // discovered only after a token had been sent to Telegram and a row written.
    const origin = this.requireOrigin(input.publicBaseUrl);

    const ensured = await this.ensureBotInstance(scope, input.token);
    const view = ensured.view;
    const url = this.webhookUrlFor(origin, view.id);

    // The token comes from the ROW, never from the input, even on the run that
    // just created it. One source, so the reconcile path and the create path
    // cannot diverge in what they register — and a token that cannot be
    // decrypted is discovered here rather than on the first customer message.
    const token = await this.deps.bots.resolveToken(scope, view.id);

    /*
     * `getMe` on EVERY run, including one with nothing left to do.
     *
     * ADR-0029 decision 3: if the stored token has since been revoked, the
     * installer reports an explicit configuration problem naming the token. It
     * can only do that by asking. Skipping the call when the local state looked
     * finished would let a rerun announce a ready installation whose bot cannot
     * authenticate a single call — which is the same silent success as reporting
     * a registered webhook that was never registered, arrived at from the other
     * side.
     */
    const identity = ensured.identity ?? (await this.getMe(scope, view, token));

    /*
     * Already pointed here: register nothing, and say so.
     *
     * Not "register it again to be sure". A `setWebhook` on every rerun would
     * make `drop_pending_updates` discard whatever Telegram had queued for a
     * RUNNING installation — updates belonging to real customers, thrown away by
     * an installer somebody ran to fix something unrelated.
     */
    if (!ensured.createdNow && view.webhookRegisteredAt !== null && view.webhookUrl === url) {
      return {
        kind: 'ALREADY_COMPLETE',
        botInstanceId: view.id,
        username: identity.username,
        telegramBotId: identity.botId,
        webhookUrl: url,
      };
    }

    const registered = await this.deps.telegram.registerWebhook({
      token,
      url,
      secretToken: this.requireWebhookSecret(),
    });
    if (registered.outcome !== 'REGISTERED') {
      /*
       * Nothing is rolled back. ADR-0029 decision 4: the tenant, the owner, the
       * validated token and the row are all correct and expensive to produce,
       * and a DNS record that has not propagated is no reason to destroy them.
       *
       * The install still fails. `webhook_registered_at` stays NULL, `status`
       * keeps answering `incomplete`, and the rerun resumes from the stored
       * token without asking for it.
       */
      throw this.webhookFailure(registered);
    }

    const now = this.deps.clock.now();
    const actor = this.systemActor();
    await this.deps.uow.run(scope, async (tx) => {
      await this.deps.bots.lockTenantForBotChange(scope, tx);
      await this.requireActiveScope(scope, tx);
      await this.deps.bots.markWebhookRegistered(scope, view.id, { url, now }, tx);
      await this.deps.audit.record(
        scope,
        actor,
        {
          action: 'bot_instance.webhook_registered',
          entityType: 'BotInstance',
          entityId: view.id,
          before: { webhookUrl: view.webhookUrl },
          after: { webhookUrl: url },
          reason: 'Installation bootstrap: Telegram webhook registration.',
          result: 'SUCCESS',
        },
        tx,
      );
    });

    return {
      kind: ensured.createdNow ? 'CREATED' : 'RECONCILED',
      botInstanceId: view.id,
      username: identity.username,
      telegramBotId: identity.botId,
      webhookUrl: url,
    };
  }

  /**
   * The create-or-reconcile half. Returns the row the webhook step operates on.
   *
   * `identity` is present only when this call already asked Telegram — on the
   * create path, where `getMe` must precede the write. The caller does not ask
   * twice.
   */
  private async ensureBotInstance(
    scope: TenantContext,
    suppliedToken: string | null,
  ): Promise<{
    readonly view: BotBootstrapView;
    readonly createdNow: boolean;
    readonly identity: BotIdentity | null;
  }> {
    const existing = await this.deps.bots.findBootstrapTarget(scope);
    if (existing !== null) {
      this.refuseRepointing(existing, suppliedToken);
      return { view: existing, createdNow: false, identity: null };
    }

    const token = this.requireToken(suppliedToken);

    /*
     * `getMe` FIRST, outside any transaction, before a single byte is written.
     *
     * This is the one ordering rule the whole create path exists to obey: the
     * token is proved to work and asked WHICH bot it belongs to, and only an
     * answered token is encrypted and stored.
     */
    const identity = await this.getMe(scope, null, token);

    const id = this.deps.ids.uuid() as BotInstanceId;
    const now = this.deps.clock.now();
    const actor = this.systemActor();

    return await this.deps.uow.run(scope, async (tx) => {
      // The lock FIRST, then the activity check. `scopeIsActive` takes a SHARE
      // lock on the same tenant row; taking the shared one first and then
      // upgrading is how two installers deadlock instead of queueing.
      await this.deps.bots.lockTenantForBotChange(scope, tx);
      await this.requireActiveScope(scope, tx);

      /*
       * Re-read under the lock. Two installers on one fresh install both find
       * nothing, and this is where the loser notices.
       *
       * The loser RECONCILES the winner's row rather than failing: it is the
       * same installation, the row is correct, and a benign race must not fail
       * an install. Note it does not matter whether the two operators typed the
       * same token — the winner's row is this installation's bot, and the loser
       * repointing it is the exact thing decision 3 forbids.
       */
      const raced = await this.deps.bots.findBootstrapTarget(scope, tx);
      if (raced !== null) {
        this.refuseRepointing(raced, suppliedToken);
        return { view: raced, createdNow: false, identity: null };
      }

      await this.deps.bots.createFromBootstrap(
        scope,
        { id, username: identity.username, telegramBotId: identity.botId, token, now },
        tx,
      );

      await this.deps.audit.record(
        scope,
        actor,
        {
          action: 'bot_instance.bootstrap',
          entityType: 'BotInstance',
          entityId: id,
          before: null,
          // The identity, never the credential. `after` holds VALUES, and this
          // one is read by whoever is working out what the installation is
          // bound to.
          after: { username: identity.username, telegramBotId: identity.botId },
          reason: 'Installation bootstrap: first bot instance.',
          result: 'SUCCESS',
        },
        tx,
      );

      return {
        view: {
          id,
          username: identity.username,
          status: 'ACTIVE' as const,
          telegramBotId: identity.botId,
          webhookRegisteredAt: null,
          webhookUrl: null,
        },
        createdNow: true,
        identity,
      };
    });
  }

  /**
   * Ask Telegram who a token belongs to, and hold the answer against the row.
   *
   * `existing` is null on the create path, where there is nothing to disagree
   * with. On the reconcile path a disagreement means the stored credential no
   * longer belongs to the bot this installation is bound to, and it is reported
   * rather than adopted: every stored `telegram_user_id` and `chat_id` belongs
   * to the old bot.
   *
   * A row whose `telegram_bot_id` is NULL predates the column. It is FILLED from
   * Telegram's answer — never from anything an operator typed — which is a
   * different act from rewriting one that is already set, and the repository
   * enforces the difference in its WHERE clause rather than trusting this.
   */
  private async getMe(
    scope: TenantContext,
    existing: BotBootstrapView | null,
    token: string,
  ): Promise<BotIdentity> {
    const probe = await this.deps.telegram.identify(token);

    if (probe.outcome === 'REJECTED') {
      throw errors.configuration(
        PLATFORM_ERROR_CODES.TELEGRAM_BOOTSTRAP_TOKEN_REJECTED,
        `Telegram rejected the bot token: ${probe.detail}. ` +
          'Issue a new token in BotFather. The installer does not replace a stored token by ' +
          'itself — that is a deliberate, separate operator action.',
      );
    }
    if (probe.outcome !== 'IDENTIFIED') {
      throw new NexaError({
        kind: 'UPSTREAM_UNAVAILABLE',
        code: PLATFORM_ERROR_CODES.TELEGRAM_BOOTSTRAP_UNREACHABLE,
        message: `Telegram could not be reached: ${probe.detail}. Rerun the installer.`,
      });
    }

    const identity: BotIdentity = { botId: probe.botId, username: probe.username };

    if (existing !== null && existing.telegramBotId !== null) {
      if (existing.telegramBotId !== identity.botId) {
        throw errors.configuration(
          PLATFORM_ERROR_CODES.TELEGRAM_BOOTSTRAP_DIFFERENT_BOT,
          `The stored token now belongs to bot ${identity.botId}, but this installation is ` +
            `bound to bot ${existing.telegramBotId}. Nothing was changed: repointing would leave ` +
            'every stored Telegram user and chat attached to a bot that has never spoken to them.',
        );
      }
      return identity;
    }

    if (existing !== null) {
      const now = this.deps.clock.now();
      const actor = this.systemActor();
      await this.deps.uow.run(scope, async (tx) => {
        await this.deps.bots.lockTenantForBotChange(scope, tx);
        await this.requireActiveScope(scope, tx);
        await this.deps.bots.recordTelegramIdentity(
          scope,
          existing.id,
          { telegramBotId: identity.botId, username: identity.username, now },
          tx,
        );
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'bot_instance.identity_recorded',
            entityType: 'BotInstance',
            entityId: existing.id,
            before: { telegramBotId: null, username: existing.username },
            after: { telegramBotId: identity.botId, username: identity.username },
            reason:
              'Installation bootstrap: identity read from Telegram for a row that predates it.',
            result: 'SUCCESS',
          },
          tx,
        );
      });
    }

    return identity;
  }

  /**
   * A rerun that was handed a token for a DIFFERENT bot is refused, loudly.
   *
   * ADR-0029 decision 3 says such a token must not repoint or rotate anything.
   * Ignoring it silently would obey the letter and be the silent-success pattern
   * this codebase exists to avoid: an operator who edited their token file to
   * change bots would watch the installer print success and change nothing.
   *
   * The comparison is LOCAL and costs no network call: a Telegram bot token is
   * `<bot id>:<secret>`, so the part before the colon is the identity the token
   * claims. It is used only ever to REFUSE. The identity that gets recorded
   * still comes from `getMe`, because a claim an operator typed is not evidence.
   *
   * A token for the SAME bot with a different secret half is a rotation, and is
   * neither refused nor applied: the stored credential is used, and the outcome
   * says the run reconciled rather than changed anything.
   */
  private refuseRepointing(existing: BotBootstrapView, suppliedToken: string | null): void {
    if (suppliedToken === null || existing.telegramBotId === null) return;
    const claimed = suppliedToken.trim().split(':')[0] ?? '';
    if (claimed === '' || claimed === existing.telegramBotId) return;
    throw errors.configuration(
      PLATFORM_ERROR_CODES.TELEGRAM_BOOTSTRAP_DIFFERENT_BOT,
      `The supplied token belongs to bot ${claimed}, and this installation is bound to bot ` +
        `${existing.telegramBotId}. Nothing was changed. An installer rerun reconciles; it never ` +
        'repoints an installation at another bot, because every stored Telegram user and chat ' +
        'belongs to the one it already has.',
    );
  }

  /**
   * One code, two kinds, and the split is the remedy rather than tidiness.
   *
   * A timeout or a 5xx is waited out and rerun; a 4xx is Telegram telling the
   * operator the URL itself is wrong — not https, not resolvable, a port it does
   * not accept — and no amount of waiting fixes it.
   */
  private webhookFailure(outcome: Exclude<WebhookRegistration, { outcome: 'REGISTERED' }>): Error {
    const detail =
      `Telegram did not register the webhook: ${outcome.detail}. The bot instance and its ` +
      'encrypted token are stored and correct; rerun the installer to retry the registration. ' +
      'It will not ask for the token again.';
    if (outcome.outcome === 'REFUSED') {
      return errors.configuration(PLATFORM_ERROR_CODES.TELEGRAM_BOOTSTRAP_WEBHOOK_FAILED, detail);
    }
    return new NexaError({
      kind: 'UPSTREAM_UNAVAILABLE',
      code: PLATFORM_ERROR_CODES.TELEGRAM_BOOTSTRAP_WEBHOOK_FAILED,
      message: detail,
    });
  }

  /**
   * `https://<origin>/telegram/webhook/<bot instance id>` — composed once.
   *
   * The path is the route `TelegramWebhookController` actually serves. Composing
   * it here rather than accepting a full URL is what makes "the URL Telegram was
   * given" and "the URL this installation answers on" the same statement.
   */
  private webhookUrlFor(origin: string, botInstanceId: BotInstanceId): string {
    return `${origin}/telegram/webhook/${botInstanceId}`;
  }

  private requireOrigin(publicBaseUrl: string): string {
    let parsed: URL;
    try {
      parsed = new URL(publicBaseUrl.trim());
    } catch {
      throw errors.configuration(
        PLATFORM_ERROR_CODES.CONFIG_INVALID,
        `"${publicBaseUrl}" is not a URL. The Telegram webhook needs this installation's public ` +
          'origin, for example https://bot.example.com.',
      );
    }
    // Telegram refuses a plain-http webhook outright, and would refuse it AFTER
    // the token had been sent and the row written. Refused here instead, with
    // the reason.
    if (parsed.protocol !== 'https:') {
      throw errors.configuration(
        PLATFORM_ERROR_CODES.CONFIG_INVALID,
        `The Telegram webhook must be https; "${publicBaseUrl}" is not. Telegram will not deliver ` +
          'updates to a plain-http endpoint.',
      );
    }
    // The ORIGIN only. A trailing path would be silently concatenated into a URL
    // nothing serves, and the install would report success on a bot whose
    // updates go to a 404.
    if (parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') {
      throw errors.configuration(
        PLATFORM_ERROR_CODES.CONFIG_INVALID,
        `"${publicBaseUrl}" carries a path, query or fragment. The bootstrap needs the origin ` +
          'alone; it appends the webhook path itself so the registered URL and the served route ' +
          'cannot drift apart.',
      );
    }
    return parsed.origin;
  }

  /**
   * Shape-checked locally before it is sent anywhere.
   *
   * Deliberately minimal: a colon, no whitespace, something on each side. It
   * catches the empty prompt and the pasted-with-a-newline cases without
   * pretending to know the exact alphabet Telegram issues — `getMe` is the
   * authority on whether a token is real, and a local rule that guessed wrong
   * would reject a valid token with no way round it.
   */
  private requireToken(supplied: string | null): string {
    const token = (supplied ?? '').trim();
    const colon = token.indexOf(':');
    if (token === '' || colon <= 0 || colon === token.length - 1 || /\s/.test(token)) {
      throw errors.configuration(
        PLATFORM_ERROR_CODES.TELEGRAM_BOOTSTRAP_TOKEN_REJECTED,
        'No usable bot token was supplied. A Telegram bot token looks like ' +
          '"<bot id>:<secret>" and comes from BotFather.',
      );
    }
    return token;
  }

  /**
   * The webhook secret every later update is authenticated by.
   *
   * Installation-wide configuration rather than a column — ADR-0029 decision 2.
   * Read through a constructor-injected getter rather than captured at
   * construction so that a container built before the secret was minted cannot
   * register a webhook Telegram will sign with a value this installation does
   * not hold.
   */
  private requireWebhookSecret(): string {
    const secret = this.deps.webhookSecret();
    if (secret.length < 16) {
      throw errors.configuration(
        PLATFORM_ERROR_CODES.CONFIG_INVALID,
        'TELEGRAM_WEBHOOK_SECRET is unset or too short. Telegram signs every update with it, and ' +
          'the webhook route rejects an update that does not carry it — so registering without ' +
          'one would produce a bot whose every message is refused.',
      );
    }
    return secret;
  }

  private async requireActiveScope(scope: ScopeContext, tx: TransactionScope): Promise<void> {
    if (await this.deps.scopeActivity.scopeIsActive(scope, tx)) return;
    throw errors.notFound(
      PLATFORM_ERROR_CODES.TENANT_NOT_FOUND,
      'This scope is not accepting work.',
    );
  }

  private systemActor(): ActorContext {
    return systemJobActor('install:bootstrap-bot', this.deps.ids.uuid() as CorrelationId);
  }
}
