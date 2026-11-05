import {
  HOSTING_ACTIVATION_ERROR_CODES as CODES,
  hostedActivationRedeemRequestSchema,
  systemContext,
  type ActorContext,
  type AuditWriter,
  type Clock,
  type PasswordHasher,
  type TenantContext,
  type UnitOfWork,
} from '@nexa/contracts';
import type { OutboxWriter } from '../../eventing/infrastructure/outbox-writer.js';
import type { ScopeActivityReader } from '../../system/application/record-ping.service.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import {
  activationLinkState,
  digestsEqual,
  hashActivationToken,
} from '../domain/activation-link.js';
import { normaliseHost } from '../domain/hosted-domain.js';
import type {
  HostedDomainDirectory,
  HostedDomainResolution,
  HostedOwnerActivationSystemPath,
} from './activation-ports.js';
import { activationError } from './hosted-activation.service.js';

export interface HostedOwnerActivationDeps {
  readonly directory: HostedDomainDirectory;
  readonly system: HostedOwnerActivationSystemPath;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly scopeActivity: ScopeActivityReader;
  readonly audit: AuditWriter;
  readonly outbox: OutboxWriter;
  readonly hasher: PasswordHasher;
  readonly clock: Clock;
  /** This server's own names (normalised): never resolved to a hosted tenant. */
  readonly reservedHosts: ReadonlySet<string>;
}

/**
 * Phase 6A PR-4 (D2) — a request's Host resolved to a hosted tenant, the edge's certificate
 * question, and the hosted owner's redemption of their one-time link.
 *
 * `resolveHost` is the ONLY way the Web Admin learns that a request belongs to a hosted
 * tenant, and it believes only what the caller already established: the host string is the
 * one `request.hostname` produced (Fastify honours `X-Forwarded-Host` only from a peer in
 * `TRUSTED_PROXY_IPS`; from anyone else it is the plain Host header, and the Host header of a
 * direct request can name only a domain that is itself DNS-verified and points here). Unknown
 * hosts — and every one of this server's own names — resolve to nothing, so the installation
 * keeps its behaviour. It reads through `HostedDomainDirectory`, the single unscoped port.
 *
 * `redeem` is the hosted owner's activation: anonymous by design (they have no account yet),
 * so its protection is the token — 256 random bits, only a hash stored, compared in constant
 * time — plus being valid ONLY on the domain the link was made for. The token is also the
 * request's idempotency key: it is spent by one conditional UPDATE inside the transaction that
 * sets the credentials, so a replay finds it used and changes nothing.
 */
export class HostedOwnerActivationService {
  constructor(private readonly deps: HostedOwnerActivationDeps) {}

  async resolveHost(rawHost: string | null | undefined): Promise<HostedDomainResolution | null> {
    const host = normaliseHost(rawHost);
    if (host === null || this.deps.reservedHosts.has(host)) return null;
    return this.deps.directory.resolveHost(host);
  }

  /** The edge's question: may a certificate be issued for this name? */
  async certificateAllowed(rawDomain: string | null | undefined): Promise<boolean> {
    const host = normaliseHost(rawDomain);
    if (host === null || this.deps.reservedHosts.has(host)) return false;
    return this.deps.directory.certificateAllowed(host);
  }

  async redeem(rawHost: string | undefined, actor: ActorContext, input: unknown): Promise<void> {
    const command = hostedActivationRedeemRequestSchema.parse(input);
    const resolution = await this.resolveHost(rawHost);
    const tokenHash = hashActivationToken(command.token);
    const link = await this.deps.directory.findLinkByHash(tokenHash);
    if (
      resolution === null ||
      link === null ||
      !digestsEqual(link.tokenHash, tokenHash) ||
      // Valid only on the domain it was made for: a link carried to any other host is dead.
      link.hostedTenantId !== resolution.hostedTenantId
    ) {
      throw activationError(CODES.LINK_INVALID, 'This activation link is not valid.');
    }
    const now = this.deps.clock.now();
    const state = activationLinkState(link, now);
    if (state === 'USED') {
      throw activationError(CODES.LINK_USED, 'This activation link was already used.');
    }
    if (state === 'EXPIRED') {
      throw activationError(CODES.LINK_EXPIRED, 'This activation link has expired.');
    }
    const passwordHash = await this.deps.hasher.hash(command.password);
    const hosted: TenantContext = {
      tenantId: link.hostedTenantId as TenantContext['tenantId'],
      botInstanceId: null,
    };
    const context = systemContext('hosting.activate_owner');

    await this.deps.uow.run(hosted, async (tx) => {
      if (!(await this.deps.scopeActivity.scopeIsActive(hosted, tx))) {
        throw activationError(
          CODES.BOT_NOT_ACTIVE,
          'This bot is not active, so its panel cannot be activated.',
        );
      }
      const stamp = this.deps.clock.now();
      // Spent FIRST, by the conditional UPDATE that is the single-use guarantee. The credential
      // change below shares this transaction: if it fails, the link is not spent.
      if (!(await this.deps.system.burnLink(context, link.id, stamp, tx))) {
        throw activationError(CODES.LINK_USED, 'This activation link is no longer valid.');
      }
      const set = await this.deps.system.setOwnerCredentials(
        context,
        {
          hostedTenantId: link.hostedTenantId,
          ownerAdminId: link.ownerAdminId,
          username: command.username,
          ...(command.displayName === undefined ? {} : { displayName: command.displayName }),
          passwordHash,
          now: stamp,
        },
        tx,
      );
      if (set === 'USERNAME_TAKEN') {
        throw activationError(CODES.USERNAME_TAKEN, 'That username is taken. Choose another.');
      }
      if (set === 'NOT_FOUND') {
        throw activationError(CODES.LINK_INVALID, 'This activation link is not valid.');
      }
      await this.deps.system.markOwnerActivated(
        context,
        { tenantId: link.tenantId, hostedTenantId: link.hostedTenantId, now: stamp },
        tx,
      );
      await this.deps.audit.record(
        hosted,
        actor,
        {
          action: 'hosting.owner_activated',
          entityType: 'Admin',
          entityId: link.ownerAdminId,
          before: null,
          // The username they chose; never the password, never the token or its hash.
          after: { username: command.username, linkId: link.id },
          result: 'SUCCESS',
        },
        tx,
      );
      await this.deps.outbox.write(tx, actor, {
        eventType: 'HostedBotOwnerActivated',
        aggregateType: 'Tenant',
        aggregateId: link.hostedTenantId,
        payload: { hostedTenantId: link.hostedTenantId, ownerAdminId: link.ownerAdminId },
      });
    });
  }
}
