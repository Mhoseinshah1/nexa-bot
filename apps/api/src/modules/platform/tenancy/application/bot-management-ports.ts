import type {
  BotInstanceId,
  BotInstanceStatus,
  BotOperatorStatus,
  ScopeContext,
  TenantKind,
  TenantStatus,
} from '@nexa/contracts';
import type { BotIdentityProbe, WebhookRegistration } from './ports.js';

/**
 * What the Web Admin's bot management reads about one bot instance (WP13).
 *
 * NOT `BotInstance`, and deliberately without any credential field: no ciphertext, no
 * key id and no fingerprint VALUE. The fingerprint is compared inside the service and
 * leaves it as a word. A projection that cannot carry a secret is the rule ADR-0023
 * applies to panel credentials, and it holds here for the same reason — no response
 * builder can leak what the repository never selected.
 */
export interface BotManagementRecord {
  readonly id: BotInstanceId;
  readonly username: string;
  readonly telegramBotId: string | null;
  readonly status: BotInstanceStatus;
  readonly webhookRegisteredAt: Date | null;
  readonly webhookUrl: string | null;
  /**
   * Whether the registered secret's digest equals `currentFingerprint`, computed in SQL.
   *
   * The repository is handed the current digest and answers with the comparison, so the
   * stored digest never leaves the database. NULL when the column is NULL (unknown).
   */
  readonly webhookSecretMatches: boolean | null;
  readonly commandsRevision: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly tenant: {
    readonly id: string;
    readonly slug: string;
    readonly displayName: string;
    readonly kind: TenantKind;
    readonly status: TenantStatus;
  };
}

export interface BotManagementRepository {
  /** The tenant's bots, oldest first — the order `activeTokenForTenant` resolves in. */
  listManaged(
    scope: ScopeContext,
    currentFingerprint: string | null,
  ): Promise<BotManagementRecord[]>;
  findManaged(
    scope: ScopeContext,
    id: BotInstanceId,
    currentFingerprint: string | null,
    tx?: unknown,
  ): Promise<BotManagementRecord | null>;
  /** Takes the bot row `FOR UPDATE` and answers its status and identity under the lock. */
  lockManaged(
    scope: ScopeContext,
    id: BotInstanceId,
    tx: unknown,
  ): Promise<{ readonly status: BotInstanceStatus; readonly telegramBotId: string | null } | null>;
  /** A conditional UPDATE naming the `from` state. False when the row was not in it. */
  transitionStatus(
    scope: ScopeContext,
    id: BotInstanceId,
    change: {
      readonly from: BotInstanceStatus;
      readonly to: BotOperatorStatus;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<boolean>;
  /**
   * R4 — take this bot's token-replacement claim: a conditional UPDATE that succeeds when
   * no claim is held or the one held has expired. The guard that keeps two replacements
   * (two tabs, a double-click under two keys, two api replicas) from interleaving their
   * Telegram calls, which no row lock can do — a lock ends with its transaction, and the
   * Telegram calls must run outside one. False when a live claim is held.
   */
  claimTokenReplacement(
    scope: ScopeContext,
    id: BotInstanceId,
    claim: { readonly id: string; readonly now: Date; readonly until: Date },
    tx: unknown,
  ): Promise<boolean>;
  /** Drops the claim WHERE it is still `claimId`; a claim taken over since is left alone. */
  releaseTokenReplacement(
    scope: ScopeContext,
    id: BotInstanceId,
    claimId: string,
    tx: unknown,
  ): Promise<void>;
  /**
   * R4 — the activation: the token (when `token` is non-null, encrypted here), the
   * identity `getMe` proved, and the webhook registration Telegram was verified to hold,
   * in ONE conditional UPDATE — WHERE the row still names `telegramBotId` (a replacement
   * never repoints) AND still holds `claimId` (a claim that expired and was taken over
   * activates nothing). The claim is released by the same statement. False when either
   * predicate missed.
   *
   * The username is written only when no OTHER row holds it: the column is unique across
   * the installation, and a stale copy on another row must not turn a verified
   * replacement into a failed one.
   */
  activateTokenReplacement(
    scope: ScopeContext,
    id: BotInstanceId,
    input: {
      readonly claimId: string;
      readonly token: string | null;
      readonly telegramBotId: string;
      readonly username: string;
      readonly webhookUrl: string;
      readonly webhookSecretFingerprint: string;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<boolean>;
  /** Decrypts the stored token whatever the status. Only ever compared, never returned. */
  resolveToken(scope: ScopeContext, id: BotInstanceId): Promise<string>;
  /** The token of an ACTIVE bot, or null — the rule every outbound use obeys (`OQ-5R-02`). */
  tokenForBotInstance(scope: ScopeContext, id: BotInstanceId): Promise<string | null>;
}

/** What `getWebhookInfo` answered, in the bot's vocabulary rather than the transport's. */
export type BotWebhookRead =
  | {
      readonly outcome: 'READ';
      readonly url: string | null;
      readonly pendingUpdateCount: number | null;
      readonly lastErrorAt: Date | null;
      readonly lastErrorMessage: string | null;
      readonly maxConnections: number | null;
      /** `allowed_updates`, or null for Telegram's default set. */
      readonly allowedUpdates: readonly string[] | null;
    }
  | { readonly outcome: 'REJECTED' }
  | { readonly outcome: 'UNREACHABLE' };

/**
 * What `deleteWebhook` answered. `UNREACHABLE` may or may not have taken effect, so the
 * caller reads the registration back rather than believing either.
 */
export type BotWebhookRemoval =
  | { readonly outcome: 'REMOVED' }
  | { readonly outcome: 'REFUSED' }
  | { readonly outcome: 'UNREACHABLE' };

/**
 * The Telegram calls bot management makes, and the menu digest it compares against.
 *
 * `identify`, `registerWebhook` and `commandsRevision` are the bootstrap gateway's own
 * methods, so a token is judged, a webhook registered and a menu digested by one
 * implementation (`CLAUDE.md`: "the copy that would silently keep the old behaviour is the
 * unattended one").
 *
 * R4 added the two writes. `registerWebhook` is reached only from a token replacement,
 * with the URL the installation already registered (its recorded origin, recomposed) —
 * never a URL a request supplies. `removeWebhook` is reached only from that replacement's
 * compensation. `setMyCommands` stays with the fenced bootstrap.
 */
export interface BotManagementTelegram {
  identify(token: string): Promise<BotIdentityProbe>;
  readWebhook(token: string): Promise<BotWebhookRead>;
  registerWebhook(input: {
    readonly token: string;
    readonly url: string;
    readonly secretToken: string;
    readonly dropPendingUpdates: boolean;
    readonly resetAllowedUpdates?: boolean;
  }): Promise<WebhookRegistration>;
  removeWebhook(token: string): Promise<BotWebhookRemoval>;
  commandsRevision(): string;
}
