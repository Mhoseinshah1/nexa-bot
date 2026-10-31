import {
  COMMERCE_ERROR_CODES,
  canFetchSubscriptionFiles,
  customerActionVerdict,
  isNexaError,
  isProviderType,
  providerDescriptor,
  type ActorContext,
  type BotInstanceId,
  type Clock,
  type PermissionKey,
  type ProviderAdapter,
  type ProviderType,
  type ServiceState,
  type ConnectionFileCaptionMode,
  type ConnectionFileCaptionPlacement,
  type TemplateValues,
  type TenantContext,
  type UnitOfWork,
  type UserId,
} from '@nexa/contracts';
import type { PermissionGuard } from '../../../platform/access/application/permission-guard.js';
import type {
  PanelCredentialStore,
  PanelRepository,
  ProbeBudget,
} from '../../../platform/panels/application/ports.js';
import { toProviderCredentials } from '../../../platform/panels/application/probe-core.js';
import type { PanelPolicyGate } from '../../../platform/panels/application/panel-policy.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { SafeHttpClient } from '../../../../infrastructure/net/safe-http.js';
import { panelClient } from '../../../platform/panels/application/panel-http.js';
import { checkUrl, type UrlPolicyOptions } from '../../../../infrastructure/net/url-policy.js';
import type {
  CustomerCaption,
  CustomerMessenger,
  CustomerSendResult,
} from '../../messaging/application/ports.js';
import type { CaptionMarkup, CaptionText } from '../../messaging/application/caption-markup.js';
import type { TemplatePresentation } from '../../../control/templates/application/ports.js';
import { planMediaBatches } from '../../messaging/application/media-group.js';
import { decideOperability } from './panel-operability.js';
import { providerRefFor } from './provision-executor.js';
import type { ServiceRecord } from './ports.js';
import type { ProvisioningService } from './provisioning.service.js';

/**
 * What a customer-initiated file request acts under: `maintenance.run`, as the other
 * customer-triggered service reads and requests do — system work a customer asked for,
 * checked rather than skipped.
 */
export const SUBSCRIPTION_FILES_PERMISSION: PermissionKey = 'maintenance.run';

/**
 * The states a service's files may be fetched in: the states its subscription link is
 * re-sent in (`isDeliverable`). A terminated or never-delivered account has no files.
 */
export const SUBSCRIPTION_FILE_STATES: readonly ServiceState[] = ['ACTIVE', 'SUSPENDED', 'EXPIRED'];

export interface SubscriptionFileDeps {
  readonly services: Pick<ProvisioningService, 'getForCustomer'>;
  readonly panels: Pick<PanelRepository, 'find' | 'takeProbeBudget'>;
  readonly credentials: Pick<PanelCredentialStore, 'read'>;
  readonly adapters: (type: ProviderType) => ProviderAdapter;
  readonly implementedProviderTypes: readonly ProviderType[];
  readonly http: Pick<SafeHttpClient, 'forBase'>;
  readonly urlPolicy: UrlPolicyOptions;
  readonly probeBudget: ProbeBudget;
  readonly messenger: Pick<CustomerMessenger, 'sendFile' | 'sendMediaGroup'>;
  readonly guard: PermissionGuard;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly clock: Clock;
  /**
   * The panel's operator policy (WP-A8): an operator may withdraw this button on one
   * panel. Asked after the adapter check, so it can refuse and never grant.
   */
  readonly panelPolicy: PanelPolicyGate;
  /**
   * UX Batch 01 item 4: the facts a tenant's caption template may name that the service row
   * does not hold — what was bought, where it is, and its state as the card words it. Absent
   * in a composition that has none; every such fact is then simply absent from the caption.
   */
  readonly captionFacts?: FileCaptionFactSource;
  /**
   * Track 3 §2: the panel's connection-file caption settings and what a CUSTOM caption is
   * rendered with. Absent in a composition that has none, which then captions as before
   * Track 3 (`LEGACY_CAPTION_POLICY`): the panel's own caption, on every file.
   */
  readonly connectionCaptions?: ConnectionFileCaptionSource;
  /**
   * The caption grammar and the connection-file caption renderer (`@nexa/i18n`, behind a
   * port: an application file does not import the catalogue package). Bound in
   * `container.ts` to `I18N_CAPTION_TEXT`.
   */
  readonly captionText: CaptionText;
}

