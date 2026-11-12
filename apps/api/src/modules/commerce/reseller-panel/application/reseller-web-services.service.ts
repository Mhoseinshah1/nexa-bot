import {
  NexaError,
  RESELLER_SERVICE_FILTERS,
  RESELLER_WEB_AUDIT_ACTIONS,
  RESELLER_WEB_ERROR_CODES,
  RESELLER_WEB_EXPIRING_DAYS,
  RESELLER_WEB_EXPIRING_TRAFFIC_PERCENT,
  RESELLER_WEB_FILE_FETCHES_PER_WINDOW,
  RESELLER_WEB_FILE_FETCH_WINDOW_SECONDS,
  RESELLER_WEB_SERVICES_PAGE_SIZE,
  errors,
  type AuditWriter,
  type Clock,
  type IdGenerator,
  type ProviderSubscriptionFile,
  type QrPayloadKind,
  type ResellerServiceDetail,
  type ResellerServiceFilter,
  type ResellerServiceRow,
  type ResellerServicesResponse,
  type TenantContext,
  type UnitOfWork,
  type UserId,
} from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { CommercialActionService } from '../../commercial/application/commercial-action.service.js';
import type { ServiceRecord } from '../../provisioning/application/ports.js';
import type { DeliveryService } from '../../provisioning/application/delivery.service.js';
import { ProvisioningService } from '../../provisioning/application/provisioning.service.js';
import type { SubscriptionFileService } from '../../provisioning/application/subscription-file.service.js';
import type { ResellerWebRepository } from './ports.js';
import type { ResellerWebContext } from './reseller-web-access.service.js';

/**
 * What a Telegram send answered, as `resellerSendResultSchema` puts it on the wire. A refused
 * send (`STOPPED`) is a 409 with a Persian code, never a 200, so a success always says `SENT`.
 */
export interface ResellerSendResult {
  readonly outcome: 'SENT';
  readonly sent: number;
}

/** How many services the panel reads for its filters and search (the reseller's whole list). */
export const RESELLER_WEB_SERVICES_CAP = 5000;

const PANEL_ACTIONS = ['RENEW', 'ADD_TRAFFIC', 'ADD_TIME'] as const;

export interface ResellerWebServicesDeps {
  readonly provisioning: Pick<
    ProvisioningService,
    | 'getForCustomer'
    | 'listedForCustomer'
    | 'setCustomerNote'
    | 'customerRotationFor'
    | 'requestRotation'
    | 'changeInProgress'
  >;
  readonly delivery: Pick<DeliveryService, 'isFilesOnly' | 'qrPayloadsFor' | 'redeliver'>;
  readonly files: Pick<SubscriptionFileService, 'offered' | 'filesInMemory' | 'send'>;
  readonly commercial: Pick<CommercialActionService, 'availableFor'>;
  /** The sold plan's title, from the order the service was bought by. */
  readonly titleOf: (scope: TenantContext, orderId: string) => Promise<string | null>;
  readonly repository: Pick<
    ResellerWebRepository,
    'lockReseller' | 'countFileFetchesSince' | 'insertFileFetch'
  >;
  readonly audit: AuditWriter;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly clock: Clock;
  readonly ids: Pick<IdGenerator, 'uuid'>;
}

/** «رو به اتمام»: an ACTIVE service with ≤ 7 days or ≤ 10 % of a finite allowance left. */
export function isExpiring(service: ServiceRecord, now: Date): boolean {
  if (service.state !== 'ACTIVE') return false;
  if (service.expiresAt !== null) {
    const left = service.expiresAt.getTime() - now.getTime();
    if (left <= RESELLER_WEB_EXPIRING_DAYS * 86_400_000) return true;
  }
  if (service.trafficLimitBytes > 0n) {
    const remaining = service.trafficLimitBytes - service.trafficUsedBytes;
    if (
      remaining * 100n <=
      service.trafficLimitBytes * BigInt(RESELLER_WEB_EXPIRING_TRAFFIC_PERCENT)
    ) {
      return true;
    }
  }
  return false;
}

/** Which chips a service counts under (always `ALL`). */
export function filtersOf(service: ServiceRecord, now: Date): ResellerServiceFilter[] {
  const out: ResellerServiceFilter[] = ['ALL'];
  if (service.state === 'ACTIVE') out.push('ACTIVE');
  else if (service.state === 'EXPIRED') out.push('EXPIRED');
  else if (service.state === 'SUSPENDED') out.push('SUSPENDED');
  else out.push('OTHER');
  if (isExpiring(service, now)) out.push('EXPIRING');
  return out;
}

