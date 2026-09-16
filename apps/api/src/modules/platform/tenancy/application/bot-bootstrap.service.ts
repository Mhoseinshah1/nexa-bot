import { createHash } from 'node:crypto';
import {
  BOT_COMMANDS,
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

/**
 * The one-way digest stored beside a webhook registration.
 *
 * SHA-256 hex of the secret, and nothing reads it back: the only question asked
 * of it is "is this the same secret as the one that was registered". A stored
 * plaintext would be a second copy of a credential that lives in exactly one
 * file today.
 */
function fingerprintOf(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

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
 *  - `ready`      — the bot exists, is ACTIVE, and Telegram is delivering to
 *                   this installation's own webhook URL with the secret this
 *                   installation currently holds. Nothing to do.
 *  - `unavailable` — the bot exists and something OTHER than a missing
 *                   registration stops it receiving updates. Three causes, and
 *                   each is a state in which registering a webhook would point
 *                   Telegram at an endpoint that refuses everything it delivers:
 *                   the bot instance is not ACTIVE, the tenant has stopped
 *                   accepting work, or `TELEGRAM_WEBHOOK_ENABLED` is false so
 *                   the route is not even registered. One answer rather than
 *                   three, because the operator action has one shape — fix the
 *                   thing, then rerun — and `execute` names WHICH. Folding any
 *                   of them into `ready` is how an installation reports a bot
 *                   that is receiving updates while every delivery 404s.
 *
 * Four values rather than one boolean, for the reason `BootstrapStatus` has
 * three: "a bot instance exists, therefore the bootstrap succeeded" is exactly
 * the reasoning that lets an installer announce a working bot that has never
 * been told where to send anything. Each value here has a DIFFERENT remedy —
 * prompt, rerun, start the bot, nothing — and collapsing any two of them puts
 * an operator on the wrong one.
 */
export type BotBootstrapStatus = 'none' | 'incomplete' | 'ready' | 'unavailable';

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
   * The installation-wide webhook secret.
   *
   * A getter rather than a string for TESTABILITY and nothing more — the
   * container closes over an immutable config object read once at process
   * start, so this is observationally identical to capturing the value in the
   * constructor. An earlier version of this comment claimed the indirection
   * protected against a container composed before the secret was minted; it
   * does not, and a comment describing a mechanism the code does not have is
   * worse than no comment. What actually makes that case safe is that each CLI
   * invocation is a fresh process reading `nexa.env` as it stands.
   */
  readonly webhookSecret: () => string;
  /**
   * Whether this installation serves the webhook route at all.
   *
   * `app.module.ts` registers `TelegramWebhookController` only when
   * `TELEGRAM_WEBHOOK_ENABLED` is true. Without this, a row with a current URL
   * and fingerprint answered `ready` on an installation where every delivery
   * would 404 — the readiness question is "can this bot receive an update", and
   * the route existing is part of the answer.
   */
  readonly webhookEnabled: () => boolean;
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
    // Not a bootstrap state to converge out of — see `unavailableReason`.
    if ((await this.unavailableReason(scope, existing)) !== null) return 'unavailable';
    // Normalised through the SAME function `execute` uses, so a trailing slash
    // in the configured origin cannot make `status` report `incomplete` for a
    // webhook `execute` would then find already registered — an installer that
    // re-registers on every rerun, discarding queued updates each time.
    const url = this.webhookUrlFor(this.requireOrigin(publicBaseUrl), existing.id);
    return this.registrationIsCurrent(existing, url) ? 'ready' : 'incomplete';
  }

  /**
   * Is Telegram pointed here, with the secret this installation holds NOW?
   *
   * Both halves, because `setWebhook` carried both and the marker has to be able
   * to answer for both. Recording only the URL made a rotated
   * `TELEGRAM_WEBHOOK_SECRET` unfixable: the rotation procedure the env template
   * documents left an installation reporting itself ready while the webhook
   * route refused every update Telegram signed, `botctl telegram register`
   * answered "nothing was changed", and the only way out was SQL.
   *
   * A NULL fingerprint is "unknown", never "matches". A row written before this
   * column existed needs one registration to become knowable, and one
   * unnecessary `setWebhook` is a far cheaper mistake than a silent claim.
   */
  /**
   * Why this bot cannot receive an update, beyond a missing registration.
   *
   * Null when nothing is in the way. The three causes are checked in the order
   * an operator can act on them, and each message names the one thing to fix —
   * a single "not receiving updates" would send them looking in three places.
   *
   * `scopeIsActive` is called WITHOUT a transaction here on purpose: this is a
   * read that decides what to report, not a write that needs holding still. The
   * transactional checks inside `uow.run` are untouched, and they are the ones
   * that make a write safe.
   */
  private async unavailableReason(
    scope: TenantContext,
    view: BotBootstrapView,
  ): Promise<string | null> {
    if (!this.deps.webhookEnabled()) {
      return (
        'TELEGRAM_WEBHOOK_ENABLED is false, so this installation does not serve the webhook route ' +
        'at all. Telegram would deliver every update to a 404. Set it to true in nexa.env, ' +
        'restart, and run this again.'
      );
    }
    if (view.status !== 'ACTIVE') {
      return (
        `The bot instance for this tenant is ${view.status}, not ACTIVE. The webhook route refuses ` +
        'every update for a bot that is not active. Start the bot and run this again.'
      );
    }
    if (!(await this.deps.scopeActivity.scopeIsActive(scope))) {
      return (
        'This tenant is not accepting work, so the webhook route refuses every update for it. ' +
        'Reactivate the tenant and run this again.'
      );
    }
    return null;
  }

  private registrationIsCurrent(view: BotBootstrapView, url: string): boolean {
    if (view.webhookRegisteredAt === null || view.webhookUrl !== url) return false;
    if (view.webhookSecretFingerprint === null) return false;
    return view.webhookSecretFingerprint === fingerprintOf(this.requireWebhookSecret());
  }

  async execute(scope: TenantContext, input: BotBootstrapInput): Promise<BotBootstrapResult> {
    // Validated before anything else, because a bad origin would otherwise be
    // discovered only after a token had been sent to Telegram and a row written.
    const origin = this.requireOrigin(input.publicBaseUrl);

    const ensured = await this.ensureBotInstance(scope, input.token);
    const view = ensured.view;
    /*
     * Checked BEFORE the registration and before any ALREADY_COMPLETE, not only
     * inside the write transactions further down.
     *
     * Each of these is a state in which the webhook route refuses every update
     * Telegram delivers. Registering one — or reporting it complete — produces a
     * bot that is configured, announced as receiving updates, and silent. The
     * write-transaction checks stay: they protect the WRITE, and this protects
     * the CLAIM.
     */
    const unavailable = await this.unavailableReason(scope, view);
    if (unavailable !== null) {
      throw errors.configuration(
        PLATFORM_ERROR_CODES.TELEGRAM_BOOTSTRAP_WEBHOOK_FAILED,
        unavailable,
      );
    }
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
    const probed =
      ensured.identity === null
        ? await this.getMe(scope, view, token)
        : { identity: ensured.identity, filledLegacyIdentity: false };
    const { identity } = probed;

    /*
     * The supplied token is compared AGAIN, now that the bot's identity is known.
     *
     * `refuseRepointing` runs inside `ensureBotInstance`, against the stored row
     * — and on a row created before migration 0038 that row's `telegram_bot_id`
     * is NULL, so it returned having compared nothing. A supplied token naming a
     * DIFFERENT bot was therefore silently ignored on exactly the rows an
     * upgrade produces, and the installer printed success. `getMe` has since
     * said which bot the STORED token belongs to, which is the value the first
     * comparison did not have.
     *
     * Cheap and idempotent on every other path: on a create the supplied token
     * IS this identity, and on an ordinary reconcile the first comparison has
     * already passed or thrown.
     */
    this.refuseRepointing(
      { ...view, telegramBotId: identity.botId },
      input.token,
      probed.filledLegacyIdentity,
    );

    /*
     * Already pointed here: register nothing, and say so.
     *
     * Not "register it again to be sure". A `setWebhook` on every rerun would
     * make `drop_pending_updates` discard whatever Telegram had queued for a
     * RUNNING installation — updates belonging to real customers, thrown away by
     * an installer somebody ran to fix something unrelated.
     */
    if (!ensured.createdNow && this.registrationIsCurrent(view, url)) {
      return {
        kind: 'ALREADY_COMPLETE',
        botInstanceId: view.id,
        username: identity.username,
        telegramBotId: identity.botId,
        webhookUrl: url,
      };
    }

    /*
     * This call and the marker below are NOT one atomic step, and cannot be.
     *
     * `setWebhook` has to happen outside the transaction that records it — a
     * rolled-back transaction would otherwise leave Telegram pointed somewhere
     * the database does not know about — so two reconciliations with different
     * origins could commit the external and the local effect in opposite orders
     * and leave a row claiming `ready` for a URL Telegram is not using.
     *
     * The ordering is protected from OUTSIDE instead: every path that reaches
     * here — `install.sh` and `botctl telegram register` — takes the
     * installation's exclusive lock first, so they queue rather than interleave.
     * `check-boundaries.sh` holds BOTH halves of that: no surface may reach this
     * service, and no file but those two (and the checks that test them) may run
     * the compiled CLI. `apps/api/package.json` used to expose it as
     * `bot:bootstrap`, a third caller taking no lock at all on a host holding the
     * production database — so the sentence that stood here, "there is no third
     * caller", was false and nothing said so. It is now a check rather than a
     * claim.
     *
     * NOT a database advisory lock, which would otherwise be the obvious answer.
     * It would have to be held across the two Telegram calls while the marker
     * transaction below checks out a SECOND connection from the same pool —
     * `DATABASE_POOL_MAX` may be 1, and this codebase has twice reproduced the
     * deadlock that produces (`permission-guard.ts` names it, "reproduced at pool
     * size 1"). The lock that can span a network call is the host one.
     *
     * What remains: a caller that bypasses both shell paths — running the CLI
     * inside the container by hand — can still race a concurrent reconcile, and
     * only when the two use DIFFERENT origins. `docs/open-questions.md` OQ-TG-03
     * carries it rather than this comment implying it is closed.
     */
    const secretToken = this.requireWebhookSecret();
    const registered = await this.deps.telegram.registerWebhook({
      token,
      url,
      secretToken,
      /*
       * Queued updates are discarded on a CREATE and never on a reconcile.
       *
       * A fresh install has no customers, so whatever Telegram holds predates
       * this installation entirely and belongs to whatever the token was used
       * for before; replaying it would deliver somebody else's messages into a
       * brand-new database. A RECONCILE is the opposite case — a domain change
       * or a crash recovery on a RUNNING installation — and dropping the queue
       * there throws away real customers' messages, with no count, no
       * confirmation and no record. `docs/conventions.md` calls that shape out
       * by name.
       */
      dropPendingUpdates: ensured.createdNow,
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
      await this.deps.bots.markWebhookRegistered(
        scope,
        view.id,
        { url, secretFingerprint: fingerprintOf(secretToken), now },
        tx,
      );
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

    /*
     * The command menu, registered after the webhook and never allowed to fail the run.
     *
     * `docs/phase4h-audit.md` §9: the bot answered four commands, registered none, and
     * the greeting named only `/catalog` — so `/wallet` and `/services` were reachable
     * by guessing alone. `BOT_COMMANDS` is the one list; `/help` renders the same one,
     * so the menu and the help text cannot drift.
     *
     * Deliberately weaker than the webhook above. A webhook that did not register means
     * updates do not arrive and `status` must keep answering `incomplete`; a command
     * menu that did not register means a customer types a command instead of tapping
     * it, and `/help` still answers. Failing the install for the second would send an
     * operator hunting a problem they do not have.
     *
     * WHICH commands and WHETHER to register is this layer's decision; rendering their
     * descriptions is not, and the boundary check enforces the difference — an
     * application file may not import `@nexa/i18n`. So the gateway renders from the same
     * `BOT_COMMANDS` this service counts, and the catalogue stays on the infrastructure
     * side of the line where every other piece of customer-facing text is resolved.
     */
    const registeredMenu = await this.deps.telegram.registerCommands({ token });
    /*
     * Recorded as an AUDIT row rather than thrown or logged into the void.
     *
     * An operator who later wonders why the menu is empty has somewhere to look, and a
     * row is what this repository uses for "something happened that a person may care
     * about but nothing is broken". `result` is the honest field: the run continues
     * either way.
     */
    await this.deps.uow.run(scope, async (tx) =>
      this.deps.audit.record(
        scope,
        this.systemActor(),
        {
          action: 'bot.commands.register',
          entityType: 'BotInstance',
          entityId: ensured.view.id,
          before: {},
          after: { commands: BOT_COMMANDS.length },
          result: registeredMenu ? 'SUCCESS' : 'FAILED',
        },
        tx,
      ),
    );

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
    const { identity } = await this.getMe(scope, null, token);

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
          webhookSecretFingerprint: null,
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
  ): Promise<{ readonly identity: BotIdentity; readonly filledLegacyIdentity: boolean }> {
    const probe = await this.deps.telegram.identify(token);

    if (probe.outcome === 'REJECTED') {
      /*
       * TWO messages, because `existing` decides which one is true, and the
       * single message this replaces was written for only one of them
       * (`OQ-TG-04` item 1).
       *
       * "There is no supported recovery … a newly issued one is not used,
       * because the registration always reads the credential already stored" is
       * a statement about a STORED credential. On a FIRST bootstrap there is
       * none — `getMe` runs before `createFromBootstrap` precisely so a rejected
       * token writes nothing — and rerunning with a corrected token IS the
       * recovery. The installer's own nothing-stored summary then advised
       * exactly that, so the two surfaces contradicted each other.
       *
       * `existing` is already a parameter here. The branch costs nothing and the
       * absence of it cost an operator an afternoon being told their situation
       * was unrecoverable when it was a typo.
       */
      if (existing === null) {
        throw errors.configuration(
          PLATFORM_ERROR_CODES.TELEGRAM_BOOTSTRAP_TOKEN_REJECTED,
          `Telegram rejected the bot token: ${probe.detail}. Nothing was stored: the token is ` +
            'validated with Telegram before anything is written, so there is no credential here ' +
            'to repair and nothing to undo. Check the token in BotFather and run this again with ' +
            'a corrected one.',
        );
      }
      throw errors.configuration(
        PLATFORM_ERROR_CODES.TELEGRAM_BOOTSTRAP_TOKEN_REJECTED,
        `Telegram rejected the bot token: ${probe.detail}. ` +
          'The installer does not replace a stored token by itself, and this release ships no ' +
          'command that does: changing the bot a running installation serves is deliberate work ' +
          'that has not been built yet (docs/open-questions.md, OQ-TG-01). There is no supported ' +
          'recovery for a revoked token in this release — a revoked one cannot be restored in ' +
          'BotFather, and a newly issued one is not used, because the registration always reads ' +
          'the credential already stored.',
      );
    }
    /*
     * The configured API base answered, and it is not Telegram.
     *
     * Checked BEFORE the `!== 'IDENTIFIED'` fallthrough, which would file it as
     * UNREACHABLE and tell the operator to rerun — and rerunning asks the same
     * wrong host the same question. A CONFIGURATION error, not an upstream one:
     * nothing is waiting to come back.
     *
     * The message names the variable, because the operator's next action is to
     * look at it, and says the token is not the problem, because the sentence
     * this replaces sent them to BotFather (`OQ-TG-04` items 6 and 7).
     */
    if (probe.outcome === 'NOT_TELEGRAM') {
      throw errors.configuration(
        PLATFORM_ERROR_CODES.TELEGRAM_BOOTSTRAP_API_BASE_INVALID,
        `The configured Telegram API base answered, and what came back does not describe a bot: ${probe.detail}. ` +
          'TELEGRAM_API_BASE_URL is pointing at something that is not Telegram. The bot token is ' +
          'not the problem and does not need reissuing in BotFather; correct that variable and run ' +
          'this again.',
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
      return { identity, filledLegacyIdentity: false };
    }

    if (existing !== null) {
      const now = this.deps.clock.now();
      const actor = this.systemActor();
      /*
       * Whether the blank was actually filled, carried out of the closure.
       *
       * `refuseRepointing` runs AFTER this and its message used to open "Nothing
       * was changed." — which on this path is false: the UPDATE and its audit row
       * are committed by the time the refusal is thrown (`OQ-TG-04` item 3). The
       * refusal itself is right; only that clause was wrong, and a refusal that
       * misdescribes the state it leaves behind is the failure this whole phase
       * is about.
       *
       * Read from `recordTelegramIdentity`'s own boolean, never assumed: its
       * WHERE carries `telegram_bot_id IS NULL` and a concurrent run can fill the
       * blank first, in which case nothing WAS changed here and the plain message
       * is the true one.
       */
      const filledLegacyIdentity = await this.deps.uow.run(scope, async (tx) => {
        await this.deps.bots.lockTenantForBotChange(scope, tx);
        await this.requireActiveScope(scope, tx);
        /*
         * Audited only if the UPDATE actually changed a row.
         *
         * Its WHERE carries `telegram_bot_id IS NULL`, and a concurrent run can
         * fill that blank between this caller's unlocked read and this
         * statement. Auditing regardless would write a row asserting a `before`
         * that was not true and a change that did not happen.
         */
        const filled = await this.deps.bots.recordTelegramIdentity(
          scope,
          existing.id,
          { telegramBotId: identity.botId, username: identity.username, now },
          tx,
        );
        if (!filled) return false;
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
        return true;
      });
      return { identity, filledLegacyIdentity };
    }

    return { identity, filledLegacyIdentity: false };
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
  private refuseRepointing(
    existing: BotBootstrapView,
    suppliedToken: string | null,
    /**
     * Whether a legacy row's identity was FILLED before this refusal was reached.
     *
     * `OQ-TG-04` item 3. On a row that predates migration 0038 the first
     * `refuseRepointing` returns early — `telegramBotId` is NULL, so it compares
     * nothing — then `getMe` commits the bot id, the username and an audit row,
     * and only then does this call have an id to refuse against. "Nothing was
     * changed." is false at that moment, and a refusal that misdescribes the
     * state it leaves behind is the defect this phase exists to remove.
     *
     * The refusal itself stays: repointing is still forbidden, and the fill is a
     * legitimate audited migration of a row that predates the column. Only the
     * clause changes, which is why this is a parameter rather than a reordering
     * — deriving the id from the stored token before the fill would decrypt a
     * credential earlier than it needs to be, to buy prose.
     */
    filledLegacyIdentity = false,
  ): void {
    if (suppliedToken === null || existing.telegramBotId === null) return;
    const claimed = suppliedToken.trim().split(':')[0] ?? '';
    if (claimed === '' || claimed === existing.telegramBotId) return;
    const changed = filledLegacyIdentity
      ? `This installation's own bot identity was recorded from its stored token first, which is ` +
        'a one-off migration of a row that predates that column and is in the audit log. Nothing ' +
        'else was changed, and nothing was repointed.'
      : 'Nothing was changed.';
    throw errors.configuration(
      PLATFORM_ERROR_CODES.TELEGRAM_BOOTSTRAP_DIFFERENT_BOT,
      `The supplied token belongs to bot ${claimed}, and this installation is bound to bot ` +
        `${existing.telegramBotId}. ${changed} An installer rerun reconciles; it never ` +
        'repoints an installation at another bot, because every stored Telegram user and chat ' +
        'belongs to the one it already has.',
    );
  }

  /**
   * Why the registration did not happen, and what that means for the operator.
   *
   * TWO codes and two sentences, and the split is `OQ-TG-04` item 8. This built
   * ONE `detail` for both outcomes — "rerun the installer to retry the
   * registration" — and chose only the error KIND from which outcome it was. But
   * `REFUSED` means Telegram LOOKED AT the URL and would not take it: not https,
   * a port it does not accept, a name it cannot resolve. An unchanged rerun
   * submits the same URL and is refused the same way, so the advice was a step
   * that cannot work, given to the operator in the same words as the step that
   * does.
   *
   * What both halves keep saying is that nothing was undone, because that is
   * true of both and is the first thing somebody standing at a failed install
   * wants to know.
   */
  private webhookFailure(outcome: Exclude<WebhookRegistration, { outcome: 'REGISTERED' }>): Error {
    const intact =
      'The bot instance and its encrypted token are stored and correct; nothing was undone.';
    if (outcome.outcome === 'REFUSED') {
      return errors.configuration(
        PLATFORM_ERROR_CODES.TELEGRAM_BOOTSTRAP_WEBHOOK_REFUSED,
        `Telegram refused the webhook URL: ${outcome.detail}. ${intact} Rerunning submits the ` +
          'same URL and is refused the same way — the usual causes are a URL that is not https, ' +
          'a port Telegram does not accept, or a host name it cannot resolve. Correct the public ' +
          'base URL, or the DNS record behind it, and run this again.',
      );
    }
    return new NexaError({
      kind: 'UPSTREAM_UNAVAILABLE',
      code: PLATFORM_ERROR_CODES.TELEGRAM_BOOTSTRAP_WEBHOOK_FAILED,
      message:
        `Telegram did not register the webhook: ${outcome.detail}. ${intact} Rerun the installer ` +
        'to retry the registration; it will not ask for the token again.',
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
   *
   * Only a LENGTH check here. Telegram's `A-Za-z0-9_-` alphabet is enforced by
   * the config schema, which is the earliest point it can be: a secret in the
   * wrong alphabet is one no webhook could ever be authenticated with, so it
   * should stop a boot rather than surface at the one moment an operator is
   * standing at a half-finished install. Checking it twice would be two places
   * for the rule to drift.
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