/** Track 3 §2: one panel's caption settings, as its PANEL-scoped keys resolve. */
export interface ConnectionFileCaptionPolicy {
  readonly mode: ConnectionFileCaptionMode;
  /** The panel's own template; null means the default key's resolved body. */
  readonly template: string | null;
  readonly placement: ConnectionFileCaptionPlacement;
}

export interface ConnectionFileCaptionSource {
  policyFor(scope: TenantContext, panelId: string): Promise<ConnectionFileCaptionPolicy>;
  /** The RAW body of `bot.service.connection_files_caption`: the tenant's, or the catalogue's. */
  defaultTemplate(scope: TenantContext): Promise<string>;
  presentationFor(scope: TenantContext): Promise<TemplatePresentation>;
  /** The tenant's first support account, without its `@`; null when none is configured. */
  supportHandle(scope: TenantContext): Promise<string | null>;
}

/** What a composition with no caption settings does: the behaviour before Track 3. */
export const LEGACY_CAPTION_POLICY: ConnectionFileCaptionPolicy = {
  mode: 'PANEL_DEFAULT',
  template: null,
  placement: 'EVERY_FILE',
};

/** The caption facts that live outside the service row. Each null when there is none. */
export interface FileCaptionExtras {
  readonly serviceName: string | null;
  readonly location: string | null;
  readonly status: string | null;
  /** Track 3 §2: the catalogue product's current name, for `{product}`. */
  readonly product?: string | null;
}

export interface FileCaptionFactSource {
  factsFor(scope: TenantContext, service: ServiceRecord): Promise<FileCaptionExtras>;
}

/**
 * How one request ended, for the one answer the customer is given.
 *
 * `SENT` means at least one file reached the chat; `failed` counts the formats the panel
 * could not build or this installation refused. `STOPPED` is Telegram declining a send
 * part-way: nothing more is sent and nothing is retried.
 */
export type SubscriptionFilesResult =
  | { readonly outcome: 'SENT'; readonly sent: number; readonly failed: number }
  | { readonly outcome: 'STOPPED'; readonly sent: number }
  | { readonly outcome: 'RATE_LIMITED'; readonly retryAfterSeconds: number }
  | { readonly outcome: 'UNAVAILABLE' }
  | { readonly outcome: 'NOT_FOUND' };

/**
 * A panel's ready-made connection files, fetched for their owner and sent to them
 * (Package E, `docs/package-e-rickpanel-files-audit.md`).
 *
 * The bytes are credentials. They exist in memory between the panel's answer and
 * Telegram's, inside `send`, and nowhere else: not in a row, an audit entry, an event, a
 * log line or an error. That is why this one service both fetches and sends — a caller
 * receives a count, never a file.
 */
export class SubscriptionFileService {
  constructor(private readonly deps: SubscriptionFileDeps) {}

  /**
   * Whether the files button may be drawn for this service: a readable state and a
   * panel whose adapter can fetch files. A courtesy — `send` decides again.
   */
  async offered(scope: TenantContext, service: ServiceRecord): Promise<boolean> {
    if (!SUBSCRIPTION_FILE_STATES.includes(service.state)) return false;
    const view = await this.deps.panels.find(scope, service.panelId);
    if (view === null || !isProviderType(view.panel.providerType)) return false;
    if (!this.deps.implementedProviderTypes.includes(view.panel.providerType)) return false;
    // The descriptor alone cannot say the method exists; the adapter can say both.
    if (
      providerDescriptor(view.panel.providerType) === null ||
      !canFetchSubscriptionFiles(this.deps.adapters(view.panel.providerType))
    ) {
      return false;
    }
    return customerActionVerdict(
      await this.deps.panelPolicy.forPanel(scope, service.panelId),
      'SUBSCRIPTION_FILES',
    ).allowed;
  }

