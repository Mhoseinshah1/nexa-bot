import {
  errors,
  HOSTED_BOT_TENANT_STATUS,
  hostedBotActionRequestSchema,
  hostedBotCreateRequestSchema,
  hostedBotEnterRequestSchema,
  hostedBotExpiryRequestSchema,
  hostedBotPurgeRequestSchema,
  hostedBotSetLimitRequestSchema,
  HOSTING_ERROR_CODES,
  PLATFORM_ERROR_CODES,
  systemContext,
  uuidV7Schema,
  type ActorContext,
  type AdminId,
  type CapacityLimitsResponse,
  type CapacitySetLimitResponse,
  type Clock,
  type HostedBotAction,
  type HostedBotPurgePreviewResponse,
  type HostedBotPurgeResponse,
  type HostedBotResponse,
  type HostedBotsResponse,
  type HostedBotView,
  type HostingCreateRefusal,
  type HostingServerResponse,
  type IdempotencyStore,
  type IdGenerator,
  type PasswordHasher,
  type ScopeContext,
  type TenantContext,
  type AuditWriter,
  type OperationalEventRecorder,
} from '@nexa/contracts';
import type { OutboxWriter } from '../../eventing/infrastructure/outbox-writer.js';
import { hashRequest } from '../../idempotency/infrastructure/drizzle-idempotency-store.js';
import { rememberOnce } from '../../idempotency/application/remember-once.js';
import type { ScopeActivityReader } from '../../system/application/record-ping.service.js';
import type { CapacityLimitsService } from '../../capacity/application/capacity-limits.service.js';
import type { CapacityLimitResolver } from '../../capacity/application/capacity-limit-resolver.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import { planTransition } from '../domain/hosted-bot-lifecycle.js';
import { estimateCapacity } from '../domain/capacity-estimate.js';
import { diskUsedPercent } from '../../capacity/domain/memory.js';
import type { HostingOwnerGuard } from './hosting-owner-guard.js';
import type { HostingSectionService } from './hosting-section.service.js';
import type {
  HostedBotRow,
  HostedTenantFacts,
  HostedTenantSystemPath,
  HostingRepository,
  HostingServerProbe,
} from './ports.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface HostingServiceDeps {
  readonly repository: HostingRepository;
  readonly system: HostedTenantSystemPath;
  readonly section: HostingSectionService;
  readonly owner: HostingOwnerGuard;
  readonly capacityLimits: Pick<CapacityLimitsService, 'list' | 'replayOf' | 'set'>;
  readonly capacityResolver: Pick<CapacityLimitResolver, 'numberOf' | 'tierOf'>;
  readonly idempotency: IdempotencyStore;
  readonly scopeActivity: ScopeActivityReader;
  readonly audit: AuditWriter;
  readonly opsLog: OperationalEventRecorder;
  readonly outbox: OutboxWriter;
  readonly hasher: PasswordHasher;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly probe: HostingServerProbe;
  /** The volumes the card shows: the same two the capacity monitor watches. */
  readonly diskPaths: readonly string[];
  /** The production create gate (`domain/create-gate.ts`), evaluated per request. */
  readonly createRefusal: () => HostingCreateRefusal | null;
}

/**
 * Phase 6A PR-3 — the creator panel's bots: the list, and every action on a hosted bot.
 *
 * Every entry point: the installation owner (`HostingOwnerGuard`) with an open section
 * session (`HostingSectionService.requireSection`), refusals audited. Every action, in
 * order: validation → idempotency replay (the first result, without asking for a code
 * again) → a FRESH second-factor proof, spent → one transaction holding the owner check and
 * the section again, the installation's `ScopeActivityReader`, the conditional change, the
 * hosted TENANT row's status (what stops the bot), the audit row with before/after, the
 * outbox event and the idempotency record. Cross-tenant reads and writes go through
 * `HostedTenantSystemPath` with a `SystemContext` naming the operation, nowhere else.
 *
 * Nothing here is written to a hosted bot's own audit log or outbox (D5).
 */
export class HostingService {
  constructor(private readonly deps: HostingServiceDeps) {}

  createGate(): { enabled: boolean; refusal: HostingCreateRefusal | null } {
    const refusal = this.deps.createRefusal();
    return { enabled: refusal === null, refusal };
  }

