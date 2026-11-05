import type {
  HostedActivationStep,
  HostedBotState,
  ScopeContext,
  SystemContext,
} from '@nexa/contracts';
import type { BotIdentityProbe } from '../../tenancy/application/ports.js';
import type { DnsObservation } from '../domain/hosted-domain.js';

/**
 * Phase 6A PR-4 — the activation's ports.
 *
 * Four of them, split by WHOSE rows they touch (the line row-level security, ADR-0037, draws):
 *
 * - `HostedActivationRepository`: the INSTALLATION tenant's own rows (the activation record and
 *   its links), every method scope-explicit like any tenant-scoped repository.
 *
 * - `HostedBotRegistrar`: what the creator's steps do INSIDE the hosted tenant — bind its bot
 *   instance, register its webhook. Every method takes an explicit `SystemContext`
 *   (`hosting.activation_*`) AND the hosted scope, so at the merge with RLS the lead routes
 *   exactly these through the system path and nothing else.
 *
 * - `HostedDomainDirectory`: THE ONE place that reads across tenants before the tenant is
 *   known — a request's Host header and an activation token are both resolved to a tenant HERE
 *   and nowhere else. Unscoped by nature (the caller has no tenant yet); everything it returns
 *   is a tenant id, a word, or a hash, never a credential. Route it through the system path.
 *
 * - `HostedOwnerActivationSystemPath`: the redemption's writes (burn the link, set the hosted
 *   owner's credentials, mark the activation), `SystemContext` each.
 *
 * Two more are the network: `HostedDnsResolver` and `HostedTlsProbe`, injectable for tests.
 */