  /**
   * Fetches the files of one of the customer's own services and sends each to `chatId`.
   *
   * Ownership is decided again here, by `getForCustomer` (tenant, customer, and not
   * refunded, in the query), whatever the caller already checked. Every refusal before
   * the panel is asked — unknown, someone else's, not readable, a panel that cannot be
   * read — is one of two answers, so the button is not an oracle.
   */
  async send(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly customerId: UserId;
      readonly serviceId: string;
      readonly chatId: string;
      readonly botInstanceId: BotInstanceId;
    },
  ): Promise<SubscriptionFilesResult> {
    await this.deps.guard.check(scope, actor, SUBSCRIPTION_FILES_PERMISSION);

    let service: ServiceRecord;
    try {
      service = await this.deps.services.getForCustomer(scope, input.customerId, input.serviceId);
    } catch (error) {
      // Only the not-found answer is translated. A database that could not be read is an
      // outage, not "no such service": it propagates, so the update fails where it can be
      // seen rather than telling the owner their service does not exist.
      if (isNexaError(error) && error.code === COMMERCE_ERROR_CODES.SERVICE_NOT_FOUND) {
        return { outcome: 'NOT_FOUND' };
      }
      throw error;
    }
    return this.fetchAndSend(scope, service, input.chatId, input.botInstanceId);
  }

  /**
   * R3 item 6: every available file, sent right after the automatic delivery of a
   * service's link — a new purchase, a trial, or a link change. Called by
   * `DeliveryService`'s sweep ONLY after the link message was recorded DELIVERED, for
   * any purchase kind, because the delivery lane does not know or care what bought the
   * service.
   *
   * The sweep's own service row, not a customer's tap, so there is no ownership to
   * decide: the service is the one just announced, to the chat it was announced to. The
   * permission is still charged — background work does not skip the guard — and every
   * other rule of `send` holds unchanged: the state, the panel's operability and URL
   * policy, the adapter's capability, the operator's per-panel switch, the probe budget.
   *
   * What it returns is for the caller's log and a test. Nothing here may change the
   * service or its delivery record: a file that did not arrive is not a failed
   * provisioning, and the customer still has «📁 دریافت فایل‌های اتصال».
   */
  async sendAfterDelivery(
    scope: TenantContext,
    actor: ActorContext,
    service: ServiceRecord,
    input: { readonly chatId: string; readonly botInstanceId: BotInstanceId },
  ): Promise<SubscriptionFilesResult> {
    await this.deps.guard.check(scope, actor, SUBSCRIPTION_FILES_PERMISSION);
    return this.fetchAndSend(scope, service, input.chatId, input.botInstanceId);
  }

  /** The shared half of `send` and `sendAfterDelivery`: decide, read, send. */
  private async fetchAndSend(
    scope: TenantContext,
    service: ServiceRecord,
    chatId: string,
    botInstanceId: BotInstanceId,
  ): Promise<SubscriptionFilesResult> {
    if (!SUBSCRIPTION_FILE_STATES.includes(service.state)) return { outcome: 'UNAVAILABLE' };

    const view = await this.deps.panels.find(scope, service.panelId);
    const operable = decideOperability({
      panel:
        view === null
          ? null
          : {
              status: view.panel.status,
              providerType: view.panel.providerType,
              baseUrl: view.panel.baseUrl,
              archivedAt: view.panel.archivedAt,
              activation: view.panel.activation,
            },
      credentials: view?.credentials ?? null,
      // A read of the account, like a reconcile: no capability beyond the adapter's own.
      type: 'RECONCILE',
      serviceAdapterExists:
        view !== null && this.deps.implementedProviderTypes.includes(view.panel.providerType),
    });
    if (!operable.ok) return { outcome: 'UNAVAILABLE' };
    if (!checkUrl(operable.baseUrl, this.deps.urlPolicy).allowed) {
      return { outcome: 'UNAVAILABLE' };
    }
    const adapter = this.deps.adapters(operable.providerType as ProviderType);
    if (!canFetchSubscriptionFiles(adapter)) return { outcome: 'UNAVAILABLE' };
    // WP-A8: decided again on the tap, before the panel is asked for anything.
    if (
      !customerActionVerdict(
        await this.deps.panelPolicy.forPanel(scope, service.panelId),
        'SUBSCRIPTION_FILES',
      ).allowed
    ) {
      return { outcome: 'UNAVAILABLE' };
    }
    const stored = await this.deps.credentials.read(scope, service.panelId);
    const credentials = toProviderCredentials(stored, adapter.descriptor.credentialShape);
    if (credentials === null) return { outcome: 'UNAVAILABLE' };

    // The tenant's outbound panel budget, as every panel read spends it. An empty
    // bucket asks nothing of the panel.
    const now = this.deps.clock.now();
    const budget = await this.deps.uow.run(scope, async (tx) =>
      this.deps.panels.takeProbeBudget(scope, this.deps.probeBudget, now, tx, 0),
    );
    if (!budget.permitted) return { outcome: 'UNAVAILABLE' };

    const fetched = await adapter.fetchSubscriptionFiles(
      { baseUrl: operable.baseUrl, credentials, activation: operable.activation },
      panelClient(this.deps.http, operable),
      providerRefFor(service),
    );
    if (!fetched.ok) {
      if (fetched.failure === 'RATE_LIMITED') {
        const waitMs = fetched.retryAfterMs ?? 60_000;
        return {
          outcome: 'RATE_LIMITED',
          retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)),
        };
      }
      return { outcome: 'UNAVAILABLE' };
    }
    if (!fetched.found || fetched.files.length === 0) return { outcome: 'UNAVAILABLE' };

    /*
     * Round N (F2): the files as ALBUMS, in the panel's order, each with the panel's own
     * caption. `planMediaBatches` cuts the list into the fewest consecutive albums Telegram
     * accepts (every file here is a document, so one album class; at most 10 per album); a
     * batch of one — the only thing that cannot be an album — goes by `sendFile`, in its
     * place. The first batch Telegram does not certainly accept stops the delivery: nothing
     * after it is sent and nothing is retried, exactly as the one-by-one loop did.
     */
    const files = fetched.files;
    /*
     * R11 A4: the captions' link variables ({sub_link}, {subscription_url}) read a service's
     * `subscriptionUrl`. On a «فقط فایل، بدون لینک ساب» panel the caption is built from a
     * service WITHOUT it, so a template that names the link renders that line absent — the
     * renderer drops a line made only of absent facts — and a caption can never carry it.
     */
    const captionService: ServiceRecord =
      view?.panel.filesOnlyDelivery === true ? { ...service, subscriptionUrl: null } : service;
    const captionFor = await this.captionPlan(scope, captionService, files);
    const kinds = files.map(() => 'DOCUMENT' as const);
    let sent = 0;
    for (const batch of planMediaBatches(kinds)) {
      const items = batch.map((index) => {
        const file = files[index] as (typeof files)[number];
        return {
          kind: 'DOCUMENT' as const,
          source: {
            kind: 'BYTES' as const,
            bytes: file.bytes,
            fileName: file.fileName,
            mimeType: file.mediaType,
          },
          ...captionFor(index, file),
        };
      });
      const sendMediaGroup = this.deps.messenger.sendMediaGroup;
      const first = items[0];
      let result: CustomerSendResult;
      if (items.length > 1 && sendMediaGroup !== undefined) {
        result = await sendMediaGroup.call(this.deps.messenger, scope, {
          chatId,
          botInstanceId,
          items,
        });
      } else if (items.length === 1 && first !== undefined) {
        result = await this.deps.messenger.sendFile(scope, { chatId, botInstanceId, ...first });
      } else {
        // A stand-in with no album method: the same files, one by one, in the same order.
        result = { outcome: 'DELIVERED' };
        for (const item of items) {
          result = await this.deps.messenger.sendFile(scope, { chatId, botInstanceId, ...item });
          if (result.outcome !== 'DELIVERED') break;
          sent += 1;
        }
        if (result.outcome !== 'DELIVERED') return { outcome: 'STOPPED', sent };
        continue;
      }
      // Telegram declining, or answering nobody knows what: stop, and retry nothing.
      if (result.outcome !== 'DELIVERED') return { outcome: 'STOPPED', sent };
      sent += items.length;
    }
    return { outcome: 'SENT', sent, failed: fetched.failed };
  }

  /**
   * Track 3 §2: which file carries which caption, decided once per delivery from the
   * panel's caption settings. `NONE` captions nothing; `PANEL_DEFAULT` is the panel's own
   * caption per file, as before; `CUSTOM` renders the panel's template (or the default
   * key's body) with `renderConnectionFileCaption` — HTML-escaped values, the closed
   * caption grammar, Telegram's bound — and a render that is empty sends the file bare.
   * `LAST_FILE` puts it on the last file of the delivery only.
   */
  private async captionPlan(
    scope: TenantContext,
    service: ServiceRecord,
    files: readonly { readonly fileName: string; readonly caption: string | null }[],
  ): Promise<
    (
      index: number,
      file: { readonly fileName: string; readonly caption: string | null },
    ) => { caption?: CustomerCaption }
  > {
    const source = this.deps.connectionCaptions;
    const policy =
      source === undefined ? LEGACY_CAPTION_POLICY : await source.policyFor(scope, service.panelId);
    if (policy.mode === 'NONE') return () => ({});
    const last = files.length - 1;
    const captioned = (index: number) => policy.placement === 'EVERY_FILE' || index === last;
    const extras = (await this.deps.captionFacts?.factsFor(scope, service)) ?? NO_CAPTION_EXTRAS;

    if (policy.mode === 'PANEL_DEFAULT' || source === undefined) {
      const facts = fileCaptionValues(service, extras);
      return (index, file) =>
        captioned(index)
          ? {
              caption: connectionFileCaption(
                file.caption === null ? null : this.deps.captionText.parse(file.caption),
                service.providerUsername,
                facts,
              ),
            }
          : {};
    }

    const [body, presentation, support] = await Promise.all([
      policy.template === null ? source.defaultTemplate(scope) : Promise.resolve(policy.template),
      source.presentationFor(scope),
      source.supportHandle(scope),
    ]);
    const now = this.deps.clock.now();
    return (index, file) => {
      if (!captioned(index)) return {};
      const values = connectionFileCaptionVariables(service, extras, file, {
        now,
        presentation,
        support,
        jalaliDate: (date, timezone) => this.deps.captionText.jalaliDate(date, timezone),
      });
      const rendered = this.deps.captionText.renderConnectionFileCaption(
        body,
        values,
        presentation,
      );
      if (rendered.text.length === 0) return {};
      return {
        caption: {
          templateKey: 'bot.service.connection_files_caption',
          values: {},
          rendered: { text: rendered.text, entities: rendered.entities },
        },
      };
    };
  }
}

