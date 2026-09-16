import type {
  BotInstance,
  BotInstanceId,
  BotInstanceStatus,
  ScopeContext,
  Tenant,
  TenantId,
  TenantStatus,
} from '@nexa/contracts';

/**
 * Ports owned by the tenancy module.
 *
 * The application layer declares what it needs; the persistence layer
 * implements it and depends inward. Nothing here knows about Drizzle.
 */

export interface TenantRepository {
  /** Looked up by id under the system scope — resolving a tenant precedes having one. */
  findById(id: TenantId): Promise<Tenant | null>;
  findBySlug(slug: string): Promise<Tenant | null>;
  /**
   * The installation's primary tenant, resolved at boot.
   *
   * A RESELLER_BOT tenant is never it: reseller tenants are children, and the
   * Web Admin authenticates against the installation's own tenant.
   */
  findPrimary(): Promise<Tenant | null>;
  /** Scoped read: returns the tenant only if the scope permits seeing it. */
  findInScope(scope: ScopeContext): Promise<Tenant | null>;
}

export interface BotInstanceRepository {
  /**
   * Resolves a bot by id without a tenant, the way `TenantRepository.findById`
   * does: an inbound Telegram update names the bot, and the tenant is what this
   * lookup PRODUCES. Every call made afterwards is scoped to the tenant it
   * returns.
   */
  findById(id: BotInstance['id']): Promise<BotInstance | null>;
  /** Scoped: a tenant may only list its own bot instances. */
  listForTenant(scope: ScopeContext): Promise<BotInstance[]>;
  findByUsername(scope: ScopeContext, username: string): Promise<BotInstance | null>;
  /** Resolves the bot token for outbound calls. Decrypts; never returned to a surface. */
  resolveToken(scope: ScopeContext, id: BotInstance['id']): Promise<string>;
}

/**
 * What the fresh-install bootstrap needs to see about a tenant's bot.
 *
 * NOT `BotInstance`. That contract type is what a SURFACE may hold, and it
 * deliberately carries a `tokenSecretRef` and nothing else about the credential.
 * This is the installer's view: the three fields that decide what the bootstrap
 * does next, and none of them is a secret.
 *
 * `webhookRegisteredAt` is the whole recovery story in one column — see the
 * docblock on the schema. A row with it NULL is a bootstrap that has not
 * finished, whichever of the two crashes produced it.
 */
export interface BotBootstrapView {
  readonly id: BotInstanceId;
  readonly username: string;
  readonly status: BotInstanceStatus;
  readonly telegramBotId: string | null;
  readonly webhookRegisteredAt: Date | null;
  readonly webhookUrl: string | null;
  /** SHA-256 of the secret it was registered with. NULL means unknown. */
  readonly webhookSecretFingerprint: string | null;
}

/**
 * The writes the fresh-install bootstrap makes, and no others.
 *
 * A narrow port rather than four more methods on `BotInstanceRepository`,
 * because every one of these is reachable only from a provisioning CLI and
 * `scripts/check-boundaries.sh` fails the build if a surface imports the service
 * that uses them. Widening the repository port every surface already holds would
 * put "create a bot instance" one autocomplete away from an HTTP controller.
 *
 * There is deliberately NO method that writes a token to an existing row.
 * ADR-0029 decision 3: the normal installer reconciles and never rotates, and
 * the cheapest way to keep a later convenience refactor from breaking that is
 * for the capability not to exist.
 */
