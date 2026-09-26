import type {
  BotInstanceId,
  BotInstanceStatus,
  BotOperatorStatus,
  ScopeContext,
  TenantKind,
  TenantStatus,
} from '@nexa/contracts';
import type { BotIdentityProbe } from './ports.js';

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
   * Encrypts `token` here and replaces the stored one, WHERE the row still carries
   * `telegramBotId` — a replacement never repoints. False when it does not.
   */
  replaceToken(
    scope: ScopeContext,
    id: BotInstanceId,
    input: { readonly token: string; readonly telegramBotId: string; readonly now: Date },
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
    }
  | { readonly outcome: 'REJECTED' }
  | { readonly outcome: 'UNREACHABLE' };

/**
 * The Telegram READS bot management makes, and the menu digest it compares against.
 *
 * `identify` and `commandsRevision` are the bootstrap gateway's own methods, so a token
 * is judged and a menu is digested by one implementation (`CLAUDE.md`: "the copy that
 * would silently keep the old behaviour is the unattended one"). There is no write here:
 * `setWebhook` and `setMyCommands` stay with the fenced bootstrap.
 */
export interface BotManagementTelegram {
  identify(token: string): Promise<BotIdentityProbe>;
  readWebhook(token: string): Promise<BotWebhookRead>;
  commandsRevision(): string;
}
