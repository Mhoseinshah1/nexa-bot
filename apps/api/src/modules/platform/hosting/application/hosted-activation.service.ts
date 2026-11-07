import {
  errors,
  HOSTED_ACTIVATION_PAGE_PATH,
  HOSTING_ACTIVATION_ERROR_CODES as CODES,
  HOSTING_ERROR_CODES,
  hostedActivationConfigureRequestSchema,
  hostedActivationLinkRequestSchema,
  hostedActivationStepRequestSchema,
  HOSTED_ACTIVATION_RUNNABLE_STEPS,
  NexaError,
  PLATFORM_ERROR_CODES,
  systemContext,
  uuidV7Schema,
  type ActorContext,
  type Clock,
  type HostedActivationLinkResponse,
  type HostedActivationResponse,
  type HostedActivationRunnableStep,
  type HostedActivationStep,
  type HostedActivationStepView,
  type HostedActivationView,
  type IdempotencyStore,
  type IdGenerator,
  type ScopeContext,
  type TenantContext,
  type UnitOfWork,
  type AuditWriter,
} from '@nexa/contracts';
import type { OutboxWriter } from '../../eventing/infrastructure/outbox-writer.js';
import { hashRequest } from '../../idempotency/infrastructure/drizzle-idempotency-store.js';
import { rememberOnce } from '../../idempotency/application/remember-once.js';
import type { ScopeActivityReader } from '../../system/application/record-ping.service.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import {
  activationLinkExpiry,
  activationLinkState,
  generateActivationToken,
  hashActivationToken,
} from '../domain/activation-link.js';
import { judgeDns, parseHostedDomain } from '../domain/hosted-domain.js';
import type { HostingOwnerGuard } from './hosting-owner-guard.js';
import type { HostingSectionService } from './hosting-section.service.js';
import type {
  HostedActivationLinkRow,
  HostedActivationPatch,
  HostedActivationRepository,
  HostedActivationRow,
  HostedBotIdentifier,
  HostedBotRegistrar,
  HostedDnsResolver,
  HostedTlsProbe,
} from './activation-ports.js';
import type { HostedBotRow, HostingRepository } from './ports.js';

/** Telegram's `<numeric bot id>:<secret>`. Anything else never reaches Telegram. */
const BOT_TOKEN_SHAPE = /^\d{4,20}:[A-Za-z0-9_-]{20,}$/;

export interface HostedActivationDeps {
  readonly hosting: Pick<HostingRepository, 'findHosted'>;
  readonly repository: HostedActivationRepository;
  readonly registrar: HostedBotRegistrar;
  readonly telegram: HostedBotIdentifier;
  readonly dns: HostedDnsResolver;
  readonly tls: HostedTlsProbe;
  readonly section: HostingSectionService;
  readonly owner: HostingOwnerGuard;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly idempotency: IdempotencyStore;
  readonly scopeActivity: ScopeActivityReader;
  readonly audit: AuditWriter;
  readonly outbox: OutboxWriter;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /** What a hosted owner points the domain at: the owner's hostname and/or this server's addresses. */
  readonly dnsTarget: { readonly hostname: string | null; readonly addresses: readonly string[] };
  /** This server's own names (normalised): never a hosted domain. */
  readonly reservedHosts: ReadonlySet<string>;
}