function matches(service: ServiceRecord, query: string): boolean {
  const q = query.toLowerCase();
  return (
    service.providerUsername.toLowerCase().includes(q) ||
    (service.customerNote ?? '').toLowerCase().includes(q) ||
    (service.code ?? '').toLowerCase().includes(q)
  );
}

/** The sing-box profile name the bot's sing-box QR carries: the import URL's fragment. */
export function profileNameOf(importUrl: string | undefined): string | null {
  if (importUrl === undefined) return null;
  const hash = importUrl.indexOf('#');
  if (hash < 0) return null;
  try {
    return decodeURIComponent(importUrl.slice(hash + 1)) || null;
  } catch (error) {
    if (error instanceof URIError) return null;
    throw error;
  }
}

const notFound = (): NexaError => errors.notFound(RESELLER_WEB_ERROR_CODES.NOT_FOUND, 'Not found.');

/**
 * PR-4 §5.2 «سرویس‌های من» and the «مدیریت» drawer, for one reseller's OWN services.
 *
 * Ownership is decided here, in the application layer, by `ProvisioningService.getForCustomer`
 * (tenant, customer, and listed) for every id the browser sends; another reseller's service —
 * or one that does not exist — is the one `reseller_web.not_found`. The connection block is the
 * bot's: the same link-and-QR decision (`isFilesOnly`, `qrPayloadsFor`), the same delivery card
 * (`redeliver`), the same rotation (`requestRotation`), and the files through
 * `SubscriptionFileService` — fetched on request, held in memory for one response, never stored.
 */
export class ResellerWebServicesService {
  constructor(private readonly deps: ResellerWebServicesDeps) {}

  async list(
    context: ResellerWebContext,
    query: { readonly filter: ResellerServiceFilter; readonly q?: string; readonly page: number },
  ): Promise<ResellerServicesResponse> {
    const now = this.deps.clock.now();
    const { items } = await this.deps.provisioning.listedForCustomer(
      context.scope,
      context.customer.id,
      RESELLER_WEB_SERVICES_CAP,
    );
    const searched =
      query.q === undefined || query.q.length === 0
        ? items
        : items.filter((service) => matches(service, query.q as string));
    const counts = Object.fromEntries(RESELLER_SERVICE_FILTERS.map((key) => [key, 0])) as Record<
      ResellerServiceFilter,
      number
    >;
    const chosen: ServiceRecord[] = [];
    for (const service of searched) {
      const filters = filtersOf(service, now);
      for (const key of filters) counts[key] += 1;
      if (filters.includes(query.filter)) chosen.push(service);
    }
    const size = RESELLER_WEB_SERVICES_PAGE_SIZE;
    const pages = Math.max(1, Math.ceil(chosen.length / size));
    const page = Math.min(query.page, pages - 1);
    const rows: ResellerServiceRow[] = [];
    for (const service of chosen.slice(page * size, page * size + size)) {
      rows.push(await this.row(context.scope, service, now));
    }
    return { items: rows, counts, page, pages, total: chosen.length };
  }

  /** The services the dashboard lists under «رو به اتمام», soonest first. */
  async expiring(
    context: ResellerWebContext,
    limit: number,
  ): Promise<{
    readonly count: number;
    readonly active: number;
    readonly rows: ResellerServiceRow[];
  }> {
    const now = this.deps.clock.now();
    const { items } = await this.deps.provisioning.listedForCustomer(
      context.scope,
      context.customer.id,
      RESELLER_WEB_SERVICES_CAP,
    );
    const expiring = items
      .filter((service) => isExpiring(service, now))
      .sort(
        (a, b) =>
          (a.expiresAt?.getTime() ?? Number.MAX_SAFE_INTEGER) -
          (b.expiresAt?.getTime() ?? Number.MAX_SAFE_INTEGER),
      );
    const rows: ResellerServiceRow[] = [];
    for (const service of expiring.slice(0, limit))
      rows.push(await this.row(context.scope, service, now));
    return {
      count: expiring.length,
      active: items.filter((service) => service.state === 'ACTIVE').length,
      rows,
    };
  }

  async detail(context: ResellerWebContext, serviceId: string): Promise<ResellerServiceDetail> {
    const service = await this.own(context, serviceId);
    const now = this.deps.clock.now();
    const working = await this.deps.provisioning.changeInProgress(context.scope, service);
    const offered = working
      ? []
      : await this.deps.commercial.availableFor(context.scope, context.actor, service);
    const deliverable = ProvisioningService.isDeliverable(service);
    const filesOnly = await this.deps.delivery.isFilesOnly(context.scope, service);
    const qr = deliverable ? await this.deps.delivery.qrPayloadsFor(context.scope, service) : [];
    const rotation = await this.deps.provisioning.customerRotationFor(context.scope, service);
    return {
      ...(await this.row(context.scope, service, now)),
      // R11 A4, as the bot and the mini app: on a files-only panel the link is not sent at all.
      subscriptionUrl: deliverable && !filesOnly ? service.subscriptionUrl : null,
      qrKinds: qr.map((payload) => payload.kind),
      singboxProfileName: profileNameOf(qr.find((payload) => payload.kind === 'SINGBOX')?.text),
      filesOnly,
      filesOffered: await this.deps.files.offered(context.scope, service),
      canRotateLink: rotation.offered,
      actions: PANEL_ACTIONS.filter((kind) => offered.includes(kind)),
      working,
    };
  }

