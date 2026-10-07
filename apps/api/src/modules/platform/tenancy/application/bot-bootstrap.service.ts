import {
  BOT_WEBHOOK_ERROR_MESSAGE_MAX,
  errors,
  isNexaError,
  NexaError,
  PLATFORM_ERROR_CODES,
  systemJobActor,
  type ActorContext,
  type AuditWriter,
  type BotInstanceId,
  type BotLiveProblem,
  type BotWebhookSecretState,
  type Clock,
  type CorrelationId,
  type IdGenerator,
  type ScopeContext,
  type TenantContext,
  type UnitOfWork,
} from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import { redactSecretText } from '../../../../infrastructure/redaction.js';
import type { ScopeActivityReader } from '../../system/application/record-ping.service.js';
import type {
  BotBootstrapRepository,
  BotBootstrapTelegram,
  BotBootstrapView,
  BotIdentityProbe,
  BotInstanceRepository,
  TokenReplacementClaims,
  WebhookRegistration,
} from './ports.js';
import type { BotWebhookRead } from './bot-management-ports.js';
import { webhookSecretFingerprint } from './webhook-fingerprint.js';
import type { CommandMenu } from './command-menu.js';
import { tokenReplacementLeaseMs } from '../domain/token-replacement-lease.js';
import { liveProblems } from '../domain/bot-readiness.js';
import {
  allowedUpdatesNarrowed,
  shownWebhookUrl,
  telegramWebhookUrl,
} from '../domain/webhook-url.js';

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
 *                   installation currently holds. Nothing to do. From
 *                   `statusWithReason` this is BOTH halves: the local marker AND
 *                   Telegram's own `getWebhookInfo`, read with the stored token
 *                   (incident A, 2026-10-07). From `status` it is the marker only,
 *                   which is why only the installer's prompt decision reads that.
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

/**
 * What `getMe` + `getWebhookInfo` said when `statusWithReason` asked Telegram (hardening
 * batch 2026-10-07, incident A).
 *
 *  - `READ`             — the stored token is THIS bot's and the registration was read.
 *  - `TOKEN_REJECTED`   — Telegram refused the stored token (a revoked one answers 401).
 *  - `NOT_TELEGRAM`     — the configured API base answered with something that is not a bot.
 *  - `DIFFERENT_BOT`    — the stored token now names another bot than the one bound here.
 *  - `UNREACHABLE`      — Telegram could not be asked (timeout, network, 5xx, 429). UNKNOWN,
 *                         never "fine".
 *  - `TOKEN_UNREADABLE` — the stored token could not be decrypted, so nothing was asked.
 *  - `WEBHOOK_READ_REFUSED` — `getMe` ACCEPTED the token, and `getWebhookInfo` then failed
 *                         permanently (refused, or answered with something that is not a
 *                         WebhookInfo). The token was just proved, so this is never filed
 *                         as `TOKEN_REJECTED`: that would send the operator to replace a
 *                         token that works.
 */
export type BotRemoteWebhookOutcome =
  | 'READ'
  | 'TOKEN_REJECTED'
  | 'NOT_TELEGRAM'
  | 'DIFFERENT_BOT'
  | 'UNREACHABLE'
  | 'TOKEN_UNREADABLE'
  | 'WEBHOOK_READ_REFUSED';

/**
 * The two halves `botctl telegram status` reports, side by side, and never one standing in
 * for the other.
 *
 * The incident this exists for: the LOCAL marker said registered, `status` answered `ready`
 * from it alone, and Telegram held `url: ""` with 22 updates queued. Nothing here carries a
 * credential: no token, no webhook secret and no fingerprint value. The remote URL is shown
 * through `shownWebhookUrl`, so a foreign registration (whose path can carry a token) is cut
 * to its origin; Telegram's own error text is redacted and bounded.
 */
export interface BotWebhookStatusDetail {
  readonly botInstanceId: BotInstanceId;
  /** The one URL this installation registers for this bot, from the origin it was given. */
  readonly expectedUrl: string;
  readonly local: {
    /** The marker is current: registered, at `expectedUrl`, with the secret held now. */
    readonly registered: boolean;
    readonly recordedUrl: string | null;
    readonly registeredAt: Date | null;
    readonly secret: Exclude<BotWebhookSecretState, 'NOT_CONFIGURED'>;
  };
  readonly remote: {
    readonly outcome: BotRemoteWebhookOutcome;
    /** The URL Telegram delivers to, as it may be shown; null when none is set or unread. */
    readonly url: string | null;
    /** Null when the registration could not be read. */
    readonly matchesExpected: boolean | null;
    readonly updatesNarrowed: boolean | null;
    readonly pendingUpdateCount: number | null;
    readonly lastErrorAt: Date | null;
    readonly lastErrorMessage: string | null;
    /** The error CODE a token that could not be decrypted failed with; never a message. */
    readonly tokenErrorCode: string | null;
  };
  /** `liveProblems` — the Web Admin live check's verdict, so "ready" means one thing. */
  readonly problems: readonly BotLiveProblem[];
  /**
   * D3 (roadmap): present only when `getMe` named THIS bot under a username other than the
   * stored one — a BotFather rename. Shown, never written: `status` is read-only, and
   * `botctl telegram register` records it. Not a problem: the webhook does not depend on it.
   */
  readonly usernameDrift?: { readonly stored: string; readonly reported: string };
}

