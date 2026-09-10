import { z } from 'zod';
import type { OperationId } from './operation.js';
import type { OrderId, PanelId, ServiceId, TenantId } from './ids.js';
import type { ProviderType } from './provider.js';

/**
 * WHAT an operational event is about, as a typed shape rather than a convention.
 *
 * ## The gap this closes
 *
 * `operational_events.context` is a `jsonb` bag. Panel and provider identity
 * travel through it by convention — today every caller writes `panelId`, and
 * nothing stops the next one writing `panel_id`. Two spellings of one fact in a
 * table an operator filters on is the legacy system's "one identity rendered four
 * different ways" (`CON-WEB-008`), arriving the same way it did there: through a
 * field nobody declared.
 *
 * This declares the keys. It deliberately does NOT replace `context`: an event
 * still carries whatever else it needs. What it fixes is that the SUBJECT — the
 * small set of things an operator searches by — has one spelling.
 *
 * ## Two things it is honest about
 *
 * **Nothing renders this yet.** The Telegram projector queues exactly five values
 * and the Persian template renders only those, so a field added here would be
 * invisible in the report group. Declaring the shape is still worth doing — it is
 * what stops the second spelling appearing — but this is not "operators can now
 * see the panel id", and pretending otherwise would be a claim with no mechanism.
 *
 * **No customer entity exists.** Telegram numeric id, `@username` and display name
 * are all named by item K and all three are omitted here: there is no customer
 * table, no producer, and `CLAUDE.md` forbids inventing the entity. `OrderId` and
 * `ServiceId` are different — both are already branded in `ids.ts`, so declaring
 * optional fields of those types invents nothing and gives Phase 4 somewhere to
 * put them.
 *
 * ## Why the values are searchable Latin
 *
 * Already true by mechanism, not by rule: codes render inside `<code>`, and no
 * Persian-digit conversion exists anywhere in the repository, so Latin values
 * survive verbatim into the report group. Stated here because the requirement is
 * easy to break later by adding a digit formatter to a projector.
 */
export interface OperationalSubject {
  /** The tenant the event belongs to. Always present; events are scoped. */
  readonly tenantId: TenantId;
  /** The panel, when the event is about one. */
  readonly panelId?: PanelId;
  /**
   * The provider TYPE, never a provider-side identifier.
   *
   * A provider type is code rather than a row (ADR-0023), so it is safe in a log.
   * A provider-side username is not: it is an identifier on somebody else's
   * system and belongs in a note on that system, not in this installation's
   * searchable event stream.
   */
  readonly providerType?: ProviderType;
  /** The commercial operation, once orders exist. */
  readonly orderId?: OrderId;
  /** The customer-facing service, once services exist. */
  readonly serviceId?: ServiceId;
  /**
   * The logical external mutation — the one identifier that survives a retry.
   *
   * This is the field that makes an event joinable to an audit row and to a
   * provider-side note. See `OperationId`: `correlationId` is already on the event
   * and changes on every attempt, which is right for a trace and wrong for this.
   */
  readonly operationId?: OperationId;
}

/**
 * The declared subject keys, so a boundary check can refuse a second spelling.
 *
 * Listed rather than derived from the interface, because a TypeScript interface
 * does not exist at runtime and the check that needs this runs over source.
 */
export const OPERATIONAL_SUBJECT_KEYS = [
  'tenantId',
  'panelId',
  'providerType',
  'orderId',
  'serviceId',
  'operationId',
] as const;

/**
 * Spellings that are NOT allowed for a declared subject key.
 *
 * Each is a real alternative somebody would reasonably write, and each would
 * split one searchable fact into two. A boundary check greps for them.
 */
export const FORBIDDEN_SUBJECT_SPELLINGS = [
  'panel_id',
  'tenant_id',
  'order_id',
  'service_id',
  'operation_id',
  'provider_type',
] as const;

export const operationalSubjectSchema = z
  .object({
    tenantId: z.string(),
    panelId: z.string().optional(),
    providerType: z.string().optional(),
    orderId: z.string().optional(),
    serviceId: z.string().optional(),
    operationId: z.string().optional(),
  })
  .strict();