export interface HostedActivationRow {
  readonly tenantId: string;
  readonly hostedTenantId: string;
  readonly botInstanceId: string | null;
  readonly domain: string | null;
  readonly tokenVerifiedAt: Date | null;
  readonly dnsVerifiedAt: Date | null;
  readonly tlsVerifiedAt: Date | null;
  readonly webhookRegisteredAt: Date | null;
  readonly lastErrorStep: HostedActivationStep | null;
  readonly lastErrorCode: string | null;
  readonly lastErrorAt: Date | null;
  readonly ownerActivatedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** `undefined` leaves a column alone; `null` clears it. */
export interface HostedActivationPatch {
  readonly botInstanceId?: string | null;
  readonly domain?: string | null;
  readonly tokenVerifiedAt?: Date | null;
  readonly dnsVerifiedAt?: Date | null;
  readonly tlsVerifiedAt?: Date | null;
  readonly webhookRegisteredAt?: Date | null;
  readonly error?: { readonly step: HostedActivationStep; readonly code: string } | null;
}

export interface HostedActivationLinkRow {
  readonly id: string;
  readonly hostedTenantId: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly usedAt: Date | null;
  readonly revokedAt: Date | null;
}

export interface HostedActivationRepository {
  find(
    scope: ScopeContext,
    hostedTenantId: string,
    tx?: unknown,
    lock?: boolean,
  ): Promise<HostedActivationRow | null>;
  /** The row, created blank when there is none yet. Idempotent. */
  ensure(
    scope: ScopeContext,
    hostedTenantId: string,
    now: Date,
    tx: unknown,
  ): Promise<HostedActivationRow>;
  patch(
    scope: ScopeContext,
    hostedTenantId: string,
    patch: HostedActivationPatch,
    now: Date,
    tx: unknown,
  ): Promise<void>;
  /** Whether another hosted bot holds this domain. */
  domainTaken(
    scope: ScopeContext,
    domain: string,
    exceptHostedTenantId: string,
    tx?: unknown,
  ): Promise<boolean>;
  newestLink(
    scope: ScopeContext,
    hostedTenantId: string,
    tx?: unknown,
  ): Promise<HostedActivationLinkRow | null>;
  /** Revokes every unused, unexpired link of this hosted bot: a new link replaces them. */
  revokeOpenLinks(
    scope: ScopeContext,
    hostedTenantId: string,
    now: Date,
    tx: unknown,
  ): Promise<number>;
  insertLink(
    scope: ScopeContext,
    link: {
      readonly id: string;
      readonly hostedTenantId: string;
      readonly tokenHash: string;
      readonly createdByAdminId: string;
      readonly createdAt: Date;
      readonly expiresAt: Date;
    },
    tx: unknown,
  ): Promise<void>;
}

export interface HostedBotBinding {
  readonly botInstanceId: string;
  readonly username: string;
  readonly telegramBotId: string;
}

/** What the registrar answers for a webhook registration. */
export type HostedWebhookOutcome =
  { readonly outcome: 'REGISTERED' } | { readonly outcome: 'FAILED'; readonly detail: string };

export interface HostedBotRegistrar {
  /**
   * Whether ANOTHER bot instance (any tenant, the installation's own included) already holds
   * this Telegram bot or username. A courtesy before the write: the unique indexes are the
   * guarantee.
   */
  identityHeldElsewhere(
    context: SystemContext,
    input: {
      readonly telegramBotId: string;
      readonly username: string;
      readonly hostedTenantId: string;
    },
  ): Promise<boolean>;
  /** The hosted tenant's bot instance, whatever its state, or null. */
  currentBot(context: SystemContext, hostedTenantId: string): Promise<HostedBotBinding | null>;
  /**
   * Stores the verified token, encrypted, on the hosted tenant's bot instance — creating it
   * when there is none. Never repoints: an existing instance bound to ANOTHER Telegram bot is
   * answered as `OTHER_BOT`, and an existing one for the same bot is left untouched
   * (`EXISTING`: the stored token is not rewritten).
   */
  bind(
    context: SystemContext,
    input: {
      readonly hostedTenantId: string;
      readonly botInstanceId: string;
      readonly username: string;
      readonly telegramBotId: string;
      readonly token: string;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<
    | { readonly outcome: 'CREATED' | 'EXISTING'; readonly binding: HostedBotBinding }
    | { readonly outcome: 'OTHER_BOT' }
  >;
  /** The stored token, decrypted, for a re-verification. Never returned to a surface. */
  tokenOf(context: SystemContext, hostedTenantId: string, botInstanceId: string): Promise<string>;
  /**
   * Registers Telegram's webhook for the hosted tenant's bot on `origin` (`https://<domain>`),
   * with the bot's own per-bot secret, through the existing bootstrap. Never throws for a
   * Telegram or configuration refusal: they are `FAILED`.
   */
  registerWebhook(
    context: SystemContext,
    input: { readonly hostedTenantId: string; readonly origin: string },
  ): Promise<HostedWebhookOutcome>;
}

/** Telegram's `getMe`, the one the bootstrap and token replacement use. */
export interface HostedBotIdentifier {
  identify(token: string): Promise<BotIdentityProbe>;
}

export interface HostedDomainResolution {
  readonly installationTenantId: string;
  readonly hostedTenantId: string;
  readonly ownerAdminId: string;
  readonly botState: HostedBotState;
}

export interface HostedActivationLinkLookup extends HostedActivationLinkRow {
  readonly tenantId: string;
  readonly ownerAdminId: string;
  readonly tokenHash: string;
  readonly botState: HostedBotState;
}

export interface HostedDomainDirectory {
  /** The hosted tenant a DNS-VERIFIED domain belongs to; null for any other host. */
  resolveHost(host: string): Promise<HostedDomainResolution | null>;
  /** Whether a certificate may be issued for `host`: verified domain of an ACTIVE hosted bot. */
  certificateAllowed(host: string): Promise<boolean>;
  /** The activation link with this token hash. The redeemer has no tenant yet. */
  findLinkByHash(tokenHash: string): Promise<HostedActivationLinkLookup | null>;
}

export interface HostedOwnerActivationSystemPath {
  /**
   * Spends the link: ONE conditional UPDATE, WHERE it is unused, unrevoked and unexpired at
   * `now`. False when it was not (a concurrent redemption won, or it lapsed).
   */
  burnLink(context: SystemContext, linkId: string, now: Date, tx: unknown): Promise<boolean>;
  /**
   * The hosted owner's username, password hash (and display name, when chosen) — and every
   * Web Admin session of that admin revoked. `USERNAME_TAKEN` when another administrator of
   * the hosted tenant holds the name; `NOT_FOUND` when the owner is not an ACTIVE admin.
   */
  setOwnerCredentials(
    context: SystemContext,
    input: {
      readonly hostedTenantId: string;
      readonly ownerAdminId: string;
      readonly username: string;
      readonly displayName?: string;
      readonly passwordHash: string;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<'UPDATED' | 'USERNAME_TAKEN' | 'NOT_FOUND'>;
  /** Marks the activation record (the installation's) redeemed. */
  markOwnerActivated(
    context: SystemContext,
    input: { readonly tenantId: string; readonly hostedTenantId: string; readonly now: Date },
    tx: unknown,
  ): Promise<void>;
}

export interface HostedDnsResolver {
  /** Never throws for "no such name": that is an empty observation. Throws on a timeout. */
  observe(domain: string): Promise<DnsObservation>;
  /** A name's own A/AAAA answers; empty when it has none. Throws on a timeout. */
  addressesOf(hostname: string): Promise<readonly string[]>;
}

export type HostedTlsProbeResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'UNREACHABLE' | 'CERTIFICATE' | 'BAD_RESPONSE' };

export interface HostedTlsProbe {
  /** An HTTPS request to the domain with the certificate VERIFIED. Never throws. */
  probe(domain: string): Promise<HostedTlsProbeResult>;
}
