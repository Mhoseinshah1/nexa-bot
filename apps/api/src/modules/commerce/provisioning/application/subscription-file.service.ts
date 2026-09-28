import {
  COMMERCE_ERROR_CODES,
  canFetchSubscriptionFiles,
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
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { SafeHttpClient } from '../../../../infrastructure/net/safe-http.js';
import { checkUrl, type UrlPolicyOptions } from '../../../../infrastructure/net/url-policy.js';
import type { CustomerMessenger } from '../../messaging/application/ports.js';
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
  readonly messenger: Pick<CustomerMessenger, 'sendFile'>;
  readonly guard: PermissionGuard;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly clock: Clock;
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
    return (
      providerDescriptor(view.panel.providerType) !== null &&
      canFetchSubscriptionFiles(this.deps.adapters(view.panel.providerType))
    );
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
      this.deps.http.forBase(operable.baseUrl),
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

    let sent = 0;
    for (const file of fetched.files) {
      const result = await this.deps.messenger.sendFile(scope, {
        chatId: input.chatId,
        botInstanceId: input.botInstanceId,
        kind: 'DOCUMENT',
        source: {
          kind: 'BYTES',
          bytes: file.bytes,
          fileName: file.fileName,
          mimeType: file.mediaType,
        },
        ...(file.caption === null
          ? {}
          : {
              caption: {
                templateKey: 'bot.service.file_caption' as const,
                values: { caption: file.caption },
              },
            }),
      });
      // Telegram declining, or answering nobody knows what: stop, and retry nothing.
      if (result.outcome !== 'DELIVERED') return { outcome: 'STOPPED', sent };
      sent += 1;
    }
    return { outcome: 'SENT', sent, failed: fetched.failed };
  }
}