  async list(
    scope: ScopeContext,
    actor: ActorContext,
    token: string | null,
  ): Promise<HostedBotsResponse> {
    const installation = await this.deps.section.requireSection(
      scope,
      actor,
      token,
      'hosting.list',
    );
    const rows = await this.deps.repository.listHosted(installation);
    return { bots: await this.views(installation, actor, rows), create: this.createGate() };
  }

  async create(
    scope: ScopeContext,
    actor: ActorContext,
    token: string | null,
    input: unknown,
  ): Promise<HostedBotResponse> {
    const installation = await this.deps.section.requireSection(
      scope,
      actor,
      token,
      'hosting.create',
    );
    const command = hostedBotCreateRequestSchema.parse(input);
    // The release gate, before a code is asked for: a closed gate spends nothing.
    const refusal = this.deps.createRefusal();
    if (refusal !== null) {
      await this.deps.audit.record(installation, actor, {
        action: 'hosting.create',
        entityType: 'Tenant',
        entityId: null,
        before: null,
        after: { refusal, slug: command.slug },
        result: 'DENIED',
      });
      throw errors.preconditionFailed(
        HOSTING_ERROR_CODES.CREATE_DISABLED,
        refusal === 'FLAG_OFF'
          ? 'Creating hosted bots is switched off on this installation.'
          : 'Creating hosted bots stays closed in production until tenant isolation is enforced and proven.',
        { refusal },
      );
    }
    const expiresAt = command.expiresAt === null ? null : new Date(command.expiresAt);
    // The password is NOT in the hash: an idempotency row must not carry a password digest.
    const requestHash = hashRequest({
      action: 'hosting.create',
      slug: command.slug,
      displayName: command.displayName,
      adminUsername: command.adminUsername,
      adminDisplayName: command.adminDisplayName,
      expiresAt: expiresAt?.toISOString() ?? null,
    });
    const replay = await this.deps.idempotency.find<{ hostedTenantId: string }>(
      installation,
      actor.surface,
      command.idempotencyKey,
      requestHash,
    );
    if (replay !== null) {
      return {
        bot: await this.view(installation, actor, replay.result.hostedTenantId),
        replayed: true,
      };
    }
    if (expiresAt !== null && expiresAt.getTime() <= this.deps.clock.now().getTime()) {
      throw errors.validation(
        HOSTING_ERROR_CODES.EXPIRY_PASSED,
        'A new bot’s expiry date must be in the future.',
      );
    }
    const passwordHash = await this.deps.hasher.hash(command.adminPassword);
    const hostedTenantId = this.deps.ids.uuid();
    const ownerAdminId = this.deps.ids.uuid() as AdminId;
    const context = systemContext('hosting.create');

    await this.deps.section
      .withFreshProof(
        installation,
        actor,
        command.proof,
        'hosting.create',
        async (tx, now, method) => {
          await this.inTransaction(installation, actor, token, tx);
          if (await this.deps.system.slugTaken(context, command.slug, tx)) throw slugTaken();
          await this.deps.system.provision(
            context,
            {
              tenantId: hostedTenantId,
              parentTenantId: installation.tenantId,
              slug: command.slug,
              displayName: command.displayName,
              ownerAdminId,
              ownerUsername: command.adminUsername,
              ownerDisplayName: command.adminDisplayName,
              ownerPasswordHash: passwordHash,
              now,
            },
            tx,
          );
          await this.deps.repository.insertHosted(
            installation,
            {
              hostedTenantId,
              state: 'ACTIVE',
              expiresAt,
              ownerAdminId,
              createdByAdminId: actor.id as string,
              createdAt: now,
            },
            tx,
          );
          await this.deps.audit.record(
            installation,
            actor,
            {
              action: 'hosting.create',
              entityType: 'Tenant',
              entityId: hostedTenantId,
              before: null,
              after: {
                slug: command.slug,
                displayName: command.displayName,
                kind: 'HOSTED',
                state: 'ACTIVE',
                expiresAt: expiresAt?.toISOString() ?? null,
                webAdminUsername: command.adminUsername,
                proof: method,
              },
              result: 'SUCCESS',
            },
            tx,
          );
          await this.deps.outbox.write(tx, actor, {
            eventType: 'TenantCreated',
            aggregateType: 'Tenant',
            aggregateId: hostedTenantId,
            payload: { slug: command.slug, kind: 'HOSTED' },
          });
          await rememberOnce(
            this.deps.idempotency,
            installation,
            actor.surface,
            command.idempotencyKey,
            requestHash,
            { hostedTenantId },
            tx,
          );
        },
      )
      .catch((error: unknown) => {
        // The slug's unique index is the guarantee; the read above is the courtesy.
        if (isUniqueViolationError(error)) throw slugTaken();
        throw error;
      });
    return { bot: await this.view(installation, actor, hostedTenantId), replayed: false };
  }