/**
 * Phase 6A PR-4 (D2) — the creator panel's activation of a hosted bot, step by step.
 *
 * Who enters what: the OWNER, in the creator panel, on the hosted owner's behalf (the owner
 * already holds the panel's second factor and the hosted owner's identity; a bot token is
 * never handed through a second party's browser).
 *
 * Every entry point is the installation owner with an open section session
 * (`HostingSectionService.requireSection`), refusals audited. Every state change: validation →
 * idempotency replay → the NETWORK work (Telegram, DNS, the HTTPS probe: never inside a
 * transaction) → one transaction holding the owner check and the section again, the
 * installation's `ScopeActivityReader`, the activation row under its lock, the audit row, the
 * outbox event and the idempotency record. Setting the token and issuing the link take a FRESH
 * second-factor proof; re-running a check takes none (it changes nothing a check did not
 * prove).
 *
 * A failed step is recorded (its closed code on the row, an audit row with result FAILED, an
 * outbox event) in its own transaction and THEN refused with that code; the idempotency key is
 * not spent by a failure, so the same request can simply be run again once the cause is fixed.
 * A failure also clears the marks that depended on the step: no mark ever outlives its basis.
 *
 * Everything that reaches INTO the hosted tenant goes through `HostedBotRegistrar` with a
 * `SystemContext`; nothing here reads another tenant's rows any other way.
 */
export class HostedActivationService {
  constructor(private readonly deps: HostedActivationDeps) {}

  async status(
    scope: ScopeContext,
    actor: ActorContext,
    token: string | null,
    id: string,
  ): Promise<HostedActivationView> {
    const hostedTenantId = parseTenantId(id);
    const installation = await this.deps.section.requireSection(
      scope,
      actor,
      token,
      'hosting.activation_status',
      hostedTenantId,
    );
    await this.requireHosted(installation, hostedTenantId);
    return this.view(installation, hostedTenantId);
  }

