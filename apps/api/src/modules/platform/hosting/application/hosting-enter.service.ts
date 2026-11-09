import {
  errors,
  HOSTING_ERROR_CODES,
  hostedBotEnterRequestSchema,
  hostedEnterRedeemRequestSchema,
  PLATFORM_ERROR_CODES,
  systemContext,
  uuidV7Schema,
  type ActorContext,
  type AdminSessionId,
  type AuditWriter,
  type Clock,
  type CorrelationId,
  type HostedBotEnterResponse,
  type IdempotencyStore,
  type IdGenerator,
  type ScopeContext,
  type TenantContext,
  type UnitOfWork,
} from '@nexa/contracts';
import { hashRequest } from '../../idempotency/infrastructure/drizzle-idempotency-store.js';
import { rememberOnce } from '../../idempotency/application/remember-once.js';
import type { ScopeActivityReader } from '../../system/application/record-ping.service.js';
import type { SessionRepository } from '../../identity/application/ports.js';
import {
  generateSessionToken,
  hashSessionToken,
} from '../../identity/application/session-token.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import {
  enterTokenExpiry,
  enterUrl,
  generateEnterToken,
  hashEnterToken,
  hostPrincipalUsername,
} from '../domain/enter-token.js';
import { normaliseHost } from '../domain/hosted-domain.js';
import type { HostedActivationRepository, HostedDomainResolution } from './activation-ports.js';
import type { HostingEnterRepository } from './hosting-enter.ports.js';
import type { HostingOwnerGuard } from './hosting-owner-guard.js';
import type { HostingSectionService } from './hosting-section.service.js';
import type { HostingRepository } from './ports.js';

export interface HostingEnterDeps {
  readonly repository: Pick<HostingRepository, 'findHosted'>;
  readonly activations: Pick<HostedActivationRepository, 'find'>;
  readonly enter: HostingEnterRepository;
  readonly section: HostingSectionService;
  readonly owner: HostingOwnerGuard;
  readonly sessions: Pick<SessionRepository, 'create'>;
  readonly idempotency: IdempotencyStore;
  readonly scopeActivity: ScopeActivityReader;
  readonly audit: AuditWriter;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /** The Web Admin session lifetime: an entered session never outlives it either. */
  readonly sessionTtlSeconds: number;
  /** `HostedOwnerActivationService.resolveHost`: a request's Host → its hosted tenant. */
  readonly resolveHost: (host: string | null | undefined) => Promise<HostedDomainResolution | null>;
}

/** What the HTTP surface needs to set the entered session's cookie. Returned once. */
export interface OpenedEnteredSession {
  readonly token: string;
  readonly expiresAt: Date;
}

/**
 * Phase 6B — «ورود به پنل» (D5; ADR-0038 § Enter as refined by ADR-0039 § 9).
 *
 * `mint`: the installation owner, in «میزبانی‌ها» with a FRESH code, gets a 15-minute,
 * single-use token for ONE hosted tenant and ITS verified domain, recorded in HIS audit log. On
 * the first enter the hosted tenant's HOST principal is created in the same transaction.
 *
 * `redeem`: the hosted domain's `/enter` page posts the token. Spent by one conditional UPDATE
 * that names its audience (the tenant this request's Host resolves to AND that host), only
 * while the section session it was minted from and the owner's own Web Admin session are both
 * live. It opens an ordinary Web Admin session for the HOST principal, marked as entered and
 * expiring no later than the section session; every failure is the ONE code
 * `hosting.enter_token_invalid`. The session's acts are recorded in the owner's log, never the
 * hosted tenant's (the audit writer, `ActorContext.impersonation`).
 */
export class HostingEnterService {
  constructor(private readonly deps: HostingEnterDeps) {}

