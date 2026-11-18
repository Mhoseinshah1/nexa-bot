import {
  errors,
  NexaError,
  RESELLER_BOT_ERROR_CODES,
  RESELLER_BOT_MONTHLY_FEE_SETTING_KEY,
  RESELLER_BOT_OPS_CODES,
  resellerBotApproveRequestSchema,
  resellerBotAdminListQuerySchema,
  resellerBotCancelRequestSchema,
  resellerBotConfigureRequestSchema,
  resellerBotPayRequestSchema,
  resellerBotRejectRequestSchema,
  resellerBotSubmitRequestSchema,
  userIdSchema,
  type ActorContext,
  type AuditWriter,
  type Clock,
  type CustomerNotificationKind,
  type HostedActivationResponse,
  type HostedBotState,
  type IdempotencyStore,
  type IdGenerator,
  type Money,
  type MoneyWire,
  type OperationalEventRecorder,
  type PermissionKey,
  type ResellerBotOfferView,
  type ResellerBotRequestAdminResponse,
  type ResellerBotRequestAdminView,
  type ResellerBotRequestsAdminResponse,
  type ResellerBotRequestView,
  type ResellerBotTimelineEntry,
  type ScopeContext,
  type SecretCipher,
  type TemplateValues,
  type TenantContext,
  type UnitOfWork,
  type UserId,
} from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { OutboxWriter } from '../../../platform/eventing/infrastructure/outbox-writer.js';
import { hashRequest } from '../../../platform/idempotency/infrastructure/drizzle-idempotency-store.js';
import { rememberOnce } from '../../../platform/idempotency/application/remember-once.js';
import type { ScopeActivityReader } from '../../../platform/system/application/record-ping.service.js';
import type { PermissionGuard } from '../../../platform/access/application/permission-guard.js';
import { runAuthorizedMutation } from '../../../platform/access/application/authorized-mutation.js';
import type { SessionRepository } from '../../../platform/identity/application/ports.js';
import { refuseImpersonatedSecretWrite } from '../../../platform/identity/application/impersonation.js';
import type { HostingOwnerGuard } from '../../../platform/hosting/application/hosting-owner-guard.js';
import type { HostingSectionService } from '../../../platform/hosting/application/hosting-section.service.js';
import type { HostedActivationService } from '../../../platform/hosting/application/hosted-activation.service.js';
import type { HostedBotIdentifier } from '../../../platform/hosting/application/activation-ports.js';
import { parseHostedDomain } from '../../../platform/hosting/domain/hosted-domain.js';
import type { SettingsResolver } from '../../../control/settings/application/settings-resolver.js';
import type { CustomerNotifier } from '../../messaging/application/customer-notifier.js';
import type { ResellerRepository } from '../../resellers/application/ports.js';
import type { WalletRepository } from '../../wallet/application/ports.js';
import { shortfallMinor } from '../../wallet/domain/balance.js';
import { firstPeriod, renewalDue } from '../domain/fee-period.js';
import { chargePeriod } from './fee-charge.js';
import type { ResellerBotFeeService } from './reseller-bot-fee.service.js';
import type {
  ResellerBotChargeRecord,
  ResellerBotLifecycleMark,
  ResellerBotRepository,
  ResellerBotRequestRecord,
} from './ports.js';

/** Telegram's `<numeric bot id>:<secret>`. Anything else never reaches Telegram. */
const BOT_TOKEN_SHAPE = /^\d{4,20}:[A-Za-z0-9_-]{20,}$/;
/** What the reseller's own writes run under (`SYSTEM_JOB` holds it), as reseller requests do. */
const CUSTOMER_PERMISSION: PermissionKey = 'maintenance.run';
/** Bounds each enrichment read, including the reseller's complete historical list. */
const READ_BATCH_SIZE = 100;

export interface ResellerBotRequestDeps {
  readonly repository: ResellerBotRepository;
  readonly resellers: Pick<ResellerRepository, 'findByCustomer'>;
  readonly wallet: Pick<WalletRepository, 'lockCustomer' | 'balanceOf' | 'append'>;
  readonly fees: Pick<ResellerBotFeeService, 'payNow' | 'graceDays'>;
  readonly telegram: HostedBotIdentifier;
  readonly cipher: SecretCipher;
  readonly section: Pick<
    HostingSectionService,
    'requireSection' | 'assertSectionIn' | 'withFreshProof'
  >;
  readonly owner: Pick<HostingOwnerGuard, 'check'>;
  readonly activation: Pick<HostedActivationService, 'configure'>;
  readonly notifier: Pick<CustomerNotifier, 'notify'>;
  readonly settings: Pick<SettingsResolver, 'valueOf'>;
  readonly scopeActivity: ScopeActivityReader;
  readonly guard: PermissionGuard;
  readonly sessions: SessionRepository;
  readonly idempotency: IdempotencyStore;
  readonly audit: AuditWriter;
  readonly opsLog: OperationalEventRecorder;
  readonly outbox: OutboxWriter;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /** The installation tenant: the only one that offers a dedicated bot. */
  readonly installationTenantId: () => string | null;
  /** This server's own names: never a reseller's domain. */
  readonly reservedHosts: ReadonlySet<string>;
}

const wire = (amountMinor: bigint, currency: string): MoneyWire =>
  ({ amountMinor: amountMinor.toString(), currency }) as MoneyWire;