  async configure(
    scope: ScopeContext,
    actor: ActorContext,
    token: string | null,
    id: string,
    input: unknown,
  ): Promise<HostedActivationResponse> {
    const hostedTenantId = parseTenantId(id);
    const action = 'hosting.activation_configure';
    const installation = await this.deps.section.requireSection(
      scope,
      actor,
      token,
      action,
      hostedTenantId,
    );
    const command = hostedActivationConfigureRequestSchema.parse(input);
    const parsed = parseHostedDomain(command.domain, this.deps.reservedHosts);
    if (!parsed.ok) {
      throw activationError(
        parsed.code,
        parsed.code === CODES.DOMAIN_RESERVED
          ? 'That name is one of this server’s own.'
          : 'That is not a valid domain name: use a bare name such as bot.example.com.',
      );
    }
    const domain = parsed.domain;
    if (!BOT_TOKEN_SHAPE.test(command.botToken)) {
      throw activationError(CODES.TOKEN_MALFORMED, 'That is not a Telegram bot token.');
    }
    // The token is NOT in the hash: an idempotency row must not carry a digest of a credential.
    const requestHash = hashRequest({ action, hostedTenantId, domain });
    const replay = await this.deps.idempotency.find(
      installation,
      actor.surface,
      command.idempotencyKey,
      requestHash,
    );
    if (replay !== null) {
      return { activation: await this.view(installation, hostedTenantId), replayed: true };
    }
    await this.requireHosted(installation, hostedTenantId, true);

    const before = await this.deps.repository.find(installation, hostedTenantId);
    if (before?.ownerActivatedAt != null && before.domain !== domain) {
      throw activationError(
        CODES.DOMAIN_LOCKED,
        'The hosted owner already activated their panel on this domain; it no longer changes.',
      );
    }
    if (await this.deps.repository.domainTaken(installation, domain, hostedTenantId)) {
      throw activationError(CODES.DOMAIN_TAKEN, 'Another hosted bot already uses that domain.');
    }

    // Telegram, outside any transaction, BEFORE a code is spent and before anything is stored.
    const identity = await this.identify(command.botToken);
    const context = systemContext('hosting.activation_configure');
    if (
      await this.deps.registrar.identityHeldElsewhere(context, {
        telegramBotId: identity.botId,
        username: identity.username,
        hostedTenantId,
      })
    ) {
      throw activationError(
        CODES.TOKEN_IN_USE,
        'That bot is already used by another bot instance on this server.',
      );
    }
    const current = await this.deps.registrar.currentBot(context, hostedTenantId);
    if (current !== null && current.telegramBotId !== identity.botId) {
      throw activationError(
        CODES.TOKEN_OTHER_BOT,
        'This hosted bot is already bound to a different Telegram bot.',
      );
    }

    const botInstanceId = this.deps.ids.uuid();
    await this.deps.section
      .withFreshProof(installation, actor, command.proof, action, async (tx, now, method) => {
        await this.inTransaction(installation, actor, token, tx);
        const hosted = await this.requireHostedIn(installation, hostedTenantId, tx);
        assertActive(hosted);
        await this.deps.repository.ensure(installation, hostedTenantId, now, tx);
        const locked = (await this.deps.repository.find(
          installation,
          hostedTenantId,
          tx,
          true,
        )) as HostedActivationRow;
        if (locked.ownerActivatedAt !== null && locked.domain !== domain) {
          throw activationError(CODES.DOMAIN_LOCKED, 'The domain no longer changes.');
        }
        const bound = await this.deps.registrar.bind(
          context,
          {
            hostedTenantId,
            botInstanceId,
            username: identity.username,
            telegramBotId: identity.botId,
            token: command.botToken,
            now,
          },
          tx,
        );
        if (bound.outcome === 'OTHER_BOT') {
          throw activationError(
            CODES.TOKEN_OTHER_BOT,
            'This hosted bot is already bound to a different Telegram bot.',
          );
        }
        if (bound.outcome === 'TOKEN_DIFFERS') {
          throw activationError(
            CODES.TOKEN_DIFFERS,
            'This hosted bot already stores a different token for that Telegram bot; it is not replaced here.',
          );
        }
        const domainChanged = locked.domain !== domain;
        if (domainChanged) {
          // A link was issued for the OLD name: it dies with it, in this same transaction.
          await this.deps.repository.revokeOpenLinks(installation, hostedTenantId, now, tx);
        }
        await this.deps.repository.patch(
          installation,
          hostedTenantId,
          {
            botInstanceId: bound.binding.botInstanceId,
            domain,
            tokenVerifiedAt: now,
            // A new name earns its marks again: none may name a domain it was not earned for.
            ...(domainChanged
              ? { dnsVerifiedAt: null, tlsVerifiedAt: null, webhookRegisteredAt: null }
              : {}),
            error: null,
          },
          now,
          tx,
        );
        await this.deps.audit.record(
          installation,
          actor,
          {
            action,
            entityType: 'Tenant',
            entityId: hostedTenantId,
            before: {
              domain: locked.domain,
              botInstanceId: locked.botInstanceId,
              tokenVerified: locked.tokenVerifiedAt !== null,
            },
            // The identity, never the credential.
            after: {
              domain,
              botUsername: bound.binding.username,
              telegramBotId: bound.binding.telegramBotId,
              botInstance: bound.outcome,
              proof: method,
            },
            result: 'SUCCESS',
          },
          tx,
        );
        await this.outbox(tx, actor, hostedTenantId, 'TOKEN', 'DONE', null);
        await rememberOnce(
          this.deps.idempotency,
          installation,
          actor.surface,
          command.idempotencyKey,
          requestHash,
          { hostedTenantId },
          tx,
        );
      })
      .catch((error: unknown) => {
        if (isUniqueViolation(error, 'hosted_bot_activations_domain_key')) {
          throw activationError(CODES.DOMAIN_TAKEN, 'Another hosted bot already uses that domain.');
        }
        if (
          error instanceof NexaError &&
          (error.code === PLATFORM_ERROR_CODES.TELEGRAM_BOOTSTRAP_BOT_ALREADY_BOUND ||
            error.code === PLATFORM_ERROR_CODES.TELEGRAM_BOOTSTRAP_USERNAME_TAKEN)
        ) {
          throw activationError(
            CODES.TOKEN_IN_USE,
            'That bot is already used by another bot instance on this server.',
          );
        }
        throw error;
      });
    return { activation: await this.view(installation, hostedTenantId), replayed: false };
  }