  async mint(
    scope: ScopeContext,
    actor: ActorContext,
    sectionToken: string | null,
    id: string,
    input: unknown,
  ): Promise<HostedBotEnterResponse> {
    const hostedTenantId = parseTenantId(id);
    const action = 'hosting.enter';
    const installation = await this.deps.section.requireSection(
      scope,
      actor,
      sectionToken,
      action,
      hostedTenantId,
    );
    const command = hostedBotEnterRequestSchema.parse(input);
    const requestHash = hashRequest({ action, hostedTenantId });
    const replay = await this.deps.idempotency.find(
      installation,
      actor.surface,
      command.idempotencyKey,
      requestHash,
    );
    // Only the token's hash is kept: a replay cannot show it again, and never mints a second.
    if (replay !== null) return { url: null, expiresAt: null, replayed: true };
    // Before the code: an entry that cannot happen spends nothing.
    await this.requireEnterable(installation, hostedTenantId);

    const token = generateEnterToken();
    const { result } = await this.deps.section.withFreshProof(
      installation,
      actor,
      command.proof,
      action,
      async (tx, now, method) => {
        await this.deps.owner.check(installation, actor, tx);
        const section = await this.deps.section.liveSectionIn(
          installation,
          actor,
          sectionToken,
          tx,
        );
        if (!(await this.deps.scopeActivity.scopeIsActive(installation, tx))) {
          throw errors.notFound(
            PLATFORM_ERROR_CODES.TENANT_NOT_FOUND,
            'This scope is not accepting work.',
          );
        }
        const domain = await this.requireEnterable(installation, hostedTenantId, tx);
        const candidate = this.deps.ids.uuid();
        const hostPrincipalId = await this.deps.enter.ensureHost(
          systemContext(action),
          {
            hostedTenantId,
            id: candidate,
            username: hostPrincipalUsername(candidate),
            now,
          },
          tx,
        );
        const tokenId = this.deps.ids.uuid();
        const expiresAt = enterTokenExpiry(now);
        await this.deps.enter.insertToken(
          installation,
          {
            id: tokenId,
            hostedTenantId,
            domain,
            ownerAdminId: actor.id as string,
            hostingSessionId: section.id,
            tokenHash: hashEnterToken(token),
            createdAt: now,
            expiresAt,
          },
          tx,
        );
        await this.deps.audit.record(
          installation,
          actor,
          {
            action,
            entityType: 'Tenant',
            entityId: hostedTenantId,
            before: null,
            // The token's id and lifetime — never the token, never its hash.
            after: {
              tokenId,
              domain,
              expiresAt: expiresAt.toISOString(),
              hostPrincipalId,
              proof: method,
            },
            result: 'SUCCESS',
          },
          tx,
        );
        await rememberOnce(
          this.deps.idempotency,
          installation,
          actor.surface,
          command.idempotencyKey,
          requestHash,
          { hostedTenantId, tokenId },
          tx,
        );
        return { domain, expiresAt };
      },
    );
    return {
      url: enterUrl(result.domain, token),
      expiresAt: result.expiresAt.toISOString(),
      replayed: false,
    };
  }