  /** One QR's payload — the text the bot's photo encodes — for the surface's renderer. */
  async qrPayload(
    context: ResellerWebContext,
    serviceId: string,
    kind: QrPayloadKind,
  ): Promise<string> {
    const service = await this.own(context, serviceId);
    if (!ProvisioningService.isDeliverable(service)) throw notFound();
    const payload = (await this.deps.delivery.qrPayloadsFor(context.scope, service)).find(
      (one) => one.kind === kind,
    );
    if (payload === undefined) throw notFound();
    return payload.text;
  }

  async setNote(
    context: ResellerWebContext,
    serviceId: string,
    note: string | null,
  ): Promise<{ readonly note: string | null }> {
    await this.own(context, serviceId);
    const result = await this.deps.provisioning.setCustomerNote(
      context.scope,
      context.actor,
      context.customer.id,
      serviceId,
      note,
    );
    return { note: result.note };
  }

  /**
   * «ارسال لینک و QR به تلگرام من»: the bot's delivery card for this service, to the reseller's
   * OWN chat through the bot they signed in from — exactly the bot's «🔗 لینک اشتراک» without a
   * card. Files-only panels send the files instead, as the bot does.
   */
  async sendConnection(
    context: ResellerWebContext,
    serviceId: string,
  ): Promise<ResellerSendResult> {
    const service = await this.own(context, serviceId);
    if (await this.deps.delivery.isFilesOnly(context.scope, service)) {
      return this.sendFiles(context, serviceId);
    }
    try {
      await this.deps.delivery.redeliver(
        context.scope,
        service,
        context.customer.id,
        context.customer.telegramUserId,
        context.botInstanceId,
      );
    } catch (error) {
      if (error instanceof NexaError && error.kind === 'NOT_FOUND') throw notFound();
      if (error instanceof NexaError) {
        throw errors.conflict(
          RESELLER_WEB_ERROR_CODES.TELEGRAM_UNDELIVERED,
          'The bot could not deliver it.',
        );
      }
      throw error;
    }
    await this.deps.audit.record(context.scope, context.actor, {
      action: RESELLER_WEB_AUDIT_ACTIONS.CONNECTION_SENT,
      entityType: 'Service',
      entityId: service.id,
      before: null,
      after: { chat: 'OWN' },
      result: 'SUCCESS',
    });
    return { outcome: 'SENT', sent: 1 };
  }

  /** «لینک تازه»: the bot's rotation, only where the provider supports it. */
  async rotateLink(
    context: ResellerWebContext,
    serviceId: string,
    idempotencyKey: string,
  ): Promise<void> {
    const service = await this.own(context, serviceId);
    if (!(await this.deps.provisioning.customerRotationFor(context.scope, service)).offered) {
      throw errors.conflict(
        RESELLER_WEB_ERROR_CODES.ROTATE_UNAVAILABLE,
        'This service cannot get a fresh link.',
      );
    }
    await this.deps.provisioning.requestRotation(
      context.scope,
      context.actor,
      context.customer.id,
      serviceId,
      { idempotencyKey },
    );
  }

  // --- Connection files -----------------------------------------------------------------------

  /**
   * The files, fetched from the panel NOW, for one download response. The bound (10 per
   * service per 10 minutes per reseller) is counted BEFORE the panel is asked, and every fetch
   * is audited without its content (how many files, never a name or a byte).
   */
  async fetchFiles(
    context: ResellerWebContext,
    serviceId: string,
    purpose: 'LIST' | 'DOWNLOAD' | 'ZIP',
  ): Promise<readonly ProviderSubscriptionFile[]> {
    const service = await this.own(context, serviceId);
    await this.countFetch(context, service.id);
    const fetched = await this.deps.files.filesInMemory(context.scope, context.actor, {
      customerId: context.customer.id as UserId,
      serviceId: service.id,
    });
    await this.deps.audit.record(context.scope, context.actor, {
      action: RESELLER_WEB_AUDIT_ACTIONS.FILES_FETCHED,
      entityType: 'Service',
      entityId: service.id,
      before: null,
      after: {
        purpose,
        outcome: fetched.outcome,
        files: fetched.outcome === 'FILES' ? fetched.files.length : 0,
      },
      result: fetched.outcome === 'FILES' ? 'SUCCESS' : 'FAILED',
    });
    if (fetched.outcome === 'NOT_FOUND') throw notFound();
    if (fetched.outcome !== 'FILES') {
      throw errors.conflict(
        RESELLER_WEB_ERROR_CODES.FILES_UNAVAILABLE,
        'The connection files are not available.',
      );
    }
    return fetched.files;
  }

