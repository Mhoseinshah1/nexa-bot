import type {
  AdminId,
  AdminSessionId,
  AuditWriter,
  Clock,
  IdempotencyStore,
  IdGenerator,
  OperationalEventRecorder,
  PasswordHasher,
  ScopeContext,
  SecretCipher,
  UnitOfWork,
} from '@nexa/contracts';
import type { Database } from '../../../../infrastructure/persistence/database.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { PermissionGuard } from '../../access/application/permission-guard.js';
import type { OutboxWriter } from '../../eventing/infrastructure/outbox-writer.js';
import type { ScopeActivityReader } from '../../system/application/record-ping.service.js';
import type { CapacityLimitsService } from '../../capacity/application/capacity-limits.service.js';
import type { CapacityLimitResolver } from '../../capacity/application/capacity-limit-resolver.js';
import type { SystemProbe } from '../../capacity/application/ports.js';
import { HostingOwnerGuard } from '../application/hosting-owner-guard.js';
import {
  HostingSectionService,
  type HostingSectionDeps,
} from '../application/hosting-section.service.js';
import { HostingService } from '../application/hosting.service.js';
import { HostedBotExpiryService } from '../application/hosted-bot-expiry.service.js';
import {
  hostedBotCreateRefusal,
  HOSTED_BOTS_PRODUCTION_RELEASE_MARKER,
} from '../domain/create-gate.js';
import { DrizzleHostingRepository } from './drizzle-hosting.repository.js';
import {
  DrizzleHostedTenantSystemPath,
  type HostedOwnerProvisioning,
} from './drizzle-hosted-tenant-system-path.js';
import { OsHostingServerProbe } from './os-server-probe.js';

/**
 * Phase 6A PR-3: the creator panel's services, assembled in one place so `container.ts`
 * gains a call rather than another page.
 */
export function buildHosting(deps: {
  readonly db: Database;
  readonly config: { readonly NODE_ENV: string; readonly HOSTED_BOTS_CREATE_ENABLED: boolean };
  readonly uow: UnitOfWork<TransactionScope>;
  readonly guard: PermissionGuard;
  readonly audit: AuditWriter;
  readonly opsLog: OperationalEventRecorder;
  readonly outbox: OutboxWriter;
  readonly idempotency: IdempotencyStore;
  readonly scopeActivity: ScopeActivityReader;
  readonly cipher: SecretCipher;
  readonly hasher: PasswordHasher;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly qr: { encode(text: string): Uint8Array } | null;
  readonly admins: HostedOwnerProvisioning['admins'] & {
    roleKeysFor(scope: ScopeContext, id: AdminId, tx?: unknown): Promise<string[]>;
  };
  readonly roles: HostedOwnerProvisioning['roles'];
  readonly sessions: {
    isLive(scope: ScopeContext, id: AdminSessionId, now: Date, tx?: unknown): Promise<boolean>;
  };
  readonly verifyOwnPassword: HostingSectionDeps['verifyOwnPassword'];
  readonly capacityLimits: Pick<CapacityLimitsService, 'list' | 'replayOf' | 'set'>;
  readonly capacityResolver: Pick<CapacityLimitResolver, 'numberOf' | 'tierOf'>;
  readonly systemProbe: SystemProbe;
  readonly diskPaths: readonly string[];
  readonly installationTenantId: () => string | null;
}): {
  readonly hostingSection: HostingSectionService;
  readonly hosting: HostingService;
  readonly hostedBotExpiry: HostedBotExpiryService;
} {
  const repository = new DrizzleHostingRepository(deps.db);
  const system = new DrizzleHostedTenantSystemPath(deps.db, {
    admins: deps.admins,
    roles: deps.roles,
  });
  const owner = new HostingOwnerGuard({
    guard: deps.guard,
    audit: deps.audit,
    opsLog: deps.opsLog,
    admins: deps.admins,
    installationTenantId: deps.installationTenantId,
    sessions: deps.sessions,
    clock: deps.clock,
  });
  const hostingSection = new HostingSectionService({
    uow: deps.uow,
    repository,
    owner,
    cipher: deps.cipher,
    audit: deps.audit,
    clock: deps.clock,
    ids: deps.ids,
    qr: deps.qr,
    verifyOwnPassword: deps.verifyOwnPassword,
  });
  const hosting = new HostingService({
    repository,
    system,
    section: hostingSection,
    owner,
    capacityLimits: deps.capacityLimits,
    capacityResolver: deps.capacityResolver,
    idempotency: deps.idempotency,
    scopeActivity: deps.scopeActivity,
    audit: deps.audit,
    opsLog: deps.opsLog,
    outbox: deps.outbox,
    hasher: deps.hasher,
    clock: deps.clock,
    ids: deps.ids,
    probe: new OsHostingServerProbe(deps.systemProbe),
    diskPaths: deps.diskPaths,
    createRefusal: () =>
      hostedBotCreateRefusal({
        nodeEnv: deps.config.NODE_ENV,
        flagEnabled: deps.config.HOSTED_BOTS_CREATE_ENABLED,
        releaseMarker: HOSTED_BOTS_PRODUCTION_RELEASE_MARKER,
      }),
  });
  const hostedBotExpiry = new HostedBotExpiryService({
    repository,
    system,
    audit: deps.audit,
    outbox: deps.outbox,
    opsLog: deps.opsLog,
    scopeActivity: deps.scopeActivity,
    uow: deps.uow,
    clock: deps.clock,
    ids: deps.ids,
  });
  return { hostingSection, hosting, hostedBotExpiry };
}