  /** Re-runs one check: the stored token, the DNS, the HTTPS certificate, or the webhook. */
  async runStep(
    scope: ScopeContext,
    actor: ActorContext,
    token: string | null,
    id: string,
    stepSlug: string,
    input: unknown,
  ): Promise<HostedActivationResponse> {
    const hostedTenantId = parseTenantId(id);
    const slug = HOSTED_ACTIVATION_RUNNABLE_STEPS.find((candidate) => candidate === stepSlug);
    if (slug === undefined) {
      throw errors.notFound(HOSTING_ERROR_CODES.BOT_NOT_FOUND, 'No such activation step.');
    }
    const step = STEP_OF[slug];
    const action = `hosting.activation_${slug}`;
    const installation = await this.deps.section.requireSection(
      scope,
      actor,
      token,
      action,
      hostedTenantId,
    );
    const command = hostedActivationStepRequestSchema.parse(input);
    const requestHash = hashRequest({ action, hostedTenantId });
    const replay = await this.deps.idempotency.find(
      installation,
      actor.surface,
      command.idempotencyKey,
      requestHash,
    );
    if (replay !== null) {
      return { activation: await this.view(installation, hostedTenantId), replayed: true };
    }
    await this.requireHosted(installation, hostedTenantId, true);
    const row = await this.deps.repository.find(installation, hostedTenantId);
    if (row === null || row.botInstanceId === null || row.domain === null) {
      throw activationError(CODES.NOT_CONFIGURED, 'Enter the bot token and the domain first.');
    }
    this.requirePrerequisites(step, row);

    const failure = await this.check(slug, row, hostedTenantId);
    const now = this.deps.clock.now();
    await this.deps.uow.run(installation, async (tx) => {
      await this.inTransaction(installation, actor, token, tx);
      assertActive(await this.requireHostedIn(installation, hostedTenantId, tx));
      const locked = await this.deps.repository.find(installation, hostedTenantId, tx, true);
      if (
        locked === null ||
        locked.domain !== row.domain ||
        locked.botInstanceId !== row.botInstanceId
      ) {
        throw errors.conflict(
          HOSTING_ERROR_CODES.STATE_CONFLICT,
          'The activation changed while this was being checked. Reload and try again.',
        );
      }
      const stamp = this.deps.clock.now();
      if (failure !== null) {
        await this.deps.repository.patch(
          installation,
          hostedTenantId,
          { ...failurePatch(step), error: { step, code: failure.code } },
          stamp,
          tx,
        );
        await this.deps.audit.record(
          installation,
          actor,
          {
            action,
            entityType: 'Tenant',
            entityId: hostedTenantId,
            before: { done: markOf(step, locked) !== null },
            after: { errorCode: failure.code },
            result: 'FAILED',
          },
          tx,
        );
        await this.outbox(tx, actor, hostedTenantId, step, 'FAILED', failure.code);
        return;
      }
      await this.deps.repository.patch(
        installation,
        hostedTenantId,
        { ...successPatch(step, now), ...clearErrorOf(step, locked) },
        stamp,
        tx,
      );
      await this.deps.audit.record(
        installation,
        actor,
        {
          action,
          entityType: 'Tenant',
          entityId: hostedTenantId,
          before: { done: markOf(step, locked) !== null },
          after: { done: true },
          result: 'SUCCESS',
        },
        tx,
      );
      await this.outbox(tx, actor, hostedTenantId, step, 'DONE', null);
      await rememberOnce(
        this.deps.idempotency,
        installation,
        actor.surface,
        command.idempotencyKey,
        requestHash,
        { hostedTenantId },
        tx,
      );
    });
    // A refusal AFTER its record committed: the failure is on the row, the caller is told why.
    if (failure !== null) throw failure;
    return { activation: await this.view(installation, hostedTenantId), replayed: false };
  }