  suspend(
    scope: ScopeContext,
    actor: ActorContext,
    token: string | null,
    id: string,
    input: unknown,
  ) {
    return this.transition('SUSPEND', scope, actor, token, id, input);
  }

  activate(
    scope: ScopeContext,
    actor: ActorContext,
    token: string | null,
    id: string,
    input: unknown,
  ) {
    return this.transition('ACTIVATE', scope, actor, token, id, input);
  }

  delete(
    scope: ScopeContext,
    actor: ActorContext,
    token: string | null,
    id: string,
    input: unknown,
  ) {
    return this.transition('DELETE', scope, actor, token, id, input);
  }

  async setExpiry(
    scope: ScopeContext,
    actor: ActorContext,
    token: string | null,
    id: string,
    input: unknown,
  ): Promise<HostedBotResponse> {
    const hostedTenantId = parseTenantId(id);
    const installation = await this.deps.section.requireSection(
      scope,
      actor,
      token,
      'hosting.set_expiry',
      hostedTenantId,
    );
    const command = hostedBotExpiryRequestSchema.parse(input);
    const expiresAt = command.expiresAt === null ? null : new Date(command.expiresAt);
    const requestHash = hashRequest({
      action: 'hosting.set_expiry',
      hostedTenantId,
      expiresAt: expiresAt?.toISOString() ?? null,
    });
    const replay = await this.deps.idempotency.find(
      installation,
      actor.surface,
      command.idempotencyKey,
      requestHash,
    );
    if (replay !== null)
      return { bot: await this.view(installation, actor, hostedTenantId), replayed: true };

    await this.deps.section.withFreshProof(
      installation,
      actor,
      command.proof,
      'hosting.set_expiry',
      async (tx, now, method) => {
        await this.inTransaction(installation, actor, token, tx);
        const row = await this.requireRow(installation, hostedTenantId, tx);
        if (row.state === 'PURGED') {
          throw errors.conflict(HOSTING_ERROR_CODES.STATE_CONFLICT, 'A purged bot has no expiry.', {
            state: row.state,
          });
        }
        await this.deps.repository.setExpiry(installation, hostedTenantId, expiresAt, now, tx);
        await this.deps.audit.record(
          installation,
          actor,
          {
            action: 'hosting.set_expiry',
            entityType: 'Tenant',
            entityId: hostedTenantId,
            before: { expiresAt: row.expiresAt?.toISOString() ?? null },
            after: { expiresAt: expiresAt?.toISOString() ?? null, proof: method },
            result: 'SUCCESS',
          },
          tx,
        );
        await this.deps.outbox.write(tx, actor, {
          eventType: 'HostedBotExpiryChanged',
          aggregateType: 'Tenant',
          aggregateId: hostedTenantId,
          payload: {
            hostedTenantId,
            from: row.expiresAt?.toISOString() ?? null,
            to: expiresAt?.toISOString() ?? null,
          },
        });
        await rememberOnce(
          this.deps.idempotency,
          installation,
          actor.surface,
          command.idempotencyKey,
          requestHash,
          { hostedTenantId },
          tx,
        );
      },
    );
    return { bot: await this.view(installation, actor, hostedTenantId), replayed: false };
  }

  async purgePreview(
    scope: ScopeContext,
    actor: ActorContext,
    token: string | null,
    id: string,
  ): Promise<HostedBotPurgePreviewResponse> {
    const hostedTenantId = parseTenantId(id);
    const installation = await this.deps.section.requireSection(
      scope,
      actor,
      token,
      'hosting.purge_preview',
      hostedTenantId,
    );
    const row = await this.requireRow(installation, hostedTenantId);
    const facts = await this.factsFor(installation, [row]);
    return {
      tenantId: hostedTenantId,
      confirmSlug: facts.get(hostedTenantId)?.slug ?? '',
      counts: await this.deps.system.purgePreview(
        systemContext('hosting.purge_preview'),
        hostedTenantId,
      ),
    };
  }

