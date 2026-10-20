import type { ActorContext, PermissionKey, TenantContext } from '@nexa/contracts';

/**
 * What a Web Admin row prints for the records it links to (Round 4, PR-C): an order,
 * service, payment or ticket by its 8-character public code, a panel by its name, a product
 * by `P-102` and its title — never a uuid. The uuid stays the LINK target and the value
 * behind «کپی شناسه».
 *
 * ONE reader for every list and detail page, so the answer to "what does this id print as"
 * is the same everywhere — the same reason `readCustomerIdentities` is one reader.
 */
export interface PublicLabelRequest {
  readonly orderIds?: readonly (string | null)[];
  readonly serviceIds?: readonly (string | null)[];
  readonly paymentIds?: readonly (string | null)[];
  readonly ticketIds?: readonly (string | null)[];
  readonly panelIds?: readonly (string | null)[];
  readonly productIds?: readonly (string | null)[];
}

export interface ProductLabel {
  /** `P-102`, or null for a product the backfill has not reached. */
  readonly code: string | null;
  readonly title: string;
}

export interface PublicLabels {
  /** id → code (null: not yet backfilled). An id with no row in the tenant is absent. */
  readonly orders: ReadonlyMap<string, string | null>;
  readonly services: ReadonlyMap<string, string | null>;
  readonly payments: ReadonlyMap<string, string | null>;
  readonly tickets: ReadonlyMap<string, string | null>;
  readonly panels: ReadonlyMap<string, string>;
  readonly products: ReadonlyMap<string, ProductLabel>;
}

export interface PublicLabelReader {
  read(scope: TenantContext, request: PublicLabelRequest): Promise<PublicLabels>;
}

interface Guard {
  check(scope: TenantContext, actor: ActorContext, permission: PermissionKey): Promise<void>;
}

/**
 * The labels, charged to the permission of the page that asks: a list of orders reads its
 * products' and panels' labels under `orders.view`, never under nothing. Read-only, and only
 * for ids the caller's own authorised response already carries.
 */
export class PublicLabelService {
  constructor(private readonly deps: { guard: Guard; reader: PublicLabelReader }) {}

  async read(
    scope: TenantContext,
    actor: ActorContext,
    permission: PermissionKey,
    request: PublicLabelRequest,
  ): Promise<PublicLabels> {
    await this.deps.guard.check(scope, actor, permission);
    return this.deps.reader.read(scope, request);
  }
}