/**
 * Reseller-phase PR-6 (§5.9) — a reseller's request for a dedicated hosted bot, both sides.
 *
 * RESELLER side (the reseller panel's controller and, later, the bot call these with the
 * session's customer): `offer`, `submit`, `listOwn`, `cancel`, `payAndReactivate`. Every one
 * re-checks that the customer is an ACTIVE reseller of the INSTALLATION tenant, and every read
 * and write of a request is filtered by the customer — another reseller's request is
 * `reseller_bot.request_not_found`, never a different answer.
 *
 * OWNER side («میزبانی‌ها» → «درخواست‌های نماینده‌ها», behind the creator panel's owner check
 * and section session): `adminList`, `approve` (a fresh code; debits the first month under the
 * wallet lock — refused, nothing written, when the wallet is short), `reject` (a reason, no
 * money), `configureActivation` (hands the sealed token to the EXISTING activation). The hosted
 * bot itself is created by the EXISTING `HostingService.create`, which calls `linkCreated`
 * inside its transaction; the activation link it issues reaches the reseller through
 * `activationLinkIssued`.
 */
export class ResellerBotRequestService {
  constructor(private readonly deps: ResellerBotRequestDeps) {}

  // ---------------------------------------------------------------------------------------
  // Reseller side
  // ---------------------------------------------------------------------------------------

  /** «ربات اختصاصی»: offered or not, the fee, and whether a request may be filed now. */
  async offer(scope: TenantContext, customerId: string): Promise<ResellerBotOfferView> {
    const customer = this.customerId(customerId);
    const fee = await this.fee(scope);
    const graceDays = this.isInstallation(scope) ? await this.deps.fees.graceDays(scope) : 0;
    if (fee === null) return { offered: false, fee: null, graceDays, canRequest: false };
    const active = await this.isActiveReseller(scope, customer);
    const pending = await this.deps.repository.findPendingByCustomer(scope, customer);
    return {
      offered: true,
      fee: wire(fee.amountMinor, fee.currency),
      graceDays,
      canRequest: active && pending === null,
    };
  }