  /** «ارسال فایل‌ها به تلگرام من»: exactly the bot's button — `SubscriptionFileService.send`. */
  async sendFiles(context: ResellerWebContext, serviceId: string): Promise<ResellerSendResult> {
    const service = await this.own(context, serviceId);
    await this.countFetch(context, service.id);
    const result = await this.deps.files.send(context.scope, context.actor, {
      customerId: context.customer.id as UserId,
      serviceId: service.id,
      chatId: context.customer.telegramUserId,
      botInstanceId: context.botInstanceId,
    });
    await this.deps.audit.record(context.scope, context.actor, {
      action: RESELLER_WEB_AUDIT_ACTIONS.FILES_SENT,
      entityType: 'Service',
      entityId: service.id,
      before: null,
      after: { outcome: result.outcome, sent: 'sent' in result ? result.sent : 0 },
      result: result.outcome === 'SENT' ? 'SUCCESS' : 'FAILED',
    });
    if (result.outcome === 'NOT_FOUND') throw notFound();
    if (result.outcome === 'SENT') return { outcome: 'SENT', sent: result.sent };
    if (result.outcome === 'STOPPED') {
      throw errors.conflict(
        RESELLER_WEB_ERROR_CODES.TELEGRAM_UNDELIVERED,
        'The bot could not deliver the files.',
      );
    }
    throw errors.conflict(
      RESELLER_WEB_ERROR_CODES.FILES_UNAVAILABLE,
      'The connection files are not available.',
    );
  }

  // --- helpers ------------------------------------------------------------------------------

  /** The ownership rule, in one place: the reseller's own listed service, or not found. */
  async own(context: ResellerWebContext, serviceId: string): Promise<ServiceRecord> {
    try {
      return await this.deps.provisioning.getForCustomer(
        context.scope,
        context.customer.id,
        serviceId,
      );
    } catch (error) {
      if (
        error instanceof NexaError &&
        (error.kind === 'NOT_FOUND' || error.kind === 'VALIDATION')
      ) {
        throw notFound();
      }
      throw error;
    }
  }

  private async countFetch(context: ResellerWebContext, serviceId: string): Promise<void> {
    const tenant: TenantContext = { tenantId: context.scope.tenantId, botInstanceId: null };
    const allowed = await this.deps.uow.run(tenant, async (tx) => {
      // The reseller row serialises two fetches of the same reseller: the count is exact.
      await this.deps.repository.lockReseller(tenant, context.customer.id, tx);
      const now = this.deps.clock.now();
      const since = new Date(now.getTime() - RESELLER_WEB_FILE_FETCH_WINDOW_SECONDS * 1000);
      const used = await this.deps.repository.countFileFetchesSince(
        tenant,
        { customerId: context.customer.id, serviceId, since },
        tx,
      );
      if (used >= RESELLER_WEB_FILE_FETCHES_PER_WINDOW) return false;
      await this.deps.repository.insertFileFetch(
        tenant,
        { id: this.deps.ids.uuid(), customerId: context.customer.id, serviceId, now },
        tx,
      );
      return true;
    });
    if (!allowed) {
      throw new NexaError({
        kind: 'RATE_LIMITED',
        code: RESELLER_WEB_ERROR_CODES.RATE_LIMITED,
        message: 'Too many file requests for this service. Wait a few minutes.',
        details: { windowSeconds: RESELLER_WEB_FILE_FETCH_WINDOW_SECONDS },
      });
    }
  }

  private async row(
    scope: TenantContext,
    service: ServiceRecord,
    now: Date,
  ): Promise<ResellerServiceRow> {
    return {
      id: service.id,
      code: service.code,
      username: service.providerUsername,
      client: null,
      note: service.customerNote,
      product: await this.deps.titleOf(scope, service.orderId),
      location: service.locationLabel,
      state: service.state,
      trafficUsedBytes: service.trafficUsedBytes.toString(),
      trafficLimitBytes: service.trafficLimitBytes.toString(),
      expiresAt: service.expiresAt === null ? null : service.expiresAt.toISOString(),
      expiring: isExpiring(service, now),
      isTrial: service.isTrial,
    };
  }
}