  async redeem(
    rawHost: string | null | undefined,
    request: {
      readonly correlationId: CorrelationId;
      readonly ip: string | null;
      readonly userAgent: string | null;
    },
    input: unknown,
  ): Promise<OpenedEnteredSession> {
    const parsed = hostedEnterRedeemRequestSchema.safeParse(input);
    const host = normaliseHost(rawHost);
    const resolution = host === null ? null : await this.deps.resolveHost(host);
    if (!parsed.success || host === null || resolution === null) throw invalidToken();
    const hosted: TenantContext = {
      tenantId: resolution.hostedTenantId as TenantContext['tenantId'],
      botInstanceId: null,
    };
    const tokenHash = hashEnterToken(parsed.data.token);
    const sessionToken = generateSessionToken();
    const sessionId = this.deps.ids.uuid() as AdminSessionId;

    const expiresAt = await this.deps.uow.run(hosted, async (tx) => {
      const now = this.deps.clock.now();
      if (!(await this.deps.scopeActivity.scopeIsActive(hosted, tx))) throw invalidToken();
      // Spent FIRST: everything below shares the transaction, so a refusal leaves it unspent
      // (and still useless, since what refused it does not come back on its own).
      const spent = await this.deps.enter.spend(
        systemContext('hosting.enter_redeem'),
        {
          tokenHash,
          hostedTenantId: resolution.hostedTenantId,
          domain: host,
          adminSessionId: sessionId,
          now,
        },
        tx,
      );
      if (spent === null) throw invalidToken();
      const mark = { byAdminId: spent.ownerAdminId, hostingSessionId: spent.hostingSessionId };
      const section = await this.deps.enter.sectionFacts(mark, now, tx);
      if (section === null || section.installationTenantId !== spent.installationTenantId) {
        throw invalidToken();
      }
      const hostPrincipalId = await this.deps.enter.hostOf(hosted, tx);
      if (hostPrincipalId === null) throw invalidToken();
      const ttlEnd = now.getTime() + this.deps.sessionTtlSeconds * 1000;
      const ends = new Date(Math.min(ttlEnd, section.expiresAt.getTime()));
      await this.deps.sessions.create(
        hosted,
        {
          id: sessionId,
          adminId: hostPrincipalId as never,
          tokenHash: hashSessionToken(sessionToken),
          issuedAt: now,
          expiresAt: ends,
          ip: request.ip,
          userAgent: request.userAgent,
          impersonation: mark,
        },
        tx,
      );
      const actor: ActorContext = {
        type: 'WEB_ADMIN',
        id: hostPrincipalId,
        label: section.ownerLabel,
        surface: 'WEB',
        correlationId: request.correlationId,
        sessionId,
        impersonation: {
          installationTenantId: section.installationTenantId,
          ownerAdminId: section.ownerAdminId,
          ownerLabel: section.ownerLabel,
          hostingSessionId: spent.hostingSessionId,
        },
        ...(request.ip === null ? {} : { ip: request.ip }),
        ...(request.userAgent === null ? {} : { userAgent: request.userAgent }),
      };
      // Into the OWNER's log (the actor carries `impersonation`): the hosted tenant's log
      // receives nothing, now or for anything this session does.
      await this.deps.audit.record(
        hosted,
        actor,
        {
          action: 'hosting.enter_opened',
          entityType: 'Tenant',
          entityId: resolution.hostedTenantId,
          before: null,
          after: { tokenId: spent.id, sessionId, expiresAt: ends.toISOString() },
          result: 'SUCCESS',
        },
        tx,
      );
      return ends;
    });
    return { token: sessionToken, expiresAt };
  }

  /** The bot is ACTIVE and its domain verified (DNS and TLS); answers the domain. */
  private async requireEnterable(
    installation: TenantContext,
    hostedTenantId: string,
    tx?: unknown,
  ): Promise<string> {
    const row = await this.deps.repository.findHosted(installation, hostedTenantId, tx);
    if (row === null) {
      throw errors.notFound(HOSTING_ERROR_CODES.BOT_NOT_FOUND, 'No such hosted bot.');
    }
    const activation = await this.deps.activations.find(installation, hostedTenantId, tx);
    if (
      row.state !== 'ACTIVE' ||
      activation === null ||
      activation.domain === null ||
      activation.dnsVerifiedAt === null ||
      activation.tlsVerifiedAt === null
    ) {
      throw errors.preconditionFailed(
        HOSTING_ERROR_CODES.ENTER_DOMAIN_REQUIRED,
        'Entering needs an active bot with a verified domain.',
      );
    }
    return activation.domain;
  }
}

function invalidToken(): Error {
  return errors.unauthenticated(
    HOSTING_ERROR_CODES.ENTER_TOKEN_INVALID,
    'This entry link is not valid.',
  );
}

function parseTenantId(id: string): string {
  const parsed = uuidV7Schema.safeParse(id);
  if (!parsed.success) {
    throw errors.notFound(HOSTING_ERROR_CODES.BOT_NOT_FOUND, 'No such hosted bot.');
  }
  return parsed.data;
}