  /**
   * Files a request: the token validated with Telegram (`getMe`) BEFORE anything is stored,
   * then sealed (`hosting.reseller_bot_token`); the fee snapshotted from the setting.
   */
  async submit(
    scope: TenantContext,
    actor: ActorContext,
    input: { readonly customerId: string } & Record<string, unknown>,
  ): Promise<ResellerBotRequestView> {
    const customerId = this.customerId(input.customerId);
    const command = resellerBotSubmitRequestSchema.parse(input);
    const domain = this.domainOf(command.domain ?? null);
    if (!BOT_TOKEN_SHAPE.test(command.botToken)) {
      throw errors.validation(RESELLER_BOT_ERROR_CODES.TOKEN_MALFORMED, 'Not a bot token.');
    }
    // The token is NOT in the hash: an idempotency row never carries a credential's digest.
    const requestHash = hashRequest({ action: 'reseller_bot.submit', customerId, domain });
    const replayed = await this.replayView(
      scope,
      actor,
      command.idempotencyKey,
      requestHash,
      customerId,
    );
    if (replayed !== null) return replayed;
    const fee = await this.fee(scope);
    if (fee === null) throw notOffered();
    if (!(await this.isActiveReseller(scope, customerId))) throw notReseller();
    if ((await this.deps.repository.findPendingByCustomer(scope, customerId)) !== null) {
      throw requestOpen();
    }
    // Telegram, outside any transaction and before anything is stored.
    const identity = await this.identify(command.botToken);
    const id = this.deps.ids.uuid();
    refuseImpersonatedSecretWrite(actor, 'hosting.reseller_bot_token');
    const sealed = this.deps.cipher.encrypt(command.botToken, {
      purpose: 'hosting.reseller_bot_token',
      tenantId: scope.tenantId as string,
      entityId: id,
    });
    await this.customerMutation(
      scope,
      actor,
      'hosting.reseller_bot.submit',
      customerId,
      async (tx) => {
        const now = this.deps.clock.now();
        if (!(await this.isActiveReseller(scope, customerId, tx))) throw notReseller();
        // Re-read under the transaction: the setting may have changed since the courtesy above.
        if ((await this.fee(scope, tx)) === null) throw notOffered();
        if ((await this.deps.repository.findPendingByCustomer(scope, customerId, tx)) !== null) {
          throw requestOpen();
        }
        if (await this.deps.repository.liveBotTaken(scope, identity.botId, tx)) throw tokenInUse();
        const request = await this.deps.repository.insert(
          scope,
          {
            id,
            customerId,
            telegramBotId: identity.botId,
            botUsername: identity.username,
            tokenCiphertext: sealed.ciphertext,
            tokenKeyId: sealed.keyId,
            domain,
            feeAmountMinor: fee.amountMinor,
            feeCurrency: fee.currency,
            now,
          },
          tx,
        );
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'hosting.reseller_bot.submit',
            entityType: 'ResellerBotRequest',
            entityId: request.id,
            before: null,
            // The bot's identity and the fee; never the token.
            after: {
              customerId,
              botUsername: identity.username,
              telegramBotId: identity.botId,
              domain,
              feeAmountMinor: fee.amountMinor.toString(),
              currency: fee.currency,
            },
            result: 'SUCCESS',
          },
          tx,
        );
        await rememberOnce(
          this.deps.idempotency,
          scope,
          actor.surface,
          command.idempotencyKey,
          requestHash,
          { requestId: request.id },
          tx,
        );
      },
    ).catch((error: unknown) => {
      if (isUniqueViolation(error, 'reseller_bot_requests_one_pending_key')) throw requestOpen();
      if (isUniqueViolation(error, 'reseller_bot_requests_live_bot_key')) throw tokenInUse();
      throw error;
    });
    return this.ownView(scope, customerId, id);
  }

  /** The reseller's own requests, newest first, each with its timeline. */
  async listOwn(scope: TenantContext, customerId: string): Promise<ResellerBotRequestView[]> {
    const customer = this.customerId(customerId);
    if (!(await this.isActiveReseller(scope, customer))) throw notReseller();
    const rows = await this.deps.repository.listByCustomer(scope, customer);
    return this.views(scope, rows);
  }

  /** Withdraws a request still waiting for the owner. Charges nothing. */
  async cancel(
    scope: TenantContext,
    actor: ActorContext,
    input: { readonly customerId: string; readonly requestId: string } & Record<string, unknown>,
  ): Promise<ResellerBotRequestView> {
    const customerId = this.customerId(input.customerId);
    const command = resellerBotCancelRequestSchema.parse(input);
    const requestHash = hashRequest({
      action: 'reseller_bot.cancel',
      customerId,
      requestId: input.requestId,
    });
    const replayed = await this.replayView(
      scope,
      actor,
      command.idempotencyKey,
      requestHash,
      customerId,
    );
    if (replayed !== null) return replayed;
    await this.customerMutation(
      scope,
      actor,
      'hosting.reseller_bot.cancel',
      customerId,
      async (tx) => {
        if (!(await this.isActiveReseller(scope, customerId, tx))) throw notReseller();
        const request = await this.ownedLocked(scope, customerId, input.requestId, tx);
        const now = this.deps.clock.now();
        if (
          request.status !== 'PENDING' ||
          !(await this.deps.repository.cancel(scope, request.id, now, tx))
        ) {
          throw stateConflict('Only a request waiting for the owner can be cancelled.');
        }
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'hosting.reseller_bot.cancel',
            entityType: 'ResellerBotRequest',
            entityId: request.id,
            before: { status: 'PENDING' },
            after: { status: 'CANCELLED' },
            result: 'SUCCESS',
          },
          tx,
        );
        await rememberOnce(
          this.deps.idempotency,
          scope,
          actor.surface,
          command.idempotencyKey,
          requestHash,
          { requestId: request.id },
          tx,
        );
      },
    );
    return this.ownView(scope, customerId, input.requestId);
  }

  /**
   * «پرداخت و فعال‌سازی دوباره»: pays the due period now, under the wallet lock, and resumes the
   * bot when the renewal job had stopped it. NOTHING_DUE when the period is paid,
   * INSUFFICIENT_FUNDS when the wallet is short — nothing is charged either way.
   */
  async payAndReactivate(
    scope: TenantContext,
    actor: ActorContext,
    input: { readonly customerId: string; readonly requestId: string } & Record<string, unknown>,
  ): Promise<ResellerBotRequestView> {
    const customerId = this.customerId(input.customerId);
    const command = resellerBotPayRequestSchema.parse(input);
    const requestHash = hashRequest({
      action: 'reseller_bot.pay',
      customerId,
      requestId: input.requestId,
    });
    const replayed = await this.replayView(
      scope,
      actor,
      command.idempotencyKey,
      requestHash,
      customerId,
    );
    if (replayed !== null) return replayed;
    await this.customerMutation(
      scope,
      actor,
      'hosting.reseller_bot.pay',
      customerId,
      async (tx) => {
        if (!(await this.isActiveReseller(scope, customerId, tx))) throw notReseller();
        const request = await this.ownedLocked(scope, customerId, input.requestId, tx);
        await this.deps.fees.payNow(scope, actor, request, this.deps.clock.now(), tx);
        await rememberOnce(
          this.deps.idempotency,
          scope,
          actor.surface,
          command.idempotencyKey,
          requestHash,
          { requestId: request.id },
          tx,
        );
      },
    );
    return this.ownView(scope, customerId, input.requestId);
  }

  // ---------------------------------------------------------------------------------------
  // Owner side
  // ---------------------------------------------------------------------------------------

  async adminList(
    scope: ScopeContext,
    actor: ActorContext,
    sectionToken: string | null,
    input: unknown = {},
  ): Promise<ResellerBotRequestsAdminResponse> {
    const installation = await this.deps.section.requireSection(
      scope,
      actor,
      sectionToken,
      'hosting.reseller_bot.list',
    );
    const query = resellerBotAdminListQuerySchema.parse(input);
    const found = await this.deps.repository.listAll(installation, query.limit + 1, query.cursor);
    const rows = found.slice(0, query.limit);
    const fee = await this.fee(installation);
    return {
      nextCursor: found.length > query.limit ? (rows.at(-1)?.id ?? null) : null,
      requests: await this.adminViews(installation, rows),
      settings: {
        fee: fee === null ? null : wire(fee.amountMinor, fee.currency),
        graceDays: await this.deps.fees.graceDays(installation),
      },
    };
  }

  /**
   * Approves a PENDING request and debits its first month, in ONE transaction: the owner and
   * section re-checked, the installation's `ScopeActivityReader`, the request row locked, the
   * reseller still ACTIVE, the wallet locked and its balance read, the `HOSTED_BOT_FEE` debit
   * under `hosted-bot-fee:<request>:1`, the request APPROVED with its first period paid, the
   * audit row, the operations message and the idempotency record. A short wallet refuses with
   * `reseller_bot.insufficient_funds` and writes NOTHING. A replay answers the first result.
   */
  async approve(
    scope: ScopeContext,
    actor: ActorContext,
    sectionToken: string | null,
    requestId: string,
    body: unknown,
  ): Promise<ResellerBotRequestAdminResponse> {
    const action = 'hosting.reseller_bot.approve';
    const installation = await this.deps.section.requireSection(
      scope,
      actor,
      sectionToken,
      action,
      requestId,
    );
    const command = resellerBotApproveRequestSchema.parse(body);
    const requestHash = hashRequest({ action, requestId });
    const replay = await this.deps.idempotency.find<{ requestId: string }>(
      installation,
      actor.surface,
      command.idempotencyKey,
      requestHash,
    );
    if (replay !== null) {
      return {
        request: await this.adminView(installation, replay.result.requestId),
        replayed: true,
      };
    }
    const existing = await this.deps.repository.find(installation, requestId);
    if (existing === null) throw notFound();
    if (existing.status !== 'PENDING') throw stateConflict('Only a pending request is approved.');

    await this.deps.section.withFreshProof(
      installation,
      actor,
      command.proof,
      action,
      async (tx, now, method) => {
        await this.ownerInTransaction(installation, actor, sectionToken, tx);
        const request = await this.deps.repository.find(installation, requestId, tx, true);
        if (request === null) throw notFound();
        if (request.status !== 'PENDING')
          throw stateConflict('Only a pending request is approved.');
        if (!(await this.isActiveReseller(installation, request.customerId, tx))) {
          throw notReseller();
        }
        const window = firstPeriod(now);
        const charged = await chargePeriod(
          {
            wallet: this.deps.wallet,
            repository: this.deps.repository,
            outbox: this.deps.outbox,
            ids: this.deps.ids,
          },
          installation,
          actor,
          { request, period: 1, start: window.start, end: window.end, kind: 'APPROVAL', now },
          tx,
        );
        if (charged.kind === 'NO_CUSTOMER') throw notFound();
        if (charged.kind === 'SHORT') {
          throw errors.conflict(
            RESELLER_BOT_ERROR_CODES.INSUFFICIENT_FUNDS,
            'The reseller’s wallet does not hold the first month’s fee.',
            {
              shortfallMinor: charged.shortfallMinor.toString(),
              currency: request.feeCurrency,
            },
          );
        }
        if (
          !(await this.deps.repository.approve(
            installation,
            request.id,
            { adminId: actor.id as string, paidThrough: window.end, now },
            tx,
          ))
        ) {
          throw stateConflict('Only a pending request is approved.');
        }
        await this.deps.audit.record(
          installation,
          actor,
          {
            action,
            entityType: 'ResellerBotRequest',
            entityId: request.id,
            before: { status: 'PENDING' },
            after: {
              status: 'APPROVED',
              period: 1,
              paidThrough: window.end.toISOString(),
              amountMinor: request.feeAmountMinor.toString(),
              currency: request.feeCurrency,
              reference: charged.reference,
              walletEntryId: charged.entryId,
              proof: method,
            },
            result: 'SUCCESS',
          },
          tx,
        );
        await this.deps.opsLog.record(
          installation,
          {
            code: RESELLER_BOT_OPS_CODES.APPROVED,
            severity: 'INFO',
            message: `درخواست ربات اختصاصی @${request.botUsername} تأیید شد و هزینهٔ ماه اول (${request.feeAmountMinor.toString()} ${request.feeCurrency}) از کیف پول نماینده کسر شد.`,
            dedupeKey: `${RESELLER_BOT_OPS_CODES.APPROVED}:${request.id}`,
            context: {
              requestId: request.id,
              period: 1,
              amountMinor: request.feeAmountMinor.toString(),
              currency: request.feeCurrency,
            },
            correlationId: actor.correlationId,
          },
          tx,
        );
        await rememberOnce(
          this.deps.idempotency,
          installation,
          actor.surface,
          command.idempotencyKey,
          requestHash,
          { requestId: request.id },
          tx,
        );
      },
    );
    return { request: await this.adminView(installation, requestId), replayed: false };
  }

  /** Rejects a PENDING request with the owner's reason (3–500 characters). Charges nothing. */
  async reject(
    scope: ScopeContext,
    actor: ActorContext,
    sectionToken: string | null,
    requestId: string,
    body: unknown,
  ): Promise<ResellerBotRequestAdminResponse> {
    const action = 'hosting.reseller_bot.reject';
    const installation = await this.deps.section.requireSection(
      scope,
      actor,
      sectionToken,
      action,
      requestId,
    );
    const command = resellerBotRejectRequestSchema.parse(body);
    const requestHash = hashRequest({ action, requestId, reason: command.reason });
    const replay = await this.deps.idempotency.find<{ requestId: string }>(
      installation,
      actor.surface,
      command.idempotencyKey,
      requestHash,
    );
    if (replay !== null) {
      return {
        request: await this.adminView(installation, replay.result.requestId),
        replayed: true,
      };
    }
    await this.deps.uow.run(installation, async (tx) => {
      await this.ownerInTransaction(installation, actor, sectionToken, tx);
      const request = await this.deps.repository.find(installation, requestId, tx, true);
      if (request === null) throw notFound();
      const now = this.deps.clock.now();
      if (
        request.status !== 'PENDING' ||
        !(await this.deps.repository.reject(
          installation,
          request.id,
          { adminId: actor.id as string, reason: command.reason, now },
          tx,
        ))
      ) {
        throw stateConflict('Only a pending request is rejected.');
      }
      await this.deps.audit.record(
        installation,
        actor,
        {
          action,
          entityType: 'ResellerBotRequest',
          entityId: request.id,
          before: { status: 'PENDING' },
          after: { status: 'REJECTED' },
          reason: command.reason,
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
        { requestId: request.id },
        tx,
      );
    });
    return { request: await this.adminView(installation, requestId), replayed: false };
  }

  /**
   * «توکن و دامنه» from the request: the sealed token is opened HERE and handed to the EXISTING
   * activation step (`HostedActivationService.configure`: `getMe`, the identity checks, the
   * fresh code, the bot binding) — the token never travels through the owner's browser.
   */
  async configureActivation(
    scope: ScopeContext,
    actor: ActorContext,
    sectionToken: string | null,
    requestId: string,
    body: unknown,
  ): Promise<HostedActivationResponse> {
    const installation = await this.deps.section.requireSection(
      scope,
      actor,
      sectionToken,
      'hosting.reseller_bot.configure',
      requestId,
    );
    const command = resellerBotConfigureRequestSchema.parse(body);
    const request = await this.deps.repository.find(installation, requestId);
    if (request === null) throw notFound();
    if (request.status !== 'APPROVED') throw stateConflict('The request is not approved.');
    if (request.hostedTenantId === null) {
      throw errors.conflict(RESELLER_BOT_ERROR_CODES.NOT_LINKED, 'Create the hosted bot first.');
    }
    const botToken = this.deps.cipher.decrypt(
      { ciphertext: request.tokenCiphertext, keyId: request.tokenKeyId },
      {
        purpose: 'hosting.reseller_bot_token',
        tenantId: installation.tenantId,
        entityId: request.id,
      },
    );
    return this.deps.activation.configure(scope, actor, sectionToken, request.hostedTenantId, {
      idempotencyKey: command.idempotencyKey,
      proof: command.proof,
      botToken,
      domain: command.domain,
    });
  }

  // ---------------------------------------------------------------------------------------
  // Hooks the hosting services call inside their own transactions
  // ---------------------------------------------------------------------------------------

  /**
   * `HostingService.create` with `resellerBotRequestId`: links the new hosted bot to the
   * APPROVED, unlinked request, inside the create's transaction (the `hosted_bots` row exists).
   */
  async linkCreated(
    installation: TenantContext,
    actor: ActorContext,
    requestId: string,
    hostedTenantId: string,
    now: Date,
    tx: TransactionScope,
  ): Promise<void> {
    const request = await this.deps.repository.find(installation, requestId, tx, true);
    if (request === null) throw notFound();
    if (request.status !== 'APPROVED') throw stateConflict('The request is not approved.');
    if (request.hostedTenantId !== null) {
      throw errors.conflict(RESELLER_BOT_ERROR_CODES.ALREADY_LINKED, 'Already linked.');
    }
    if (!(await this.deps.repository.link(installation, requestId, hostedTenantId, now, tx))) {
      throw errors.conflict(RESELLER_BOT_ERROR_CODES.ALREADY_LINKED, 'Already linked.');
    }
    await this.deps.audit.record(
      installation,
      actor,
      {
        action: 'hosting.reseller_bot.link',
        entityType: 'ResellerBotRequest',
        entityId: requestId,
        before: { hostedTenantId: null },
        after: { hostedTenantId },
        result: 'SUCCESS',
      },
      tx,
    );
  }

  /**
   * `HostedActivationService.issueLink`, inside its transaction: when the hosted bot belongs to
   * a reseller's request, the link is sealed on the request (`hosting.reseller_activation_link`)
   * and ONE `HOSTED_BOT_ACTIVATION_LINK` notification is queued for the reseller, its subject
   * the link. Nothing else carries the address: the audit row names the link's id, the outbox
   * nothing, and the delivered message's text is never stored
   * (`CUSTOMER_NOTIFICATION_TEXT_NOT_STORED`).
   */
  async activationLinkIssued(
    installation: TenantContext,
    actor: ActorContext,
    link: { readonly hostedTenantId: string; readonly linkId: string; readonly url: string },
    now: Date,
    tx: TransactionScope,
  ): Promise<void> {
    const request = await this.deps.repository.findByHosted(
      installation,
      link.hostedTenantId,
      tx,
      true,
    );
    if (request === null || request.status !== 'APPROVED') return;
    refuseImpersonatedSecretWrite(actor, 'hosting.reseller_activation_link');
    const sealed = this.deps.cipher.encrypt(link.url, {
      purpose: 'hosting.reseller_activation_link',
      tenantId: installation.tenantId as string,
      entityId: request.id,
    });
    await this.deps.repository.setActivationLink(
      installation,
      request.id,
      { linkId: link.linkId, ciphertext: sealed.ciphertext, keyId: sealed.keyId, now },
      tx,
    );
    const queued = await this.deps.notifier.notify(
      installation,
      request.customerId,
      'HOSTED_BOT_ACTIVATION_LINK',
      link.linkId,
      now,
      tx,
    );
    await this.deps.audit.record(
      installation,
      actor,
      {
        action: 'hosting.reseller_bot.link_sent',
        entityType: 'ResellerBotRequest',
        entityId: request.id,
        before: null,
        // The link's id only — never the address, never the token.
        after: { linkId: link.linkId, queued },
        result: 'SUCCESS',
      },
      tx,
    );
  }

  /**
   * What `HOSTED_BOT_ACTIVATION_LINK` and `HOSTED_BOT_FEE_SHORT` render, read at send time. Null
   * — nothing sent — when the link is no longer open, or the period was paid meanwhile.
   */
  async notificationFacts(
    scope: TenantContext,
    kind: Extract<CustomerNotificationKind, 'HOSTED_BOT_ACTIVATION_LINK' | 'HOSTED_BOT_FEE_SHORT'>,
    subjectId: string,
  ): Promise<{ readonly values: TemplateValues } | null> {
    const now = this.deps.clock.now();
    if (kind === 'HOSTED_BOT_ACTIVATION_LINK') {
      const open = await this.deps.repository.findByOpenLink(scope, subjectId, now);
      const { request } = open ?? {};
      if (
        open === null ||
        request === undefined ||
        request.activationLinkCiphertext === null ||
        request.activationLinkKeyId === null
      ) {
        return null;
      }
      const url = this.deps.cipher.decrypt(
        { ciphertext: request.activationLinkCiphertext, keyId: request.activationLinkKeyId },
        {
          purpose: 'hosting.reseller_activation_link',
          tenantId: scope.tenantId as string,
          entityId: request.id,
        },
      );
      return { values: { bot: request.botUsername, url, expiresAt: open.expiresAt } };
    }
    const notice = await this.deps.repository.findNotice(scope, subjectId);
    if (notice === null) return null;
    const request = await this.deps.repository.find(scope, notice.requestId);
    if (request === null || request.status !== 'APPROVED' || request.lastPeriod >= notice.period) {
      return null;
    }
    const balance = await this.deps.wallet.balanceOf(
      scope,
      request.customerId,
      request.feeCurrency,
    );
    const missing = shortfallMinor(balance.amountMinor, request.feeAmountMinor);
    if (missing === 0n) return null;
    return {
      values: {
        bot: request.botUsername,
        fee: moneyOf(request.feeAmountMinor, request.feeCurrency),
        shortfall: moneyOf(missing, request.feeCurrency),
        deadline: notice.deadline,
      },
    };
  }

  // ---------------------------------------------------------------------------------------

  private async customerMutation(
    scope: TenantContext,
    actor: ActorContext,
    action: string,
    customerId: UserId,
    fn: (tx: TransactionScope) => Promise<void>,
  ): Promise<void> {
    await runAuthorizedMutation(
      {
        uow: this.deps.uow,
        guard: this.deps.guard,
        audit: this.deps.audit,
        opsLog: this.deps.opsLog,
        sessions: this.deps.sessions,
        clock: this.deps.clock,
      },
      scope,
      actor,
      CUSTOMER_PERMISSION,
      { action, entityType: 'Customer', entityId: customerId },
      async (tx) => {
        if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) {
          throw notOffered();
        }
        await fn(tx);
      },
    );
  }

  private async ownerInTransaction(
    installation: TenantContext,
    actor: ActorContext,
    sectionToken: string | null,
    tx: TransactionScope,
  ): Promise<void> {
    await this.deps.owner.check(installation, actor, tx);
    await this.deps.section.assertSectionIn(installation, actor, sectionToken, tx);
    if (!(await this.deps.scopeActivity.scopeIsActive(installation, tx))) {
      throw errors.conflict(RESELLER_BOT_ERROR_CODES.NOT_OFFERED, 'This installation is stopped.');
    }
  }

  /** The request, locked, when it is THIS customer's; otherwise not found (no oracle). */
  private async ownedLocked(
    scope: TenantContext,
    customerId: UserId,
    requestId: string,
    tx: TransactionScope,
  ): Promise<ResellerBotRequestRecord> {
    const request = await this.deps.repository.find(scope, requestId, tx, true);
    if (request === null || request.customerId !== customerId) throw notFound();
    return request;
  }

  private async replayView(
    scope: TenantContext,
    actor: ActorContext,
    key: string,
    requestHash: string,
    customerId: UserId,
  ): Promise<ResellerBotRequestView | null> {
    const replay = await this.deps.idempotency.find<{ requestId: string }>(
      scope,
      actor.surface,
      key,
      requestHash,
    );
    return replay === null ? null : this.ownView(scope, customerId, replay.result.requestId);
  }

  private async ownView(
    scope: TenantContext,
    customerId: UserId,
    requestId: string,
  ): Promise<ResellerBotRequestView> {
    const request = await this.deps.repository.find(scope, requestId);
    if (request === null || request.customerId !== customerId) throw notFound();
    const [view] = await this.views(scope, [request]);
    return view as ResellerBotRequestView;
  }

  private async adminView(
    installation: TenantContext,
    requestId: string,
  ): Promise<ResellerBotRequestAdminView> {
    const request = await this.deps.repository.find(installation, requestId);
    if (request === null) throw notFound();
    const [view] = await this.adminViews(installation, [request]);
    return view as ResellerBotRequestAdminView;
  }

  private async adminViews(
    installation: TenantContext,
    rows: readonly ResellerBotRequestRecord[],
  ): Promise<ResellerBotRequestAdminView[]> {
    const views = await this.views(installation, rows);
    const customers = new Map<
      string,
      Awaited<ReturnType<ResellerBotRepository['customerSummaries']>>[number]
    >();
    const ids = [...new Set(rows.map((row) => row.customerId))];
    for (let offset = 0; offset < ids.length; offset += READ_BATCH_SIZE) {
      for (const customer of await this.deps.repository.customerSummaries(
        installation,
        ids.slice(offset, offset + READ_BATCH_SIZE),
      )) {
        customers.set(customer.id, customer);
      }
    }
    const out: ResellerBotRequestAdminView[] = [];
    for (const [index, view] of views.entries()) {
      const row = rows[index] as ResellerBotRequestRecord;
      const customer = customers.get(row.customerId);
      const name = [customer?.firstName, customer?.lastName].filter(Boolean).join(' ');
      out.push({
        ...view,
        customer: {
          id: row.customerId,
          displayName: name !== '' ? name : (customer?.username ?? null),
          telegramUserId: customer?.telegramUserId ?? null,
        },
        hostedTenantId: row.hostedTenantId,
      });
    }
    return out;
  }

  private async views(
    scope: TenantContext,
    rows: readonly ResellerBotRequestRecord[],
  ): Promise<ResellerBotRequestView[]> {
    const charges = new Map<string, ResellerBotChargeRecord[]>();
    const marks = new Map<string, ResellerBotLifecycleMark[]>();
    const hosted = new Map<string, HostedBotState>();
    for (let offset = 0; offset < rows.length; offset += READ_BATCH_SIZE) {
      const batch = rows.slice(offset, offset + READ_BATCH_SIZE);
      const ids = batch.map((row) => row.id);
      for (const charge of await this.deps.repository.listCharges(scope, ids)) {
        const group = charges.get(charge.requestId) ?? [];
        group.push(charge);
        charges.set(charge.requestId, group);
      }
      for (const mark of await this.deps.repository.lifecycleMarks(scope, ids)) {
        const group = marks.get(mark.requestId) ?? [];
        group.push(mark);
        marks.set(mark.requestId, group);
      }
      const hostedIds = [
        ...new Set(
          batch.flatMap((row) => (row.hostedTenantId === null ? [] : [row.hostedTenantId])),
        ),
      ];
      for (const bot of await this.deps.repository.hostedStates(scope, hostedIds))
        hosted.set(bot.id, bot.state);
    }
    const graceDays = rows.some((row) => row.status === 'APPROVED')
      ? await this.deps.fees.graceDays(scope)
      : 0;
    const now = this.deps.clock.now();
    const out: ResellerBotRequestView[] = [];
    for (const row of rows) {
      out.push(
        this.view(
          row,
          row.hostedTenantId === null ? null : (hosted.get(row.hostedTenantId) ?? null),
          charges.get(row.id) ?? [],
          marks.get(row.id) ?? [],
          graceDays,
          now,
        ),
      );
    }
    return out;
  }

  private view(
    row: ResellerBotRequestRecord,
    hostedState: HostedBotState | null,
    charges: readonly ResellerBotChargeRecord[],
    marks: readonly ResellerBotLifecycleMark[],
    graceDays: number,
    now: Date,
  ): ResellerBotRequestView {
    const timeline: ResellerBotTimelineEntry[] = [
      { event: 'SUBMITTED', at: row.createdAt.toISOString(), amount: null, period: null },
    ];
    if (row.decidedAt !== null) {
      timeline.push({
        event: row.status === 'REJECTED' ? 'REJECTED' : 'APPROVED',
        at: row.decidedAt.toISOString(),
        amount: null,
        period: null,
      });
    }
    if (row.cancelledAt !== null) {
      timeline.push({
        event: 'CANCELLED',
        at: row.cancelledAt.toISOString(),
        amount: null,
        period: null,
      });
    }
    if (row.linkedAt !== null) {
      timeline.push({
        event: 'BOT_CREATED',
        at: row.linkedAt.toISOString(),
        amount: null,
        period: null,
      });
    }
    if (row.activationLinkSentAt !== null) {
      timeline.push({
        event: 'LINK_SENT',
        at: row.activationLinkSentAt.toISOString(),
        amount: null,
        period: null,
      });
    }
    for (const charge of charges) {
      timeline.push({
        event: 'CHARGED',
        at: charge.createdAt.toISOString(),
        amount: wire(charge.amountMinor, charge.currency),
        period: charge.period,
      });
    }
    for (const mark of marks) {
      timeline.push({ event: mark.event, at: mark.at.toISOString(), amount: null, period: null });
    }
    timeline.sort((a, b) => a.at.localeCompare(b.at));

    let billing: ResellerBotRequestView['billing'] = {
      state: 'NONE',
      paidThrough: null,
      stopsAt: null,
    };
    if (row.status === 'APPROVED' && row.paidThrough !== null) {
      const due = renewalDue(
        {
          paidThrough: row.paidThrough,
          lastPeriod: row.lastPeriod,
          feeStoppedAt: row.feeStoppedAt,
        },
        now,
        graceDays,
      );
      billing =
        row.feeStoppedAt !== null
          ? { state: 'STOPPED', paidThrough: row.paidThrough.toISOString(), stopsAt: null }
          : due.kind === 'NOT_DUE'
            ? { state: 'PAID', paidThrough: row.paidThrough.toISOString(), stopsAt: null }
            : {
                state: 'GRACE',
                paidThrough: row.paidThrough.toISOString(),
                stopsAt: due.graceEndsAt.toISOString(),
              };
    }
    return {
      id: row.id,
      number: row.number.toString(),
      state: row.status,
      botUsername: row.botUsername,
      tokenMasked: this.deps.cipher.mask({
        ciphertext: row.tokenCiphertext,
        keyId: row.tokenKeyId,
      }),
      domain: row.domain,
      fee: wire(row.feeAmountMinor, row.feeCurrency),
      createdAt: row.createdAt.toISOString(),
      decidedAt: row.decidedAt?.toISOString() ?? null,
      rejectReason: row.rejectReason,
      cancelledAt: row.cancelledAt?.toISOString() ?? null,
      hostedBot: { linked: row.hostedTenantId !== null, state: hostedState },
      billing,
      timeline,
    };
  }

  /** The installation's fee, or null when it is not offered (zero, or not the installation). */
  private async fee(scope: TenantContext, tx?: unknown): Promise<Money | null> {
    if (!this.isInstallation(scope)) return null;
    const value = await this.deps.settings.valueOf<MoneyWire>(
      scope,
      RESELLER_BOT_MONTHLY_FEE_SETTING_KEY,
      tx,
    );
    const amountMinor = BigInt(value.amountMinor);
    return amountMinor > 0n ? moneyOf(amountMinor, value.currency) : null;
  }

  private isInstallation(scope: TenantContext): boolean {
    const installation = this.deps.installationTenantId();
    return (
      installation !== null && installation.toLowerCase() === String(scope.tenantId).toLowerCase()
    );
  }

  private async isActiveReseller(
    scope: TenantContext,
    customerId: UserId,
    tx?: unknown,
  ): Promise<boolean> {
    if (!this.isInstallation(scope)) return false;
    const reseller = await this.deps.resellers.findByCustomer(scope, customerId, tx);
    return reseller !== null && reseller.status === 'ACTIVE';
  }

  private domainOf(raw: string | null): string | null {
    if (raw === null || raw.trim() === '') return null;
    const parsed = parseHostedDomain(raw, this.deps.reservedHosts);
    if (!parsed.ok) {
      throw errors.validation(RESELLER_BOT_ERROR_CODES.DOMAIN_INVALID, 'Not a bare domain name.');
    }
    return parsed.domain;
  }

  private async identify(token: string): Promise<{ botId: string; username: string }> {
    const probe = await this.deps.telegram.identify(token);
    if (probe.outcome === 'IDENTIFIED') {
      if (probe.isBot === false) {
        throw errors.validation(RESELLER_BOT_ERROR_CODES.TOKEN_REJECTED, 'Not a bot’s token.');
      }
      return { botId: probe.botId, username: probe.username };
    }
    if (probe.outcome === 'UNREACHABLE') {
      throw new NexaError({
        kind: 'UPSTREAM_UNAVAILABLE',
        code: RESELLER_BOT_ERROR_CODES.TOKEN_UNREACHABLE,
        message: 'Telegram could not be asked. Try again in a moment.',
      });
    }
    throw errors.validation(
      RESELLER_BOT_ERROR_CODES.TOKEN_REJECTED,
      'Telegram rejected that token.',
    );
  }

  private customerId(candidate: string): UserId {
    const parsed = userIdSchema.safeParse(candidate);
    if (!parsed.success) throw notFound();
    return parsed.data;
  }
}