export interface BotBootstrapRepository {
  /**
   * Serialises bot creation within a tenant, by locking the TENANT row.
   *
   * The same row `lockTenantForAdminChange` takes, deliberately: two installers
   * racing on one fresh install are the case this exists for, and they must not
   * be able to create two bot instances between one another's reads. Returns the
   * status read by the same statement that took the lock, so the two cannot
   * disagree.
   */
  lockTenantForBotChange(scope: ScopeContext, tx: unknown): Promise<TenantStatus>;
  /**
   * The tenant's bot, whatever state it is in.
   *
   * Status is NOT filtered. A bot an operator has stopped is still this
   * installation's bot, and creating a second one because the first is not
   * ACTIVE is precisely the repointing ADR-0029 refuses. The service reports the
   * state instead.
   */
  findBootstrapTarget(scope: ScopeContext, tx?: unknown): Promise<BotBootstrapView | null>;
  /** Encrypts the token here; the plaintext never leaves this call. */
  createFromBootstrap(
    scope: ScopeContext,
    input: {
      readonly id: BotInstanceId;
      readonly username: string;
      readonly telegramBotId: string;
      readonly token: string;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<void>;
  /** Written AFTER Telegram accepted, which is what makes both crashes converge. */
  markWebhookRegistered(
    scope: ScopeContext,
    id: BotInstanceId,
    input: { readonly url: string; readonly secretFingerprint: string; readonly now: Date },
    tx: unknown,
  ): Promise<void>;
  /**
   * Records the identity `getMe` reported for a row that predates the column.
   *
   * Not a rotation and not a repoint: it fills a NULL with the answer Telegram
   * gave for the token already stored on that row. A row whose
   * `telegram_bot_id` is set is never rewritten here.
   */
  /** Returns whether the row was still blank — see the WHERE clause. */
  recordTelegramIdentity(
    scope: ScopeContext,
    id: BotInstanceId,
    input: { readonly telegramBotId: string; readonly username: string; readonly now: Date },
    tx: unknown,
  ): Promise<boolean>;
}

/**
 * What Telegram answered when asked who a token belongs to.
 *
 * Three outcomes, because they have three different remedies and the bootstrap
 * turns each into a different error code. The transport's own taxonomy —
 * retryable versus permanent, 429, an unreadable 2xx — is collapsed into them by
 * the adapter, which is where transport vocabulary belongs. This layer asks a
 * question about a bot and gets an answer about a bot.
 */
export type BotIdentityProbe =
  | { readonly outcome: 'IDENTIFIED'; readonly botId: string; readonly username: string }
  /** Telegram answered, and its answer was no. A new token is the remedy. */
  | { readonly outcome: 'REJECTED'; readonly detail: string }
  /**
   * The configured API base answered, and what came back is not a bot.
   *
   * Its own outcome rather than a `REJECTED` with a different message, because
   * the SERVICE decides the error code from this and the two codes have
   * different remedies. Folding it back in is how the distinction was lost the
   * first time: it exists in the transport, and the adapter discarded it.
   */
  | { readonly outcome: 'NOT_TELEGRAM'; readonly detail: string }
  /** Telegram could not be asked. Waiting and rerunning is the remedy. */
  | { readonly outcome: 'UNREACHABLE'; readonly detail: string };

export type WebhookRegistration =
  | { readonly outcome: 'REGISTERED' }
  /** Telegram looked at the URL and refused it. Waiting does not fix it. */
  | { readonly outcome: 'REFUSED'; readonly detail: string }
  | { readonly outcome: 'UNREACHABLE'; readonly detail: string };

/**
 * The two Telegram calls the fresh-install bootstrap makes.
 *
 * A port rather than a direct import of `infrastructure/telegram/send-message.ts`,
 * for the reason `check-boundaries.sh` gives about every other sink: the
 * application layer declares what it needs and infrastructure implements it, and
 * the adapter is where the no-network-inside-a-transaction assertion lives. It
 * also makes the service testable without a socket, which is what lets the crash
 * and rerun paths be exercised at all.
 */
export interface BotBootstrapTelegram {
  identify(token: string): Promise<BotIdentityProbe>;
  registerWebhook(input: {
    readonly token: string;
    readonly url: string;
    readonly secretToken: string;
    /**
     * Discard whatever Telegram has queued. TRUE only on a first registration.
     *
     * On a fresh install the queue predates the installation and belongs to
     * whatever the token was used for before. On a re-registration it is a
     * running installation's customers, and discarding it is a destructive
     * action with no count and no confirmation.
     */
    readonly dropPendingUpdates: boolean;
  }): Promise<WebhookRegistration>;

  /**
   * Registers the command menu with Telegram. Answers whether it landed.
   *
   * The COMMANDS are not a parameter. `BOT_COMMANDS` is the one list and rendering its
   * descriptions needs the catalogue, which an application file may not import — so the
   * adapter does both and this layer decides only whether to call it.
   *
   * A BOOLEAN, not a structured outcome, and that is the difference from
   * `registerWebhook`: a failed webhook makes the install INCOMPLETE because updates do
   * not arrive, and a failed command menu means a customer types `/help` instead of
   * tapping it. Two failures of very different weight should not share a shape that
   * invites the caller to treat them alike.
   */
  registerCommands(input: { readonly token: string }): Promise<boolean>;
}

export const TENANT_REPOSITORY = Symbol('TENANT_REPOSITORY');
export const BOT_INSTANCE_REPOSITORY = Symbol('BOT_INSTANCE_REPOSITORY');
