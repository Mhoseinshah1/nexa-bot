import {
  PAYMENT_GATEWAY_PROVIDERS,
  type ActorContext,
  type IncidentEffectKind,
  type IncidentTarget,
  type PanelId,
  type ProductId,
  type ServiceLocationId,
  type TenantContext,
} from '@nexa/contracts';
import type { EffectStatus, IncidentEffectPort } from '../application/ports.js';

/**
 * The narrow reads and the EXISTING write paths the effects go through. Each write is the
 * owning service's own method, called as the operator: its permission, its audit row, its
 * idempotency and its locks — the incident adds none of its own to another module's table.
 */
export interface IncidentEffectModules {
  readonly panels: {
    drainOf(
      scope: TenantContext,
      panelId: string,
    ): Promise<{ readonly reason: string } | null | undefined>;
    setDrain(
      scope: TenantContext,
      actor: ActorContext,
      panelId: string,
      input: {
        readonly idempotencyKey: string;
        readonly draining: boolean;
        readonly reason: string;
      },
    ): Promise<unknown>;
  };
  readonly locations: {
    find(
      scope: TenantContext,
      id: ServiceLocationId,
    ): Promise<{ readonly enabled: boolean; readonly panelId: PanelId } | null>;
    setEnabled(
      scope: TenantContext,
      actor: ActorContext,
      input: {
        readonly idempotencyKey: string;
        readonly locationId: string;
        readonly enabled: boolean;
      },
    ): Promise<unknown>;
  };
  readonly products: {
    statusOf(scope: TenantContext, id: ProductId): Promise<'ACTIVE' | 'INACTIVE' | null>;
    activate(
      scope: TenantContext,
      actor: ActorContext,
      input: { readonly idempotencyKey: string; readonly productId: string },
    ): Promise<unknown>;
    deactivate(
      scope: TenantContext,
      actor: ActorContext,
      input: { readonly idempotencyKey: string; readonly productId: string },
    ): Promise<unknown>;
  };
  readonly gateways: {
    statusOf(scope: TenantContext, provider: string): Promise<'ACTIVE' | 'DISABLED' | null>;
    setStatus(
      scope: TenantContext,
      actor: ActorContext,
      input: {
        readonly idempotencyKey: string;
        readonly provider: string;
        readonly status: 'ACTIVE' | 'DISABLED';
      },
    ): Promise<unknown>;
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** One target → one effect on one subject. Nothing beyond the target is ever named. */
export class ModuleIncidentEffects implements IncidentEffectPort {
  constructor(private readonly modules: IncidentEffectModules) {}

  async resolve(
    scope: TenantContext,
    target: IncidentTarget,
  ): Promise<{ readonly kind: IncidentEffectKind; readonly subjectRef: string } | null> {
    switch (target.kind) {
      case 'PANEL': {
        if (!UUID.test(target.ref)) return null;
        const drain = await this.modules.panels.drainOf(scope, target.ref);
        return drain === undefined ? null : { kind: 'PANEL_DRAIN', subjectRef: target.ref };
      }
      case 'LOCATION': {
        if (!UUID.test(target.ref)) return null;
        const location = await this.modules.locations.find(scope, target.ref as ServiceLocationId);
        return location === null ? null : { kind: 'LOCATION_DISABLE', subjectRef: target.ref };
      }
      case 'PRODUCT': {
        if (!UUID.test(target.ref)) return null;
        const status = await this.modules.products.statusOf(scope, target.ref as ProductId);
        return status === null ? null : { kind: 'PRODUCT_DEACTIVATE', subjectRef: target.ref };
      }
      case 'GATEWAY': {
        if (!(PAYMENT_GATEWAY_PROVIDERS as readonly string[]).includes(target.ref)) return null;
        const status = await this.modules.gateways.statusOf(scope, target.ref);
        return status === null ? null : { kind: 'GATEWAY_DISABLE', subjectRef: target.ref };
      }
    }
  }

  /** For a LOCATION target, the panel it lives on — what a notice's audience reads. */
  async panelOfLocation(scope: TenantContext, locationId: string): Promise<string | null> {
    if (!UUID.test(locationId)) return null;
    return (
      (await this.modules.locations.find(scope, locationId as ServiceLocationId))?.panelId ?? null
    );
  }

  async status(
    scope: TenantContext,
    kind: IncidentEffectKind,
    subjectRef: string,
  ): Promise<EffectStatus | null> {
    switch (kind) {
      case 'PANEL_DRAIN': {
        const drain = await this.modules.panels.drainOf(scope, subjectRef);
        if (drain === undefined) return null;
        return { inForce: drain !== null, marker: drain?.reason ?? null };
      }
      case 'LOCATION_DISABLE': {
        const location = await this.modules.locations.find(scope, subjectRef as ServiceLocationId);
        return location === null ? null : { inForce: !location.enabled, marker: null };
      }
      case 'PRODUCT_DEACTIVATE': {
        const status = await this.modules.products.statusOf(scope, subjectRef as ProductId);
        return status === null ? null : { inForce: status === 'INACTIVE', marker: null };
      }
      case 'GATEWAY_DISABLE': {
        const status = await this.modules.gateways.statusOf(scope, subjectRef);
        return status === null ? null : { inForce: status === 'DISABLED', marker: null };
      }
    }
  }

  async set(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly kind: IncidentEffectKind;
      readonly subjectRef: string;
      readonly inForce: boolean;
      readonly idempotencyKey: string;
      readonly marker: string;
    },
  ): Promise<void> {
    switch (input.kind) {
      case 'PANEL_DRAIN':
        await this.modules.panels.setDrain(scope, actor, input.subjectRef, {
          idempotencyKey: input.idempotencyKey,
          draining: input.inForce,
          // The marker IS the reason: it is what lets the revert tell this drain apart.
          reason: input.marker,
        });
        return;
      case 'LOCATION_DISABLE':
        await this.modules.locations.setEnabled(scope, actor, {
          idempotencyKey: input.idempotencyKey,
          locationId: input.subjectRef,
          enabled: !input.inForce,
        });
        return;
      case 'PRODUCT_DEACTIVATE':
        if (input.inForce) {
          await this.modules.products.deactivate(scope, actor, {
            idempotencyKey: input.idempotencyKey,
            productId: input.subjectRef,
          });
        } else {
          await this.modules.products.activate(scope, actor, {
            idempotencyKey: input.idempotencyKey,
            productId: input.subjectRef,
          });
        }
        return;
      case 'GATEWAY_DISABLE':
        await this.modules.gateways.setStatus(scope, actor, {
          idempotencyKey: input.idempotencyKey,
          provider: input.subjectRef,
          status: input.inForce ? 'DISABLED' : 'ACTIVE',
        });
        return;
    }
  }
}