const DAY_MS = 86_400_000;

/**
 * Track 3 §2: the values of `CONNECTION_FILE_CAPTION_VARIABLES` this service and this file
 * have — and nothing else. A fact the service does not have is ABSENT (its line is
 * dropped), never a placeholder string. The expiry is a Jalali DATE in the tenant's zone,
 * whatever calendar the tenant otherwise reads; days left are whole days, rounded up and
 * never below zero. `platform` is the file's own name without its extension. Nothing here
 * reads a panel-side client id, sub id or user id.
 */
export function connectionFileCaptionVariables(
  service: Pick<
    ServiceRecord,
    | 'providerUsername'
    | 'trafficLimitBytes'
    | 'trafficUsedBytes'
    | 'usageSyncedAt'
    | 'expiresAt'
    | 'subscriptionUrl'
  >,
  extras: FileCaptionExtras,
  file: { readonly fileName: string },
  context: {
    readonly now: Date;
    readonly presentation: TemplatePresentation;
    readonly support: string | null;
    /** `CaptionText.jalaliDate`: the date in the Jalali calendar and the given zone. */
    readonly jalaliDate: (date: Date, timezone: string) => string;
  },
): TemplateValues {
  const values: Record<string, TemplateValues[string]> = {};
  const text = (token: string, value: string | null | undefined) => {
    if (value !== null && value !== undefined && value.trim() !== '') values[token] = value;
  };
  text('username', service.providerUsername);
  text('service_name', extras.serviceName);
  text('product', extras.product);
  values['volume_total'] = service.trafficLimitBytes;
  if (service.usageSyncedAt !== null) {
    values['volume_used'] = service.trafficUsedBytes;
    if (service.trafficLimitBytes > 0n) {
      const left = service.trafficLimitBytes - service.trafficUsedBytes;
      values['volume_left'] = left > 0n ? left : 0n;
    }
  }
  if (service.expiresAt !== null) {
    values['expires_at_jalali'] = context.jalaliDate(
      service.expiresAt,
      context.presentation.timezone,
    );
    const remaining = service.expiresAt.getTime() - context.now.getTime();
    values['days_left'] = Math.max(0, Math.ceil(remaining / DAY_MS));
  }
  const dot = file.fileName.lastIndexOf('.');
  text('platform', dot > 0 ? file.fileName.slice(0, dot) : file.fileName);
  text('file_name', file.fileName);
  text('sub_link', service.subscriptionUrl);
  if (context.support !== null && context.support.trim() !== '') {
    values['support'] = `@${context.support.replace(/^@/, '')}`;
  }
  return values;
}