function moneyOf(amountMinor: bigint, currency: string): Money {
  return { amountMinor, currency } as Money;
}

const notFound = () =>
  errors.notFound(RESELLER_BOT_ERROR_CODES.REQUEST_NOT_FOUND, 'No such request.');
const notOffered = () =>
  errors.conflict(RESELLER_BOT_ERROR_CODES.NOT_OFFERED, 'A dedicated bot is not offered.');
const notReseller = () =>
  errors.preconditionFailed(RESELLER_BOT_ERROR_CODES.NOT_RESELLER, 'Not an active reseller.');
const requestOpen = () =>
  errors.conflict(RESELLER_BOT_ERROR_CODES.REQUEST_OPEN, 'A request already waits.');
const tokenInUse = () =>
  errors.conflict(RESELLER_BOT_ERROR_CODES.TOKEN_IN_USE, 'That bot is in another request.');
const stateConflict = (message: string) =>
  errors.conflict(RESELLER_BOT_ERROR_CODES.STATE_CONFLICT, message);

function isUniqueViolation(error: unknown, constraint: string): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current !== null && typeof current === 'object'; depth += 1) {
    const candidate = current as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (candidate.code === '23505' && candidate.constraint === constraint) return true;
    current = candidate.cause;
  }
  return false;
}