  async purge(
    scope: ScopeContext,
    actor: ActorContext,
    token: string | null,
    id: string,
    input: unknown,
  ): Promise<HostedBotPurgeResponse> {
    const hostedTenantId = parseTenantId(id);
    const installation = await this.deps.section.requireSection(
      scope,
      actor,
      token,
      'hosting.purge',
      hostedTenantId,
    );
    const command = hostedBotPurgeRequestSchema.parse(input);
    const row = await this.requireRow(installation, hostedTenantId);
    const slug = (await this.factsFor(installation, [row])).get(hostedTenantId)?.slug ?? null;
    if (slug === null || command.confirmSlug !== slug) {
      throw errors.validation(
        HOSTING_ERROR_CODES.PURGE_CONFIRMATION_MISMATCH,
        'Type the bot’s slug exactly to confirm.',
      );
    }
    const result = await this.transition('PURGE', scope, actor, token, id, {
      idempotencyKey: command.idempotencyKey,
      proof: command.proof,
    });
    return { ...result, erasure: 'PENDING' };
  }

  /** The limits editor: PR-2's list, behind the section. */
  async limits(
    scope: ScopeContext,
    actor: ActorContext,
    token: string | null,
  ): Promise<CapacityLimitsResponse> {
    const installation = await this.deps.section.requireSection(
      scope,
      actor,
      token,
      'hosting.limits',
    );
    return this.deps.capacityLimits.list(installation, actor);
  }

  /**
   * One limit, «نامحدود» included: PR-2's `CapacityLimitsService.set` (its validation, its
   * idempotency, its audit row), after the section and a fresh code. A replay of a saved
   * change is answered first, spending no code; otherwise the code is spent in its own
   * transaction first and PR-2's service then runs its own.
   */
  async setLimit(
    scope: ScopeContext,
    actor: ActorContext,
    token: string | null,
    id: string,
    input: unknown,
  ): Promise<CapacitySetLimitResponse> {
    const tenantId = parseTenantId(id);
    const installation = await this.deps.section.requireSection(
      scope,
      actor,
      token,
      'hosting.set_limit',
      tenantId,
    );
    const command = hostedBotSetLimitRequestSchema.parse(input);
    // Only the installation's own bot or a bot it hosts.
    if (tenantId !== installation.tenantId) await this.requireRow(installation, tenantId);
    const limitCommand = {
      idempotencyKey: command.idempotencyKey,
      tenantId,
      resource: command.resource,
      limit: command.limit,
    };
    // A retry of a change that already committed answers its first result BEFORE a code is
    // spent, as every other hosting mutation does: a retried request is never refused for a
    // code it already used, and retries never count towards the factor's lockout.
    const replay = await this.deps.capacityLimits.replayOf(installation, actor, limitCommand);
    if (replay !== null) return replay;
    await this.deps.section.withFreshProof(
      installation,
      actor,
      command.proof,
      'hosting.set_limit',
      async (tx) => this.inTransaction(installation, actor, token, tx),
    );
    return this.deps.capacityLimits.set(installation, actor, limitCommand);
  }

  /**
   * «ورود به پنل» — DESIGNED for 6B, not built (`docs/adr/0038-hosted-bots.md` § Enter).
   * The request shape already carries the fresh proof the action will ask for.
   */
  async enter(
    scope: ScopeContext,
    actor: ActorContext,
    token: string | null,
    id: string,
    input: unknown,
  ): Promise<never> {
    const hostedTenantId = parseTenantId(id);
    const installation = await this.deps.section.requireSection(
      scope,
      actor,
      token,
      'hosting.enter',
      hostedTenantId,
    );
    hostedBotEnterRequestSchema.parse(input);
    await this.requireRow(installation, hostedTenantId);
    throw errors.preconditionFailed(
      HOSTING_ERROR_CODES.ENTER_NOT_IMPLEMENTED,
      'Entering a hosted bot’s panel arrives in phase 6B.',
    );
  }