export interface BotBootstrapStatusReport {
  readonly state: BotBootstrapStatus;
  readonly reason: string | null;
  /** Null when there is no bot to look at, or a scope-level cause stopped the check first. */
  readonly detail: BotWebhookStatusDetail | null;
}

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
  readonly bots: BotBootstrapRepository &
    Pick<BotInstanceRepository, 'resolveToken'> &
    TokenReplacementClaims;
  readonly scopeActivity: ScopeActivityReader;
  readonly audit: AuditWriter;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly telegram: BotBootstrapTelegram;
  /** Round P: the desired command menu and its digest, rendered through the tenant's texts. */
  readonly commandMenu: Pick<CommandMenu, 'desiredFor'>;
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
  /**
   * R4 — the Telegram call timeout the gateway was built with, from which the lease of the
   * token-replacement claim this registration takes is derived.
   */
  readonly telegramCallTimeoutMs: number;
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
   * The LOCAL answer, and only the one decision it is fit for: whether the bootstrap CLI
   * must ask for a token (`none`) or may resume from the stored one (anything else). Its
   * one reader is `bootstrap-bot.cli.ts` → `tokenForRun`; `install.sh` reads the
   * remote-aware `--status` (`statusWithReason`), not this.
   *
   * Read-only and makes no Telegram call. It is NOT what `botctl telegram status` reports
   * — that is `statusWithReason`, which asks Telegram — because a `ready` read from the
   * local marker alone is exactly how an installation whose webhook Telegram had dropped
   * (`url: ""`, 22 updates queued) was reported as receiving updates (incident A,
   * 2026-10-07). Its `ready` means "the marker is current", nothing more.
   */
  async status(scope: TenantContext, publicBaseUrl: string): Promise<BotBootstrapStatus> {
    return (await this.localStatus(scope, publicBaseUrl)).state;
  }

  /**
   * What `botctl telegram status` prints: the state, the sentence that says why, and the
   * local and remote facts side by side.
   *
   * `ready` ONLY when both agree: the local marker is current AND Telegram, asked with the
   * stored token, reports exactly this installation's URL with its full update set, for
   * THIS bot. Everything else is a different word with a reason, and the word keeps the
   * remedy it has always named (the installer and `botctl update` read it):
   *
   *  - `incomplete`  — registering would fix it: the marker is not current, or Telegram
   *                    holds no URL, another URL, or a narrowed update set.
   *                    `botctl telegram register` re-registers keeping queued updates.
   *  - `unavailable` — registering cannot fix it: the three local causes as before, AND
   *                    now a token Telegram rejects (replace it in the Web Admin), an API
   *                    base that is not Telegram, a token naming another bot, a token that
   *                    cannot be decrypted, or Telegram that could not be asked at all —
   *                    an UNKNOWN remote state is never reported as `ready`.
   *
   * Two Telegram READS (`getMe`, `getWebhookInfo`), outside any transaction, each bounded
   * by the gateway's call timeout (`NOTIFICATION_SEND_TIMEOUT_MS`). Nothing is written.
   */
  async statusWithReason(
    scope: TenantContext,
    publicBaseUrl: string,
  ): Promise<BotBootstrapStatusReport> {
    const local = await this.localStatus(scope, publicBaseUrl);
    if (local.view === null || local.url === null) {
      return { state: local.state, reason: local.reason, detail: null };
    }
    const detail = await this.remoteDetail(scope, local.view, local.url);
    const verdict = this.verdict(detail);
    return { ...verdict, detail };
  }

  /**
   * The local half: the scope-level causes, the row, and whether the marker is current.
   * `view` and `url` are present only for an ACTIVE bot in an active scope.
   */
  private async localStatus(
    scope: TenantContext,
    publicBaseUrl: string,
  ): Promise<{
    readonly state: BotBootstrapStatus;
    readonly reason: string | null;
    readonly view: BotBootstrapView | null;
    readonly url: string | null;
  }> {
    /*
     * The two SCOPE-level causes are checked before the row is looked up, and
     * that ordering is `OQ-TG-04` item 11 rather than tidiness.
     *
     * `scopeIsActive` used to be consulted only inside `unavailableReason`,
     * which was reached only when a bot row EXISTED. So a tenant an operator had
     * stopped, with no bot yet, answered `none` — the installer prompted for a
     * bearer credential, sent it to `getMe`, and only THEN did the create
     * transaction refuse. The token need never have left the host.
     *
     * `view.status !== 'ACTIVE'` stays below, because it is a fact about a row
     * and there is no row here to have one.
     */
    const scopeReason = await this.unavailableScopeReason(scope);
    if (scopeReason !== null) {
      return { state: 'unavailable', reason: scopeReason, view: null, url: null };
    }

    const existing = await this.deps.bots.findBootstrapTarget(scope);
    if (existing === null) return { state: 'none', reason: null, view: null, url: null };
    // Not a bootstrap state to converge out of — see `unavailableReason`.
    if (existing.status !== 'ACTIVE') {
      return {
        state: 'unavailable',
        reason: this.botNotActiveReason(existing.status),
        view: null,
        url: null,
      };
    }
    // Normalised through the SAME function `execute` uses, so a trailing slash
    // in the configured origin cannot make `status` report `incomplete` for a
    // webhook `execute` would then find already registered.
    const url = this.webhookUrlFor(this.requireOrigin(publicBaseUrl), existing.id);
    return {
      state: this.registrationIsCurrent(existing, url) ? 'ready' : 'incomplete',
      reason: null,
      view: existing,
      url,
    };
  }

  /**
   * The remote half: `getMe`, then `getWebhookInfo`, with the STORED token — the one every
   * reply this installation sends is made with, so a token Telegram rejects is found here
   * rather than on the first customer message (`telegram.rejected.401`, incident A).
   *
   * Reads only. The token is decrypted through the one path every outbound use takes
   * (`resolveToken`), lives in this frame, and appears in nothing returned: Telegram's error
   * text is stripped of it and redacted by content, and a foreign URL is cut to its origin.
   */
  private async remoteDetail(
    scope: TenantContext,
    view: BotBootstrapView,
    url: string,
  ): Promise<BotWebhookStatusDetail> {
    const local = {
      registered: this.registrationIsCurrent(view, url),
      recordedUrl: view.webhookUrl,
      registeredAt: view.webhookRegisteredAt,
      secret: this.localSecretState(view),
    };
    const unread = {
      url: null,
      matchesExpected: null,
      updatesNarrowed: null,
      pendingUpdateCount: null,
      lastErrorAt: null,
      lastErrorMessage: null,
      tokenErrorCode: null,
    };
    const result = (
      remote: BotWebhookStatusDetail['remote'],
      probe: BotIdentityProbe | null,
      read: Extract<BotWebhookRead, { outcome: 'READ' }> | null,
    ): BotWebhookStatusDetail => {
      const identified = probe !== null && probe.outcome === 'IDENTIFIED' ? probe : null;
      const renamed =
        identified !== null &&
        view.telegramBotId !== null &&
        identified.botId === view.telegramBotId &&
        identified.username !== view.username;
      return {
        botInstanceId: view.id,
        expectedUrl: url,
        local,
        remote,
        ...(renamed
          ? { usernameDrift: { stored: view.username, reported: identified.username } }
          : {}),
        problems: liveProblems({
          // The three local causes were refused before this was reached.
          webhookRouteEnabled: true,
          tenantActive: true,
          botStatus: view.status,
          secret: local.secret,
          identified: identified !== null,
          isBot: identified?.isBot ?? null,
          sameBot:
            identified === null || view.telegramBotId === null
              ? null
              : identified.botId === view.telegramBotId,
          webhook:
            read === null
              ? null
              : { url: read.url, narrowed: allowedUpdatesNarrowed(read.allowedUpdates) },
          expectedUrl: url,
        }),
      };
    };

    let token: string;
    try {
      token = await this.deps.bots.resolveToken(scope, view.id);
    } catch (error) {
      // The CODE only: a decryption error's message is not this report's to repeat.
      return result(
        {
          outcome: 'TOKEN_UNREADABLE',
          ...unread,
          tokenErrorCode: isNexaError(error) ? error.code : 'unknown',
        },
        null,
        null,
      );
    }

    const probe = await this.deps.telegram.identify(token);
    if (probe.outcome !== 'IDENTIFIED') {
      const outcome: BotRemoteWebhookOutcome =
        probe.outcome === 'REJECTED'
          ? 'TOKEN_REJECTED'
          : probe.outcome === 'NOT_TELEGRAM'
            ? 'NOT_TELEGRAM'
            : 'UNREACHABLE';
      return result({ outcome, ...unread }, probe, null);
    }
    if (probe.isBot === false) return result({ outcome: 'NOT_TELEGRAM', ...unread }, probe, null);
    if (view.telegramBotId !== null && probe.botId !== view.telegramBotId) {
      return result({ outcome: 'DIFFERENT_BOT', ...unread }, probe, null);
    }

    const held = await this.deps.telegram.readWebhook(token);
    if (held.outcome !== 'READ') {
      return result(
        {
          // `getMe` just accepted this token, so a permanent failure HERE is not the token.
          outcome: held.outcome === 'REJECTED' ? 'WEBHOOK_READ_REFUSED' : 'UNREACHABLE',
          ...unread,
        },
        probe,
        null,
      );
    }
    return result(
      {
        outcome: 'READ',
        url: shownWebhookUrl(held.url, view.webhookUrl, url),
        matchesExpected: held.url === url,
        updatesNarrowed: allowedUpdatesNarrowed(held.allowedUpdates),
        pendingUpdateCount: held.pendingUpdateCount,
        lastErrorAt: held.lastErrorAt,
        lastErrorMessage:
          held.lastErrorMessage === null ? null : this.telegramText(held.lastErrorMessage, token),
        tokenErrorCode: null,
      },
      probe,
      held,
    );
  }

  /** The word and the sentence, from both halves. `ready` only when both agree. */
  private verdict(detail: BotWebhookStatusDetail): {
    readonly state: BotBootstrapStatus;
    readonly reason: string | null;
  } {
    const { remote } = detail;
    switch (remote.outcome) {
      case 'TOKEN_REJECTED':
        return {
          state: 'unavailable',
          reason:
            'Telegram REJECTED the bot token this installation has stored (a token revoked or ' +
            'reissued in BotFather answers 401), so no reply this bot sends can be delivered. ' +
            '`botctl telegram register` cannot fix this: it never replaces a stored token. ' +
            "Replace the token on the bot's page in the Web Admin — that validates the new " +
            "token with Telegram, registers this installation's webhook keeping queued updates, " +
            'reads it back, and only then stores the token. Then run `botctl telegram status` ' +
            'again.',
        };
      case 'NOT_TELEGRAM':
        return {
          state: 'unavailable',
          reason:
            'The configured Telegram API base answered, and what came back does not describe a ' +
            'bot. TELEGRAM_API_BASE_URL is pointing at something that is not Telegram; the bot ' +
            'token is not the problem. Correct that variable, restart, and run this again.',
        };
      case 'DIFFERENT_BOT':
        return {
          state: 'unavailable',
          reason:
            'The stored token now belongs to a different bot than the one this installation is ' +
            'bound to. Nothing is repointed automatically: every stored Telegram user and chat ' +
            "belongs to the bound bot. Replace the token on the bot's page in the Web Admin with " +
            "the bound bot's current token.",
        };
      case 'TOKEN_UNREADABLE':
        return {
          state: 'unavailable',
          reason:
            `The stored bot token could not be decrypted (${remote.tokenErrorCode ?? 'unknown'}), ` +
            'so Telegram was not asked anything. `botctl secrets status` shows the keys this ' +
            'installation holds.',
        };
      case 'WEBHOOK_READ_REFUSED':
        return {
          state: 'unavailable',
          reason:
            'Telegram ACCEPTED the stored token (getMe answered for this bot), but getWebhookInfo ' +
            'then failed permanently — refused, or answered with something that is not a ' +
            'WebhookInfo — so whether Telegram delivers updates here is UNKNOWN. The token is not ' +
            'the problem and does not need replacing. Check TELEGRAM_API_BASE_URL (a proxy that ' +
            'serves getMe but not getWebhookInfo), then run this again.',
        };
      case 'UNREACHABLE':
        return {
          state: 'unavailable',
          reason:
            'Telegram could not be asked from this host (a timeout, a network failure, a 5xx or a ' +
            '429 on an OUTBOUND call to the Telegram API), so whether Telegram still delivers ' +
            'updates here is UNKNOWN — and unknown is not ready. Check egress from this host to ' +
            'the Telegram API (and TELEGRAM_API_BASE_URL), then run this again.',
        };
      case 'READ':
        break;
    }
    if (detail.local.registered && detail.problems.length === 0) {
      return { state: 'ready', reason: null };
    }
    const pending =
      remote.pendingUpdateCount === null
        ? ''
        : ` Telegram is holding ${remote.pendingUpdateCount} queued update(s); registering keeps them.`;
    const what = !remote.matchesExpected
      ? remote.url === null
        ? 'Telegram holds NO webhook URL for this bot, so updates are queued at Telegram and ' +
          'reach nothing'
        : 'Telegram delivers this bot to a DIFFERENT URL than this installation registers'
      : remote.updatesNarrowed
        ? "Telegram's registration leaves out update types this bot handles"
        : !detail.local.registered
          ? 'Telegram delivers here, but this installation has no current record of registering ' +
            'it with the webhook secret it holds now'
          : 'The registration does not match this installation';
    return {
      state: 'incomplete',
      reason:
        `${what}.${pending} Run \`botctl telegram register\`: it reads Telegram first, ` +
        're-registers only what differs (never dropping queued updates), and reads it back.',
    };
  }

  /** Whether the marker's secret fingerprint is the one held now. */
  private localSecretState(
    view: BotBootstrapView,
  ): Exclude<BotWebhookSecretState, 'NOT_CONFIGURED'> {
    if (view.webhookSecretFingerprint === null) return 'UNKNOWN';
    return view.webhookSecretFingerprint === webhookSecretFingerprint(this.requireWebhookSecret())
      ? 'MATCHES'
      : 'DIFFERS';
  }

  /**
   * Telegram's own text, as far as it may be shown: without the token or the webhook
   * secret (should either ever be echoed), redacted by content, bounded.
   */
  private telegramText(text: string, token: string): string {
    let scrubbed = text.split(token).join('[redacted]');
    const secret = this.deps.webhookSecret();
    if (secret !== '') scrubbed = scrubbed.split(secret).join('[redacted]');
    return redactSecretText(scrubbed).slice(0, BOT_WEBHOOK_ERROR_MESSAGE_MAX);
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
    const scopeReason = await this.unavailableScopeReason(scope);
    if (scopeReason !== null) return scopeReason;
    if (view.status !== 'ACTIVE') return this.botNotActiveReason(view.status);
    return null;
  }

  /**
   * The two causes that are true of the INSTALLATION and the TENANT, not a row.
   *
   * Split out so `status` can consult them before it has looked for a bot at
   * all (`OQ-TG-04` item 11). Both are reads that decide what to report rather
   * than writes that need holding still, which is why `scopeIsActive` is called
   * without a transaction here; the transactional checks inside `uow.run` are
   * untouched and they are the ones that make a write safe.
   *
   * This MOVED the precedence, and the move is deliberate rather than a
   * side-effect of the split. The three causes used to be ordered webhook
   * route, then bot status, then tenant activity; they are now webhook route,
   * then tenant activity, then bot status. A tenant that has stopped accepting
   * work makes its bot's own status moot — starting the bot changes nothing
   * while the tenant refuses every update — so naming the bot first would send
   * an operator to fix the thing that is not in the way. `reports the tenant
   * before the bot when BOTH are in the way` pins it; without that test the two
   * orders are indistinguishable, which is how this was nearly a silent change.
   */
  private async unavailableScopeReason(scope: TenantContext): Promise<string | null> {
    if (!this.deps.webhookEnabled()) {
      return (
        'TELEGRAM_WEBHOOK_ENABLED is false, so this installation does not serve the webhook route ' +
        'at all. Telegram would deliver every update to a 404. Set it to true in nexa.env, ' +
        'restart, and run this again.'
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

  private botNotActiveReason(status: BotBootstrapView['status']): string {
    return (
      `The bot instance for this tenant is ${status}, not ACTIVE. The webhook route refuses ` +
      'every update for a bot that is not active. Start the bot and run this again.'
    );
  }

  private registrationIsCurrent(view: BotBootstrapView, url: string): boolean {
    if (view.webhookRegisteredAt === null || view.webhookUrl !== url) return false;
    if (view.webhookSecretFingerprint === null) return false;
    return view.webhookSecretFingerprint === webhookSecretFingerprint(this.requireWebhookSecret());
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
     *
     * "Pointed here" is BOTH halves: the marker, AND Telegram's own answer read
     * first. A registration that cannot be read is neither: nothing is changed and
     * the run FAILS rather than printing "already configured and receiving
     * updates" about a state nobody could see (incident A, 2026-10-07).
     */
    const holds =
      !ensured.createdNow && this.registrationIsCurrent(view, url)
        ? await this.telegramHolds(token, url)
        : 'DIFFERS';
    if (holds === 'UNKNOWN') {
      throw new NexaError({
        kind: 'UPSTREAM_UNAVAILABLE',
        code: PLATFORM_ERROR_CODES.TELEGRAM_BOOTSTRAP_UNREACHABLE,
        message:
          "Telegram accepted this bot's token, but its webhook registration could not be read " +
          'back, so whether it still delivers here is unknown. Nothing was changed. Run this ' +
          'again; if it keeps failing, check egress from this host to the Telegram API.',
      });
    }
    if (holds === 'HOLDS') {
      /*
       * The menu is reconciled even here, and THIS is `OQ-4H-02`.
       *
       * `setMyCommands` used to run only below, after this early return — so an
       * installation whose webhook is already current never reached it. That is
       * every installation that UPGRADES rather than installs: `botctl update`
       * does not invoke this CLI, and even `botctl telegram register` returned
       * here without registering. The discoverability 4H shipped therefore
       * applied to fresh installs only.
       *
       * Guarded by the stored digest, so it is at most ONE extra Telegram call
       * per release that changes the menu, not one per rerun. `commandsRevision`
       * is computed by the adapter from the rendered menu, so a catalogue
       * rewording counts as a change too.
       */
      await this.reconcileCommands(scope, view.id, view.commandsRevision, token);
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
    /*
     * R4 — the SAME claim a Web Admin token replacement takes, so `botctl telegram
     * register` and a replacement cannot interleave their `setWebhook` calls and markers.
     * The marker below is written only while this run still holds it; the claim is
     * released whatever happens. A replacement in flight is refused with a remedy.
     */
    const claimId = await this.claimRegistration(scope, view.id);
    const dropPendingUpdates = ensured.createdNow;
    try {
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
        dropPendingUpdates,
        /*
         * R4: Telegram's default update set, on a create and a reconcile alike. The Bot API
         * KEEPS the previous `allowed_updates` when the field is omitted, so without this a
         * rerun that `telegramHolds` sent here BECAUSE the list was narrowed would
         * re-register and leave it narrowed — on every rerun. An empty list is the default
         * set, so a fresh install registers exactly what it always did.
         */
        resetAllowedUpdates: true,
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
        await this.recordRegistrationFailure(scope, view, {
          stage: 'SET_WEBHOOK',
          outcome: registered.outcome,
          expectedUrl: url,
          remoteUrl: null,
          telegramReason: this.telegramText(registered.detail, token),
          dropPendingUpdates,
        });
        throw this.webhookFailure(registered, token);
      }

      /*
       * READ IT BACK before anything is recorded (incident A, 2026-10-07).
       *
       * Telegram's `true` says it took the request; only the registration it now reports
       * says where updates will go. The marker below is what `status` and every later
       * rerun trust, so it is written only for a registration Telegram was SEEN to hold:
       * exactly this URL, with its full update set. Anything else — including a read that
       * could not be made — fails the run with the marker unwritten, so `status` keeps
       * answering `incomplete` and a rerun re-registers (keeping the queue) instead of
       * reporting a bot that receives nothing as configured.
       */
      const after = await this.deps.telegram.readWebhook(token);
      if (
        after.outcome !== 'READ' ||
        after.url !== url ||
        allowedUpdatesNarrowed(after.allowedUpdates)
      ) {
        await this.recordRegistrationFailure(scope, view, {
          stage: 'VERIFY_WEBHOOK',
          outcome: after.outcome,
          expectedUrl: url,
          remoteUrl:
            after.outcome === 'READ' ? shownWebhookUrl(after.url, view.webhookUrl, url) : null,
          telegramReason: null,
          dropPendingUpdates,
        });
        throw this.verificationFailure(after, url, view.webhookUrl);
      }

      const now = this.deps.clock.now();
      const actor = this.systemActor();
      await this.deps.uow.run(scope, async (tx) => {
        await this.deps.bots.lockTenantForBotChange(scope, tx);
        await this.requireActiveScope(scope, tx);
        const marked = await this.deps.bots.markWebhookRegistered(
          scope,
          view.id,
          { url, secretFingerprint: webhookSecretFingerprint(secretToken), now, claimId },
          tx,
        );
        if (!marked) throw this.replacementInProgress();
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'bot_instance.webhook_registered',
            entityType: 'BotInstance',
            entityId: view.id,
            before: { webhookUrl: view.webhookUrl },
            // What was proved, never a credential: the URL Telegram was SEEN to hold, how
            // many updates it was holding, and whether the queue was kept (a reconcile
            // always keeps it; only a first registration discards what predates it).
            after: {
              webhookUrl: url,
              verifiedBy: ['setWebhook', 'getWebhookInfo'],
              pendingUpdateCount: after.pendingUpdateCount,
              dropPendingUpdates,
            },
            reason: 'Installation bootstrap: Telegram webhook registration.',
            result: 'SUCCESS',
          },
          tx,
        );
      });
    } finally {
      await this.releaseRegistration(scope, view.id, claimId);
    }

    await this.reconcileCommands(scope, ensured.view.id, view.commandsRevision, token);

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
          commandsRevision: null,
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
  /**
   * Registers the command menu when it is not already what Telegram has.
   *
   * Called from BOTH the reconcile-and-register path and the ALREADY_COMPLETE
   * early return, which is the whole of `OQ-4H-02`: the second caller is the one
   * an upgraded installation actually reaches.
   *
   * Deliberately weaker than the webhook. A webhook that did not register means
   * updates do not arrive and `status` must keep answering `incomplete`; a menu
   * that did not register means a customer types a command instead of tapping it,
   * and `/help` still answers. Failing an install for the second would send an
   * operator hunting a problem they do not have — so this returns void, records
   * an audit row either way, and the digest is written ONLY on success.
   *
   * WHICH commands and WHETHER to register is this layer's decision; rendering
   * their descriptions is not, and `check-boundaries.sh` enforces the difference
   * by refusing `@nexa/i18n` to an application file. So the adapter renders, and
   * this compares two opaque strings.
   */
  /**
   * R4 — whether Telegram STILL delivers to `url`, asked rather than assumed.
   *
   * `registrationIsCurrent` reads this installation's own marker, and the marker cannot
   * see a registration Telegram dropped on its side — a BotFather revocation is the
   * suspected case (`OQ-WP13-02`), and the owner's staging bot went silent that way while
   * this command answered "nothing to do". So a rerun that would report ALREADY_COMPLETE
   * first reads the registration: only an answer that shows ANOTHER URL (none included),
   * or a narrowed update set, sends the rerun on to re-register — with the queue kept,
   * because this is a running installation.
   *
   * An answer that could not be OBTAINED changes nothing — `getMe` has just succeeded, and
   * turning a flaky read into a re-registration on every rerun is what the early return
   * exists to prevent — but it is no longer read as "holds" either: that is the claim
   * `ALREADY_COMPLETE` prints, and an unread registration cannot support it (incident A).
   * `UNKNOWN` makes the caller fail with nothing changed. A REJECTED read is an answer,
   * not a flake, and re-registers (which then fails with the clear error).
   */
  private async telegramHolds(
    token: string,
    url: string,
  ): Promise<'HOLDS' | 'DIFFERS' | 'UNKNOWN'> {
    const held = await this.deps.telegram.readWebhook(token);
    if (held.outcome === 'UNREACHABLE') return 'UNKNOWN';
    if (held.outcome === 'REJECTED') return 'DIFFERS';
    return held.url === url && !allowedUpdatesNarrowed(held.allowedUpdates) ? 'HOLDS' : 'DIFFERS';
  }

  /** Takes the bot's token-replacement claim for this registration, or refuses. */
  private async claimRegistration(scope: TenantContext, id: BotInstanceId): Promise<string> {
    const claimId = this.deps.ids.uuid();
    const now = this.deps.clock.now();
    const taken = await this.deps.uow.run(scope, async (tx) => {
      // The bootstrap's order in every write: the tenant lock, then the activity check.
      await this.deps.bots.lockTenantForBotChange(scope, tx);
      await this.requireActiveScope(scope, tx);
      return this.deps.bots.claimTokenReplacement(
        scope,
        id,
        {
          id: claimId,
          now,
          until: new Date(now.getTime() + tokenReplacementLeaseMs(this.deps.telegramCallTimeoutMs)),
        },
        tx,
      );
    });
    if (!taken) throw this.replacementInProgress();
    return claimId;
  }

  private async releaseRegistration(
    scope: TenantContext,
    id: BotInstanceId,
    claimId: string,
  ): Promise<void> {
    try {
      await this.deps.uow.run(scope, (tx) =>
        this.deps.bots.releaseTokenReplacement(scope, id, claimId, tx),
      );
    } catch (error) {
      // The lease lapses on its own; the registration's own outcome is what is reported.
      void error;
    }
  }

  private replacementInProgress(): NexaError {
    return new NexaError({
      kind: 'CONFLICT',
      code: PLATFORM_ERROR_CODES.TELEGRAM_BOOTSTRAP_WEBHOOK_FAILED,
      message:
        'A token replacement for this bot is in progress in the Web Admin, so nothing was ' +
        'registered. Wait for it to finish (a few minutes at most) and run this again.',
    });
  }

  private async reconcileCommands(
    scope: TenantContext,
    id: BotInstanceId,
    stored: string | null,
    token: string,
  ): Promise<void> {
    // Round P: the ONE desired list — `BOT_COMMANDS` rendered through the tenant's own
    // texts — and its digest, from `CommandMenu`, the evaluator the worker's sync lane and
    // the Web Admin's menu state read too. Three readers of one answer, so "current" means
    // the same thing to the installer, the lane and the page.
    const desired = await this.deps.commandMenu.desiredFor(scope);
    const revision = desired.hash;
    // NULL is "unknown", never "matches" — the same rule the webhook secret
    // fingerprint states, and for the same reason: one unnecessary call is a
    // far cheaper mistake than a silent claim.
    if (stored === revision) return;

    const registered =
      (await this.deps.telegram.registerCommands({ token, commands: desired.entries })).outcome ===
      'REGISTERED';

    /*
     * Recorded as an AUDIT row rather than thrown or logged into the void.
     *
     * An operator who later wonders why the menu is empty has somewhere to look,
     * and a row is what this repository uses for "something happened that a
     * person may care about but nothing is broken". `result` is the honest field:
     * the run continues either way.
     */
    await this.deps.uow.run(scope, async (tx) => {
      /*
       * The lock FIRST, then the activity check, exactly as every other write in
       * this service does it — and for the reason CLAUDE.md states as a
       * non-negotiable: "Every write path also reads `ScopeActivityReader`
       * INSIDE its transaction". `execute` checks activity earlier, but that
       * check is outside this transaction and a stop can commit in between.
       *
       * Found by the self-review of this phase's own diff: the first version of
       * this method wrote `commands_revision` and an audit row with neither, on
       * a path that is now reached by every `botctl update` of every
       * installation. The check being unreachable today (an inactive tenant is
       * refused before ALREADY_COMPLETE) is not the same as it being unnecessary
       * — that refusal is one reordering away from moving.
       *
       * The shared-lock-then-upgrade deadlock is why the order is this way round
       * and not the other.
       */
      await this.deps.bots.lockTenantForBotChange(scope, tx);
      await this.requireActiveScope(scope, tx);
      if (registered) {
        // Written only on success. A digest stored after a FAILED call would
        // make the next reconcile skip it, and the menu would stay wrong until
        // the list changed again.
        await this.deps.bots.markCommandsRegistered(
          scope,
          id,
          { revision, now: this.deps.clock.now() },
          tx,
        );
      }
      await this.deps.audit.record(
        scope,
        this.systemActor(),
        {
          action: 'bot.commands.register',
          entityType: 'BotInstance',
          entityId: id,
          before: { commandsRevision: stored },
          after: {
            commandsRevision: registered ? revision : stored,
            commands: desired.entries.length,
          },
          result: registered ? 'SUCCESS' : 'FAILED',
        },
        tx,
      );
    });
  }

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
          `Telegram rejected the bot token: ${this.telegramText(probe.detail, token)}. Nothing was stored: the token is ` +
            'validated with Telegram before anything is written, so there is no credential here ' +
            'to repair and nothing to undo. Check the token in BotFather and run this again with ' +
            'a corrected one.',
        );
      }
      /*
       * The STORED token was refused — the incident-A state (`telegram.rejected.401`).
       *
       * This used to say no supported recovery existed (`OQ-TG-01`). Since R4 one does: the
       * Web Admin's token replacement validates a new token for the SAME bot, registers and
       * reads back the webhook keeping queued updates, and only then stores it. Telling an
       * operator standing at a revoked token that nothing can be done sent them to raw Bot
       * API calls instead. This command still never replaces a stored token itself.
       */
      throw errors.configuration(
        PLATFORM_ERROR_CODES.TELEGRAM_BOOTSTRAP_TOKEN_REJECTED,
        `Telegram rejected the bot token this installation has stored: ${this.telegramText(probe.detail, token)}. ` +
          'Nothing was changed. This command never replaces a stored token, so rerunning it ' +
          "cannot help. Issue the bot's current token in BotFather and replace it on the bot's " +
          'page in the Web Admin: that checks it is the same bot, registers and verifies the ' +
          'webhook keeping queued updates, and only then stores it. `botctl telegram status` ' +
          'then shows both sides.',
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
        `The configured Telegram API base answered, and what came back does not describe a bot: ${this.telegramText(probe.detail, token)}. ` +
          'TELEGRAM_API_BASE_URL is pointing at something that is not Telegram. The bot token is ' +
          'not the problem and does not need reissuing in BotFather; correct that variable and run ' +
          'this again.',
      );
    }
    if (probe.outcome !== 'IDENTIFIED') {
      /*
       * OUTBOUND, and the message says so because the installer used to guess
       * inbound (`OQ-TG-04` item 12).
       *
       * This is a call FROM this host TO Telegram, made before `setWebhook` is
       * reached at all. The installer's classifier had no arm for this code, so
       * the failure fell through to a summary about DNS for the operator's own
       * domain and a certificate not yet issued — the opposite network boundary,
       * and an afternoon spent looking at a webhook that was never attempted.
       *
       * "Rerun the installer" is kept, because for a timeout or a 5xx that IS
       * the remedy; what it now says is where to look first if rerunning does
       * not help.
       */
      throw new NexaError({
        kind: 'UPSTREAM_UNAVAILABLE',
        code: PLATFORM_ERROR_CODES.TELEGRAM_BOOTSTRAP_UNREACHABLE,
        message:
          `Telegram could not be reached: ${this.telegramText(probe.detail, token)}. This is OUTBOUND: a call from this ` +
          'host to the Telegram API, made before any webhook is registered — so DNS for your own ' +
          'domain and your certificate are not involved and nothing was asked of them. Rerun the ' +
          'installer; if it keeps failing, check egress from this host to the Telegram API.',
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
      if (identity.username !== existing.username) {
        await this.reconcileRenamedUsername(scope, existing, identity);
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
   * D3 (roadmap, Telegram robustness): a bot renamed in BotFather.
   *
   * `getMe` with the stored token named the SAME bot id under a different username. The
   * stored copy is what the ops-group connect command (`/connect@<username>`), the Web
   * Admin's `t.me/<username>` links and every operator listing print, so until now a rename
   * left all of them pointing at a name Telegram no longer routes — and nothing reconciled
   * it short of a token replacement. A register (or installer rerun) is the operator's
   * "reconcile with Telegram", so it records the name here: same bot, audited, in a
   * transaction that takes the tenant's bot-change lock and reads scope activity, exactly
   * like the legacy identity fill beside it.
   *
   * Never fatal. A name another row still holds (`TAKEN`) changes nothing and is audited as
   * FAILED with the reason; a stopped scope changes nothing. The webhook is what this run is
   * for, and a stale display name must not stand between an operator and a working bot.
   * `botctl telegram status` stays read-only: it SHOWS the drift and never writes it.
   */
  private async reconcileRenamedUsername(
    scope: TenantContext,
    existing: BotBootstrapView,
    identity: BotIdentity,
  ): Promise<void> {
    const now = this.deps.clock.now();
    const actor = this.systemActor();
    await this.deps.uow.run(scope, async (tx) => {
      await this.deps.bots.lockTenantForBotChange(scope, tx);
      if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) return;
      const reconciled = await this.deps.bots.reconcileUsername(
        scope,
        existing.id,
        { telegramBotId: identity.botId, username: identity.username, now },
        tx,
      );
      if (reconciled.outcome === 'UNCHANGED') return;
      await this.deps.audit.record(
        scope,
        actor,
        {
          action: 'bot_instance.username_reconciled',
          entityType: 'BotInstance',
          entityId: existing.id,
          before: { telegramBotId: identity.botId, username: reconciled.before },
          after: {
            telegramBotId: identity.botId,
            username: reconciled.outcome === 'UPDATED' ? identity.username : reconciled.before,
            reported: identity.username,
          },
          reason:
            reconciled.outcome === 'UPDATED'
              ? 'Telegram reports this bot under a new username (renamed in BotFather).'
              : 'Telegram reports this bot under a username another bot row still holds; ' +
                'nothing was changed.',
          result: reconciled.outcome === 'UPDATED' ? 'SUCCESS' : 'FAILED',
        },
        tx,
      );
    });
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
   * The audit row a registration that did not complete leaves behind: WHICH stage, what
   * Telegram answered (its outcome word and its redacted reason), the URL expected and the
   * one seen, and whether the queue would have been kept. Never the token or the secret.
   *
   * So the next failure is attributable after the fact: before this, a `botctl telegram
   * register` that Telegram refused or that read back wrong left nothing but the terminal
   * it printed to. Best effort and outside any transaction, like
   * `BotManagementService.recordIncomplete`: the caller is about to throw the failure the
   * operator must see, and a failed audit write must not replace it with another.
   */
  private async recordRegistrationFailure(
    scope: TenantContext,
    view: BotBootstrapView,
    failure: {
      readonly stage: 'SET_WEBHOOK' | 'VERIFY_WEBHOOK';
      readonly outcome: string;
      readonly expectedUrl: string;
      readonly remoteUrl: string | null;
      readonly telegramReason: string | null;
      readonly dropPendingUpdates: boolean;
    },
  ): Promise<void> {
    try {
      await this.deps.audit.record(scope, this.systemActor(), {
        action: 'bot_instance.webhook_registered',
        entityType: 'BotInstance',
        entityId: view.id,
        before: { webhookUrl: view.webhookUrl },
        after: { ...failure },
        reason: 'Installation bootstrap: Telegram webhook registration did not complete.',
        result: 'FAILED',
      });
    } catch (error) {
      // Deliberately not rethrown — see the docblock.
      void error;
    }
  }

  /** A registration Telegram accepted and then did not show holding. */
  private verificationFailure(
    after: BotWebhookRead,
    url: string,
    recorded: string | null,
  ): NexaError {
    const intact =
      'The bot instance and its encrypted token are stored and correct; nothing was undone, ' +
      'and nothing was recorded as registered.';
    const seen =
      after.outcome === 'READ'
        ? after.url === url
          ? 'it holds this URL but leaves out update types this bot handles'
          : after.url === null
            ? 'it holds no webhook URL at all'
            : `it holds ${shownWebhookUrl(after.url, recorded, url) ?? 'another URL'}`
        : after.outcome === 'REJECTED'
          ? 'it refused the token when asked'
          : 'it could not be asked';
    return new NexaError({
      kind: 'UPSTREAM_UNAVAILABLE',
      code: PLATFORM_ERROR_CODES.TELEGRAM_BOOTSTRAP_WEBHOOK_FAILED,
      message:
        `Telegram accepted the webhook ${url}, but reading it back showed that ${seen}. ` +
        `${intact} Run \`botctl telegram status\` to see both sides, then run this again; ` +
        'it keeps queued updates.',
    });
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
  private webhookFailure(
    registration: Exclude<WebhookRegistration, { outcome: 'REGISTERED' }>,
    token: string,
  ): Error {
    // Telegram's text, without the token should it ever be echoed, redacted and bounded.
    const outcome = { ...registration, detail: this.telegramText(registration.detail, token) };
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
    // One composition, shared with the Web Admin's token replacement (R4), so the URL
    // the installer registers and the URL a replacement re-registers cannot differ.
    return telegramWebhookUrl(origin, botInstanceId);
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