const NO_CAPTION_EXTRAS: FileCaptionExtras = { serviceName: null, location: null, status: null };

/**
 * UX Batch 01 item 4: the values of `FILE_CAPTION_PLACEHOLDERS` this service has — and
 * nothing else. A fact the service does not have is ABSENT, never a placeholder string, so
 * the renderer drops a line made only of absent facts (the defined fallback). Usage is a
 * fact only once it has been read from the panel; what is left only of a limited
 * allowance whose usage is known, never below zero. Nothing here reads the panel-side
 * client id, sub id or user id: they are credentials, and no placeholder could carry them.
 */
export function fileCaptionValues(
  service: Pick<
    ServiceRecord,
    | 'providerUsername'
    | 'trafficLimitBytes'
    | 'trafficUsedBytes'
    | 'usageSyncedAt'
    | 'expiresAt'
    | 'subscriptionUrl'
  >,
  extras: FileCaptionExtras,
): TemplateValues {
  const values: Record<string, TemplateValues[string]> = {};
  const text = (token: string, value: string | null) => {
    if (value !== null && value.trim() !== '') values[token] = value;
  };
  text('username', service.providerUsername);
  text('service_name', extras.serviceName);
  text('location', extras.location);
  text('status', extras.status);
  text('subscription_url', service.subscriptionUrl);
  values['total_volume'] = service.trafficLimitBytes;
  if (service.usageSyncedAt !== null) {
    values['used_volume'] = service.trafficUsedBytes;
    if (service.trafficLimitBytes > 0n) {
      const left = service.trafficLimitBytes - service.trafficUsedBytes;
      values['remaining_volume'] = left > 0n ? left : 0n;
    }
  }
  if (service.expiresAt !== null) values['expiry'] = service.expiresAt;
  return values;
}