  /** The server card: CPU, RAM, disk and the estimate of how many more bots fit. */
  async server(
    scope: ScopeContext,
    actor: ActorContext,
    token: string | null,
  ): Promise<HostingServerResponse> {
    const installation = await this.deps.section.requireSection(
      scope,
      actor,
      token,
      'hosting.server',
    );
    const cores = this.deps.probe.cores();
    const load = this.deps.probe.loadAverage1m();
    const disks: HostingServerResponse['disks'][number][] = [];
    for (const path of this.deps.diskPaths) {
      const disk = await this.deps.probe.disk(path);
      const used = disk === null ? null : diskUsedPercent(disk.totalBytes, disk.availableBytes);
      if (disk !== null && used !== null) disks.push({ path, ...disk, usedPercent: used });
    }
    const available = await this.deps.probe.availableMemoryBytes();
    const floorMb = await this.deps.capacityResolver.numberOf(
      installation.tenantId,
      'INSTALLATION_ALERT_MIN_FREE_MEMORY_MB',
    );
    const live = (await this.deps.repository.listHosted(installation)).filter(
      (row) => row.state === 'ACTIVE',
    ).length;
    return {
      measuredAt: this.deps.clock.now().toISOString(),
      cpu: {
        cores,
        loadAverage1m: load,
        loadPercent: cores > 0 ? Math.round((load / cores) * 100) : 0,
      },
      memory: { totalBytes: this.deps.probe.totalMemoryBytes(), availableBytes: available },
      disks,
      estimate: estimateCapacity({
        cores,
        liveHostedBots: live,
        availableMemoryBytes: available,
        memoryFloorBytes: Number.isFinite(floorMb) ? floorMb * 1024 * 1024 : 0,
        diskUsedPercents: disks.map((disk) => disk.usedPercent),
      }),
    };
  }

  // -------------------------------------------------------------------------------------

  private async transition(
    action: Exclude<HostedBotAction, 'EXPIRE'>,
    scope: ScopeContext,
    actor: ActorContext,
    token: string | null,
    id: string,
    input: unknown,
  ): Promise<HostedBotResponse> {
    const hostedTenantId = parseTenantId(id);
    const auditAction = `hosting.${action.toLowerCase()}`;
    const installation = await this.deps.section.requireSection(
      scope,
      actor,
      token,
      auditAction,
      hostedTenantId,
    );
    const command = hostedBotActionRequestSchema.parse(input);
    const requestHash = hashRequest({ action: auditAction, hostedTenantId });
    const replay = await this.deps.idempotency.find(
      installation,
      actor.surface,
      command.idempotencyKey,
      requestHash,
    );
    if (replay !== null)
      return { bot: await this.view(installation, actor, hostedTenantId), replayed: true };
    // Before the code: a transition that cannot happen spends nothing.
    planTransition(
      action,
      await this.requireRow(installation, hostedTenantId),
      this.deps.clock.now(),
    );

    const context = systemContext(auditAction);
    await this.deps.section.withFreshProof(
      installation,
      actor,
      command.proof,
      auditAction,
      async (tx, now, method) => {
        await this.inTransaction(installation, actor, token, tx);
        const row = await this.requireRow(installation, hostedTenantId, tx, true);
        const plan = planTransition(action, row, now);
        const moved = await this.deps.repository.transition(
          installation,
          hostedTenantId,
          plan.allowedFrom,
          plan.to,
          now,
          tx,
        );
        if (moved === null) throw stateMoved(action, row.state);
        if (plan.tenantStatusFrom !== plan.tenantStatusTo) {
          const set = await this.deps.system.setTenantStatus(
            context,
            hostedTenantId,
            plan.tenantStatusFrom,
            plan.tenantStatusTo,
            now,
            tx,
          );
          if (!set) throw stateMoved(action, row.state);
        }
        const closed =
          action === 'PURGE'
            ? await this.deps.system.closeForPurge(context, hostedTenantId, now, tx)
            : null;
        await this.deps.audit.record(
          installation,
          actor,
          {
            action: auditAction,
            entityType: 'Tenant',
            entityId: hostedTenantId,
            before: { state: plan.from, tenantStatus: plan.tenantStatusFrom },
            after: {
              state: plan.to,
              tenantStatus: plan.tenantStatusTo,
              proof: method,
              ...(closed === null ? {} : closed),
            },
            ...(command.reason === undefined ? {} : { reason: command.reason }),
            result: 'SUCCESS',
          },
          tx,
        );
        await this.deps.outbox.write(tx, actor, {
          eventType: 'HostedBotStateChanged',
          aggregateType: 'Tenant',
          aggregateId: hostedTenantId,
          payload: {
            hostedTenantId,
            action,
            from: plan.from,
            to: plan.to,
            tenantStatusFrom: plan.tenantStatusFrom,
            tenantStatusTo: plan.tenantStatusTo,
          },
        });
        await rememberOnce(
          this.deps.idempotency,
          installation,
          actor.surface,
          command.idempotencyKey,
          requestHash,
          { hostedTenantId },
          tx,
        );
      },
    );
    return { bot: await this.view(installation, actor, hostedTenantId), replayed: false };
  }