  /** Makes the one-time link. Shown once; a newer link revokes every older unused one. */
  async issueLink(
    scope: ScopeContext,
    actor: ActorContext,
    token: string | null,
    id: string,
    input: unknown,
  ): Promise<HostedActivationLinkResponse> {
    const hostedTenantId = parseTenantId(id);
    const action = 'hosting.activation_link';
    const installation = await this.deps.section.requireSection(
      scope,
      actor,
      token,
      action,
      hostedTenantId,
    );
    const command = hostedActivationLinkRequestSchema.parse(input);
    const requestHash = hashRequest({ action, hostedTenantId });
    const replay = await this.deps.idempotency.find(
      installation,
      actor.surface,
      command.idempotencyKey,
      requestHash,
    );
    if (replay !== null) {
      // Only a hash of the token is kept: a replay cannot show it again.
      return {
        activation: await this.view(installation, hostedTenantId),
        replayed: true,
        activationUrl: null,
      };
    }
    await this.requireHosted(installation, hostedTenantId, true);
    const before = await this.deps.repository.find(installation, hostedTenantId);
    this.requireLinkable(before);

    const secret = generateActivationToken();
    await this.deps.section.withFreshProof(
      installation,
      actor,
      command.proof,
      action,
      async (tx, now, method) => {
        await this.inTransaction(installation, actor, token, tx);
        assertActive(await this.requireHostedIn(installation, hostedTenantId, tx));
        const locked = await this.deps.repository.find(installation, hostedTenantId, tx, true);
        this.requireLinkable(locked);
        const revoked = await this.deps.repository.revokeOpenLinks(
          installation,
          hostedTenantId,
          now,
          tx,
        );
        const linkId = this.deps.ids.uuid();
        const expiresAt = activationLinkExpiry(now);
        await this.deps.repository.insertLink(
          installation,
          {
            id: linkId,
            hostedTenantId,
            tokenHash: hashActivationToken(secret),
            createdByAdminId: actor.id as string,
            createdAt: now,
            expiresAt,
          },
          tx,
        );
        await this.deps.repository.patch(
          installation,
          hostedTenantId,
          locked?.lastErrorStep === 'LINK' ? { error: null } : {},
          now,
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
            // The link's id and lifetime — never the token, never its hash.
            after: {
              linkId,
              expiresAt: expiresAt.toISOString(),
              olderLinksRevoked: revoked,
              proof: method,
            },
            result: 'SUCCESS',
          },
          tx,
        );
        await this.outbox(tx, actor, hostedTenantId, 'LINK', 'DONE', null);
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
    const domain = (await this.deps.repository.find(installation, hostedTenantId))
      ?.domain as string;
    return {
      activation: await this.view(installation, hostedTenantId),
      replayed: false,
      activationUrl: `https://${domain}${HOSTED_ACTIVATION_PAGE_PATH}#token=${secret}`,
    };
  }

  // -------------------------------------------------------------------------------------

  /** The step's network work. Null = it holds; otherwise the error to record and raise. */
  private async check(
    slug: HostedActivationRunnableStep,
    row: HostedActivationRow,
    hostedTenantId: string,
  ): Promise<NexaError | null> {
    const context = systemContext(`hosting.activation_${slug}`);
    switch (slug) {
      case 'token': {
        const bound = await this.deps.registrar.currentBot(context, hostedTenantId);
        if (bound === null) {
          return activationError(CODES.NOT_CONFIGURED, 'Enter the bot token first.');
        }
        const stored = await this.deps.registrar.tokenOf(
          context,
          hostedTenantId,
          bound.botInstanceId,
        );
        try {
          const identity = await this.identify(stored);
          return identity.botId === bound.telegramBotId
            ? null
            : activationError(
                CODES.TOKEN_REJECTED,
                'The stored token no longer belongs to this bot.',
              );
        } catch (error) {
          if (error instanceof NexaError) return error;
          throw error;
        }
      }
      case 'domain': {
        const expected = await this.expectation();
        if (expected === null) {
          return activationError(
            CODES.NOT_CONFIGURED,
            'This server has no DNS target configured (HOSTED_BOTS_CNAME_TARGET / HOSTED_BOTS_SERVER_IPS).',
          );
        }
        try {
          const observed = await this.deps.dns.observe(row.domain as string);
          return judgeDns(observed, expected) === 'POINTED'
            ? null
            : activationError(
                CODES.DNS_NOT_POINTED,
                'The domain does not point at this server yet.',
              );
        } catch {
          return activationError(
            CODES.DNS_LOOKUP_FAILED,
            'The domain could not be looked up in time.',
          );
        }
      }
      case 'ssl': {
        const result = await this.deps.tls.probe(row.domain as string);
        return result.ok
          ? null
          : activationError(
              CODES.SSL_NOT_READY,
              'HTTPS on the domain did not answer with a valid certificate yet.',
              { reason: result.reason },
            );
      }
      case 'webhook': {
        const result = await this.deps.registrar.registerWebhook(context, {
          hostedTenantId,
          origin: `https://${row.domain as string}`,
        });
        return result.outcome === 'REGISTERED'
          ? null
          : activationError(CODES.WEBHOOK_FAILED, 'Telegram did not accept the webhook.');
      }
    }
  }

  /** What the domain must resolve to, or null when this server has no target configured. */
  private async expectation(): Promise<{
    hostname: string | null;
    addresses: readonly string[];
  } | null> {
    const { hostname, addresses } = this.deps.dnsTarget;
    if (hostname === null && addresses.length === 0) return null;
    const own = hostname === null ? [] : await this.deps.dns.addressesOf(hostname).catch(() => []);
    return { hostname, addresses: [...addresses, ...own] };
  }

  private requirePrerequisites(step: HostedActivationStep, row: HostedActivationRow): void {
    const missing =
      (step === 'SSL' && row.dnsVerifiedAt === null) ||
      (step === 'WEBHOOK' && (row.tlsVerifiedAt === null || row.tokenVerifiedAt === null));
    if (missing) {
      throw activationError(CODES.STEP_BLOCKED, 'An earlier step is not done yet.');
    }
  }

  private requireLinkable(row: HostedActivationRow | null): void {
    if (
      row === null ||
      row.tokenVerifiedAt === null ||
      row.dnsVerifiedAt === null ||
      row.tlsVerifiedAt === null ||
      row.webhookRegisteredAt === null
    ) {
      throw activationError(CODES.STEP_BLOCKED, 'Every earlier step must be done first.');
    }
    if (row.ownerActivatedAt !== null) {
      throw activationError(
        CODES.LINK_USED,
        'The hosted owner already activated their panel; no new link is made.',
      );
    }
  }

  private async identify(token: string): Promise<{ botId: string; username: string }> {
    const probe = await this.deps.telegram.identify(token);
    if (probe.outcome === 'IDENTIFIED') {
      if (probe.isBot === false) {
        throw activationError(CODES.TOKEN_REJECTED, 'Telegram says that token is not a bot’s.');
      }
      return { botId: probe.botId, username: probe.username };
    }
    if (probe.outcome === 'UNREACHABLE') {
      throw new NexaError({
        kind: 'UPSTREAM_UNAVAILABLE',
        code: CODES.TOKEN_UNREACHABLE,
        message: 'Telegram could not be asked. Try again in a moment.',
      });
    }
    throw activationError(CODES.TOKEN_REJECTED, 'Telegram rejected that token.');
  }

  private outbox(
    tx: TransactionScope,
    actor: ActorContext,
    hostedTenantId: string,
    step: HostedActivationStep,
    outcome: 'DONE' | 'FAILED',
    errorCode: string | null,
  ) {
    return this.deps.outbox.write(tx, actor, {
      eventType: 'HostedBotSetupStepChanged',
      aggregateType: 'Tenant',
      aggregateId: hostedTenantId,
      payload: { hostedTenantId, step, outcome, errorCode },
    });
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

  private async requireHosted(
    installation: TenantContext,
    hostedTenantId: string,
    mustBeActive = false,
  ): Promise<HostedBotRow> {
    const row = await this.deps.hosting.findHosted(installation, hostedTenantId);
    if (row === null) {
      throw errors.notFound(HOSTING_ERROR_CODES.BOT_NOT_FOUND, 'No such hosted bot.');
    }
    if (mustBeActive) assertActive(row);
    return row;
  }

  private async requireHostedIn(
    installation: TenantContext,
    hostedTenantId: string,
    tx: unknown,
  ): Promise<HostedBotRow> {
    const row = await this.deps.hosting.findHosted(installation, hostedTenantId, tx, true);
    if (row === null) {
      throw errors.notFound(HOSTING_ERROR_CODES.BOT_NOT_FOUND, 'No such hosted bot.');
    }
    return row;
  }

  private async view(
    installation: TenantContext,
    hostedTenantId: string,
  ): Promise<HostedActivationView> {
    const [row, link] = await Promise.all([
      this.deps.repository.find(installation, hostedTenantId),
      this.deps.repository.newestLink(installation, hostedTenantId),
    ]);
    const now = this.deps.clock.now();
    const bound = await this.deps.registrar.currentBot(
      systemContext('hosting.activation_status'),
      hostedTenantId,
    );
    return {
      hostedTenantId,
      domain: row?.domain ?? null,
      botUsername: bound?.username ?? null,
      dnsTarget: {
        hostname: this.deps.dnsTarget.hostname,
        addresses: [...this.deps.dnsTarget.addresses],
      },
      steps: stepViews(row, link, now),
      link:
        link === null
          ? null
          : {
              state: activationLinkState(link, now),
              createdAt: link.createdAt.toISOString(),
              expiresAt: link.expiresAt.toISOString(),
            },
      ownerActivatedAt: row?.ownerActivatedAt?.toISOString() ?? null,
    };
  }
}

const STEP_OF: Readonly<Record<HostedActivationRunnableStep, HostedActivationStep>> = {
  token: 'TOKEN',
  domain: 'DOMAIN',
  ssl: 'SSL',
  webhook: 'WEBHOOK',
};

function markOf(step: HostedActivationStep, row: HostedActivationRow): Date | null {
  switch (step) {
    case 'TOKEN':
      return row.tokenVerifiedAt;
    case 'DOMAIN':
      return row.dnsVerifiedAt;
    case 'SSL':
      return row.tlsVerifiedAt;
    case 'WEBHOOK':
      return row.webhookRegisteredAt;
    case 'LINK':
      return null;
  }
}

function successPatch(step: HostedActivationStep, now: Date): HostedActivationPatch {
  switch (step) {
    case 'TOKEN':
      return { tokenVerifiedAt: now };
    case 'DOMAIN':
      return { dnsVerifiedAt: now };
    case 'SSL':
      return { tlsVerifiedAt: now };
    case 'WEBHOOK':
      return { webhookRegisteredAt: now };
    case 'LINK':
      return {};
  }
}

/** A failed step takes with it every mark that depended on it. */
function failurePatch(step: HostedActivationStep): HostedActivationPatch {
  switch (step) {
    case 'TOKEN':
      return { tokenVerifiedAt: null, webhookRegisteredAt: null };
    case 'DOMAIN':
      return { dnsVerifiedAt: null, tlsVerifiedAt: null, webhookRegisteredAt: null };
    case 'SSL':
      return { tlsVerifiedAt: null, webhookRegisteredAt: null };
    case 'WEBHOOK':
      return { webhookRegisteredAt: null };
    case 'LINK':
      return {};
  }
}

/** A success clears the recorded error only when it was this step's own. */
function clearErrorOf(step: HostedActivationStep, row: HostedActivationRow): { error?: null } {
  return row.lastErrorStep === step ? { error: null } : {};
}

function stepViews(
  row: HostedActivationRow | null,
  link: HostedActivationLinkRow | null,
  now: Date,
): HostedActivationStepView[] {
  const view = (step: HostedActivationStep, doneAt: Date | null): HostedActivationStepView => {
    const failed = row?.lastErrorStep === step && doneAt === null;
    return {
      step,
      state: doneAt !== null ? 'DONE' : failed ? 'FAILED' : 'PENDING',
      doneAt: doneAt?.toISOString() ?? null,
      errorCode: failed ? (row?.lastErrorCode ?? null) : null,
    };
  };
  const linkLive = link !== null && activationLinkState(link, now) !== 'EXPIRED';
  return [
    view('TOKEN', row?.tokenVerifiedAt ?? null),
    view('DOMAIN', row?.dnsVerifiedAt ?? null),
    view('SSL', row?.tlsVerifiedAt ?? null),
    view('WEBHOOK', row?.webhookRegisteredAt ?? null),
    view('LINK', linkLive ? link.createdAt : null),
  ];
}

function assertActive(row: HostedBotRow): void {
  if (row.state !== 'ACTIVE') {
    throw activationError(
      CODES.BOT_NOT_ACTIVE,
      'This hosted bot is not active: nothing is set up for a stopped or deleted bot.',
    );
  }
}

const KIND_OF: Readonly<
  Record<string, 'VALIDATION' | 'CONFLICT' | 'PRECONDITION_FAILED' | 'UPSTREAM_UNAVAILABLE'>
> = {
  [CODES.NOT_CONFIGURED]: 'PRECONDITION_FAILED',
  [CODES.BOT_NOT_ACTIVE]: 'PRECONDITION_FAILED',
  [CODES.STEP_BLOCKED]: 'PRECONDITION_FAILED',
  [CODES.TOKEN_MALFORMED]: 'VALIDATION',
  [CODES.TOKEN_REJECTED]: 'VALIDATION',
  [CODES.TOKEN_UNREACHABLE]: 'UPSTREAM_UNAVAILABLE',
  [CODES.TOKEN_IN_USE]: 'CONFLICT',
  [CODES.TOKEN_OTHER_BOT]: 'CONFLICT',
  [CODES.DOMAIN_INVALID]: 'VALIDATION',
  [CODES.DOMAIN_RESERVED]: 'VALIDATION',
  [CODES.DOMAIN_TAKEN]: 'CONFLICT',
  [CODES.DOMAIN_LOCKED]: 'PRECONDITION_FAILED',
  [CODES.DNS_NOT_POINTED]: 'PRECONDITION_FAILED',
  [CODES.DNS_LOOKUP_FAILED]: 'UPSTREAM_UNAVAILABLE',
  [CODES.SSL_NOT_READY]: 'PRECONDITION_FAILED',
  [CODES.WEBHOOK_FAILED]: 'UPSTREAM_UNAVAILABLE',
  [CODES.LINK_INVALID]: 'PRECONDITION_FAILED',
  [CODES.LINK_EXPIRED]: 'PRECONDITION_FAILED',
  [CODES.LINK_USED]: 'PRECONDITION_FAILED',
  [CODES.USERNAME_TAKEN]: 'CONFLICT',
};

/** One construction for every activation refusal, so its HTTP kind is decided in one place. */
export function activationError(
  code: string,
  message: string,
  details?: Record<string, unknown>,
): NexaError {
  return new NexaError({
    kind: KIND_OF[code] ?? 'PRECONDITION_FAILED',
    code,
    message,
    ...(details ? { details } : {}),
  });
}

function parseTenantId(id: string): string {
  const parsed = uuidV7Schema.safeParse(id);
  if (!parsed.success) {
    throw errors.notFound(HOSTING_ERROR_CODES.BOT_NOT_FOUND, 'No such hosted bot.');
  }
  return parsed.data;
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== null && typeof current === 'object'; depth += 1) {
    const candidate = current as {
      code?: unknown;
      constraint?: unknown;
      constraint_name?: unknown;
    };
    if (
      candidate.code === '23505' &&
      (candidate.constraint ?? candidate.constraint_name) === constraint
    ) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
