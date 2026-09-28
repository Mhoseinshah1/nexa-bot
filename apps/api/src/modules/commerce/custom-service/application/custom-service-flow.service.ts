import {
  customServiceVolumeBytes,
  parseCustomServiceDays,
  parseCustomServiceVolume,
  CUSTOM_SERVICE_MAX_VOLUME_UNITS,
  type ActorContext,
  type BotInstanceId,
  type PermissionKey,
  type TenantContext,
  type UserId,
} from '@nexa/contracts';
import type { PermissionGuard } from '../../../platform/access/application/permission-guard.js';
import type { CustomerCaptureService } from '../../customers/application/customer-capture.service.js';
import type { CustomerCaptureRecord } from '../../customers/application/customer-capture-ports.js';
import type { OrderService } from '../../orders/application/order.service.js';
import type { OrderRecord } from '../../orders/application/ports.js';
import type { CustomServicePricer, OfferedLocation } from './custom-service-pricer.js';
import type { OrderCustomServiceTerms, OrderCustomServiceTermsRepository } from './ports.js';

/**
 * What a customer-initiated custom-service step acts under: `maintenance.run`, exactly as
 * the catalogue and the order commands do — system work a customer triggered, checked
 * rather than skipped.
 */
export const CUSTOM_SERVICE_FLOW_PERMISSION: PermissionKey = 'maintenance.run';

export interface CustomServiceFlowDeps {
  readonly pricer: Pick<
    CustomServicePricer,
    'enabled' | 'offeredLocations' | 'offeredLocation' | 'volumePriceable'
  >;
  readonly captures: Pick<CustomerCaptureService, 'open'>;
  readonly orders: Pick<OrderService, 'createCustomDraft'>;
  readonly terms: Pick<OrderCustomServiceTermsRepository, 'findByOrder'>;
  readonly guard: PermissionGuard;
}

export type CustomServiceBeginResult =
  | { readonly outcome: 'ASK_VOLUME'; readonly location: OfferedLocation }
  | { readonly outcome: 'UNAVAILABLE' };

export type CustomServiceVolumeResult =
  | { readonly outcome: 'INVALID' }
  | { readonly outcome: 'UNAVAILABLE' }
  | { readonly outcome: 'ASK_DAYS'; readonly volumeBytes: bigint };

export type CustomServiceDaysResult =
  { readonly outcome: 'INVALID' } | { readonly outcome: 'DRAFTED'; readonly order: OrderRecord };

/**
 * The Telegram flow of a custom service (brief D5), from the location to the draft.
 *
 * Location, then volume, then days: each typed figure is read by a bounded capture window
 * that names the panel it is for, and the volume is carried ON the days window, so the
 * draft is made from what the customer typed and never from a callback. A figure that
 * cannot be read leaves its window open for another try; a figure no rule prices is
 * refused before the next question is asked. The draft itself — the authoritative price,
 * the snapshot, the close of the days window — is `OrderService.createCustomDraft`'s,
 * in one transaction.
 *
 * Every idempotency key below is derived from the capture that read the figure, so a
 * redelivered message re-reads the window it read the first time and gets the same next
 * window, or the same draft.
 */
export class CustomServiceFlowService {
  constructor(private readonly deps: CustomServiceFlowDeps) {}

  /** The locations to draw, or none — the catalogue button is drawn only when there are some. */
  async offeredLocations(
    scope: TenantContext,
    actor: ActorContext,
    customerId: UserId,
  ): Promise<readonly OfferedLocation[]> {
    await this.deps.guard.check(scope, actor, CUSTOM_SERVICE_FLOW_PERMISSION);
    return this.deps.pricer.offeredLocations(scope, customerId);
  }

  /** A location was tapped: re-decide it, then ask for the volume. */
  async begin(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly idempotencyKey: string;
      readonly botInstanceId: BotInstanceId;
      readonly customerId: UserId;
      readonly panelId: string;
    },
  ): Promise<CustomServiceBeginResult> {
    await this.deps.guard.check(scope, actor, CUSTOM_SERVICE_FLOW_PERMISSION);
    const location = await this.deps.pricer.offeredLocation(scope, input.customerId, input.panelId);
    if (location === null) return { outcome: 'UNAVAILABLE' };
    await this.deps.captures.open(scope, actor, {
      idempotencyKey: input.idempotencyKey,
      botInstanceId: input.botInstanceId,
      customerId: input.customerId,
      purpose: 'CUSTOM_SERVICE_VOLUME',
      subjectId: location.panelId,
    });
    return { outcome: 'ASK_VOLUME', location };
  }

  /**
   * The text a `CUSTOM_SERVICE_VOLUME` window just read. A figure that is not a positive
   * GB amount with at most two decimals, or is past the ceiling, is INVALID and the window
   * stays open; one no VOLUME rule prices for this customer on this location is
   * UNAVAILABLE, the window again left open for another figure.
   */
  async recordVolume(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly capture: CustomerCaptureRecord;
      readonly text: string;
      readonly botInstanceId: BotInstanceId;
    },
  ): Promise<CustomServiceVolumeResult> {
    const { capture } = input;
    if (capture.purpose !== 'CUSTOM_SERVICE_VOLUME' || capture.subjectId === null) {
      return { outcome: 'INVALID' };
    }
    const units = parseCustomServiceVolume(input.text);
    if (units === null || units <= 0n || units > CUSTOM_SERVICE_MAX_VOLUME_UNITS) {
      return { outcome: 'INVALID' };
    }
    if (!(await this.deps.pricer.enabled(scope))) return { outcome: 'UNAVAILABLE' };
    if (
      !(await this.deps.pricer.volumePriceable(scope, capture.customerId, capture.subjectId, units))
    ) {
      return { outcome: 'UNAVAILABLE' };
    }
    // Opening the days window supersedes this one: the volume is now its content.
    await this.deps.captures.open(scope, actor, {
      idempotencyKey: `custom-service-days:${capture.id}`,
      botInstanceId: input.botInstanceId,
      customerId: capture.customerId,
      purpose: 'CUSTOM_SERVICE_DAYS',
      subjectId: capture.subjectId,
      customVolumeUnits: units,
    });
    return { outcome: 'ASK_DAYS', volumeBytes: customServiceVolumeBytes(units) };
  }

  /**
   * The text a `CUSTOM_SERVICE_DAYS` window just read: a whole positive number of days,
   * then the draft. A refusal the draft raises (disabled, unavailable) propagates as the
   * error it is, for the surface's refusal table.
   */
  async recordDays(
    scope: TenantContext,
    actor: ActorContext,
    input: { readonly capture: CustomerCaptureRecord; readonly text: string },
  ): Promise<CustomServiceDaysResult> {
    const { capture } = input;
    if (
      capture.purpose !== 'CUSTOM_SERVICE_DAYS' ||
      capture.subjectId === null ||
      capture.customVolumeUnits === null
    ) {
      return { outcome: 'INVALID' };
    }
    const days = parseCustomServiceDays(input.text);
    if (days === null) return { outcome: 'INVALID' };
    const order = await this.deps.orders.createCustomDraft(scope, actor, {
      idempotencyKey: `custom-service-draft:${capture.id}`,
      customerId: capture.customerId,
      panelId: capture.subjectId,
      volumeUnits: capture.customVolumeUnits,
      durationDays: days,
      captureId: capture.id,
    });
    return { outcome: 'DRAFTED', order };
  }

  /** A custom order's frozen terms, for the pre-invoice. */
  async termsFor(scope: TenantContext, orderId: string): Promise<OrderCustomServiceTerms | null> {
    return this.deps.terms.findByOrder(scope, orderId);
  }
}