/**
 * Round N (F2), extended by UX Batch 01 item 4: one connection file's caption.
 *
 * `bot.service.file_caption` carries the PANEL's caption (`{caption}`, the default body and
 * the source of truth until a tenant says otherwise) and the service's own facts, for a
 * tenant that rewrote the template to name them. The panel's markup arrives ALREADY read by
 * the closed caption grammar (`CaptionText.parse`) into text and entities, so `<code>` shows
 * as code and never as a raw tag, and nothing the panel wrote is parsed by Telegram as HTML.
 *
 * When that renders to nothing — the panel gave no caption and the default body names only
 * `{caption}`, or a tenant's body named only facts this service lacks — the file carries
 * `bot.service.connection_file_caption`, the service's username (the identifying line R3
 * introduced), rather than going bare.
 */
export function connectionFileCaption(
  markup: CaptionMarkup | null,
  serviceUsername: string,
  facts: TemplateValues = {},
): CustomerCaption {
  const caption = markup === null || markup.text.length === 0 ? null : markup;
  return {
    templateKey: 'bot.service.file_caption',
    values: { ...facts, ...(caption === null ? {} : { caption: caption.text }) },
    ...(caption === null || caption.entities.length === 0
      ? {}
      : { markup: { token: 'caption', entities: caption.entities } }),
    fallback: {
      templateKey: 'bot.service.connection_file_caption',
      values: { serviceUsername },
    },
  };
}
