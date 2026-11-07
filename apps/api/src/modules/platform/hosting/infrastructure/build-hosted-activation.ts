import type {
  AuditWriter,
  Clock,
  IdempotencyStore,
  IdGenerator,
  PasswordHasher,
  UnitOfWork,
} from '@nexa/contracts';
import type { Database } from '../../../../infrastructure/persistence/database.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { OutboxWriter } from '../../eventing/infrastructure/outbox-writer.js';
import type { ScopeActivityReader } from '../../system/application/record-ping.service.js';
import type {
  BotBootstrapRepository,
  BotInstanceRepository,
} from '../../tenancy/application/ports.js';
import type { BotBootstrapService } from '../../tenancy/application/bot-bootstrap.service.js';
import type {
  HostedBotIdentifier,
  HostedDnsResolver,
  HostedTlsProbe,
} from '../application/activation-ports.js';
import { HostedActivationService } from '../application/hosted-activation.service.js';
import { HostedOwnerActivationService } from '../application/hosted-owner-activation.service.js';
import type { HostingOwnerGuard } from '../application/hosting-owner-guard.js';
import type { HostingSectionService } from '../application/hosting-section.service.js';
import type { HostingRepository } from '../application/ports.js';
import { normaliseHost } from '../domain/hosted-domain.js';
import { DrizzleHostedActivationRepository } from './drizzle-hosted-activation.repository.js';
import { DrizzleHostedBotRegistrar } from './drizzle-hosted-bot-registrar.js';
import { DrizzleHostedDomainDirectory } from './drizzle-hosted-domain-directory.js';
import { DrizzleHostedOwnerActivation } from './drizzle-hosted-owner-activation.js';
import { HttpsTlsProbe } from './https-tls-probe.js';
import { NodeDnsResolver } from './node-dns-resolver.js';

/** The names this installation answers on itself: never a hosted domain. */
export function reservedHostsOf(config: {
  readonly WEB_ADMIN_ORIGINS: readonly string[];
  readonly HOSTED_BOTS_CNAME_TARGET: string;
}): ReadonlySet<string> {
  const names = new Set<string>();
  for (const origin of config.WEB_ADMIN_ORIGINS) {
    try {
      const host = normaliseHost(new URL(origin).hostname);
      if (host !== null) names.add(host);
    } catch {
      // A malformed origin is the config schema's to refuse.
    }
  }
  const target = normaliseHost(config.HOSTED_BOTS_CNAME_TARGET);
  if (target !== null) names.add(target);
  return names;
}

/**
 * Phase 6A PR-4: the activation's services, assembled in one place so `container.ts` gains a
 * call. The network (`dns`, `tls`) is injectable for tests; production gets `node:dns` and an
 * HTTPS probe.
 */
export function buildHostedActivation(deps: {
  readonly db: Database;
  readonly config: {
    readonly WEB_ADMIN_ORIGINS: readonly string[];
    readonly HOSTED_BOTS_CNAME_TARGET: string;
    readonly HOSTED_BOTS_SERVER_IPS: readonly string[];
  };
  readonly uow: UnitOfWork<TransactionScope>;
  readonly hostingRepository: HostingRepository;
  readonly section: HostingSectionService;
  readonly owner: HostingOwnerGuard;
  readonly idempotency: IdempotencyStore;
  readonly scopeActivity: ScopeActivityReader;
  readonly audit: AuditWriter;
  readonly outbox: OutboxWriter;
  readonly hasher: PasswordHasher;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly bots: BotBootstrapRepository & Pick<BotInstanceRepository, 'resolveToken'>;
  readonly bootstrap: Pick<BotBootstrapService, 'execute'>;
  readonly telegram: HostedBotIdentifier;
  readonly dns?: HostedDnsResolver;
  readonly tls?: HostedTlsProbe;
}): {
  readonly hostedActivation: HostedActivationService;
  readonly hostedOwnerActivation: HostedOwnerActivationService;
} {
  const reservedHosts = reservedHostsOf(deps.config);
  const firstOrigin = deps.config.WEB_ADMIN_ORIGINS[0];
  const fromOrigin = (() => {
    try {
      return firstOrigin === undefined ? null : normaliseHost(new URL(firstOrigin).hostname);
    } catch {
      return null;
    }
  })();
  const hostname = normaliseHost(deps.config.HOSTED_BOTS_CNAME_TARGET) ?? fromOrigin;
  const hostedActivation = new HostedActivationService({
    hosting: deps.hostingRepository,
    repository: new DrizzleHostedActivationRepository(deps.db),
    registrar: new DrizzleHostedBotRegistrar(deps.db, deps.bots, deps.bootstrap),
    telegram: deps.telegram,
    dns: deps.dns ?? new NodeDnsResolver(),
    tls: deps.tls ?? new HttpsTlsProbe(),
    section: deps.section,
    owner: deps.owner,
    uow: deps.uow,
    idempotency: deps.idempotency,
    scopeActivity: deps.scopeActivity,
    audit: deps.audit,
    outbox: deps.outbox,
    clock: deps.clock,
    ids: deps.ids,
    dnsTarget: { hostname, addresses: deps.config.HOSTED_BOTS_SERVER_IPS },
    reservedHosts,
  });
  const hostedOwnerActivation = new HostedOwnerActivationService({
    directory: new DrizzleHostedDomainDirectory(deps.db),
    system: new DrizzleHostedOwnerActivation(deps.db),
    uow: deps.uow,
    scopeActivity: deps.scopeActivity,
    audit: deps.audit,
    outbox: deps.outbox,
    hasher: deps.hasher,
    clock: deps.clock,
    reservedHosts,
  });
  return { hostedActivation, hostedOwnerActivation };
}