  /** What every write transaction re-checks first, on its own connection. */
  private async inTransaction(
    installation: TenantContext,
    actor: ActorContext,
    token: string | null,
    tx: TransactionScope,
  ): Promise<void> {
    await this.deps.owner.check(installation, actor, tx);
    await this.deps.section.assertSectionIn(installation, actor, token, tx);
    if (!(await this.deps.scopeActivity.scopeIsActive(installation, tx))) {
      throw errors.notFound(
        PLATFORM_ERROR_CODES.TENANT_NOT_FOUND,
        'This scope is not accepting work.',
      );
    }
  }

  private async requireRow(
    installation: TenantContext,
    hostedTenantId: string,
    tx?: unknown,
    lock = false,
  ): Promise<HostedBotRow> {
    const row = await this.deps.repository.findHosted(installation, hostedTenantId, tx, lock);
    if (row === null) {
      throw errors.notFound(HOSTING_ERROR_CODES.BOT_NOT_FOUND, 'No such hosted bot.');
    }
    return row;
  }

  private async view(
    installation: TenantContext,
    actor: ActorContext,
    hostedTenantId: string,
  ): Promise<HostedBotView> {
    const row = await this.requireRow(installation, hostedTenantId);
    const [view] = await this.views(installation, actor, [row]);
    return view as HostedBotView;
  }

  private factsFor(
    _installation: TenantContext,
    rows: readonly HostedBotRow[],
  ): Promise<ReadonlyMap<string, HostedTenantFacts>> {
    return this.deps.system.facts(
      systemContext('hosting.list'),
      rows.map((row) => ({ tenantId: row.hostedTenantId, ownerAdminId: row.ownerAdminId })),
    );
  }

  private async views(
    installation: TenantContext,
    actor: ActorContext,
    rows: readonly HostedBotRow[],
  ): Promise<HostedBotView[]> {
    if (rows.length === 0) return [];
    const now = this.deps.clock.now();
    const [facts, hits, lastBackup, limits] = await Promise.all([
      this.factsFor(installation, rows),
      this.deps.repository.limitHitsSince(installation, new Date(now.getTime() - DAY_MS)),
      this.deps.repository.lastSucceededBackupAt(installation),
      // PR-2's own read, as the owner (installation scope + `settings.destructive`).
      this.deps.capacityLimits.list(installation, actor),
    ]);
    const limitViews = new Map(limits.tenants.map((tenant) => [tenant.tenantId, tenant]));
    return rows.map((row) => {
      const fact = facts.get(row.hostedTenantId);
      const ownHits = hits.get(row.hostedTenantId);
      return {
        tenantId: row.hostedTenantId,
        slug: fact?.slug ?? '',
        displayName: fact?.displayName ?? '',
        state: row.state,
        tenantStatus: fact?.status ?? HOSTED_BOT_TENANT_STATUS[row.state],
        expiresAt: row.expiresAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
        stateChangedAt: row.stateChangedAt.toISOString(),
        deletedAt: row.deletedAt?.toISOString() ?? null,
        purgedAt: row.purgedAt?.toISOString() ?? null,
        customerCount: fact?.customerCount ?? 0,
        webAdmin: fact?.ownerUsername == null ? null : { username: fact.ownerUsername },
        telegramBot: fact?.bot ?? null,
        lastBackupAt:
          lastBackup !== null && lastBackup.getTime() >= row.createdAt.getTime()
            ? lastBackup.toISOString()
            : null,
        resources: (limitViews.get(row.hostedTenantId)?.limits ?? []).map((limit) => ({
          limit,
          pressureAlertsLast24h: ownHits?.get(limit.resource) ?? 0,
        })),
      };
    });
  }
}

function parseTenantId(id: string): string {
  const parsed = uuidV7Schema.safeParse(id);
  if (!parsed.success) {
    throw errors.notFound(HOSTING_ERROR_CODES.BOT_NOT_FOUND, 'No such hosted bot.');
  }
  return parsed.data;
}

function slugTaken(): Error {
  return errors.conflict(HOSTING_ERROR_CODES.SLUG_TAKEN, 'That slug is already in use.');
}

function stateMoved(action: HostedBotAction, state: string): Error {
  return errors.conflict(
    HOSTING_ERROR_CODES.STATE_CONFLICT,
    'The bot changed while this was being done. Reload and try again.',
    { action, state },
  );
}

function isUniqueViolationError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current !== null && typeof current === 'object'; depth += 1) {
    if ((current as { code?: unknown }).code === '23505') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
