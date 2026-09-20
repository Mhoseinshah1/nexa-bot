import {
  COMMERCE_ERROR_CODES,
  PANEL_ERROR_CODES,
  errors,
  isNewProviderUsername,
  type IdGenerator,
  type ServiceUsernameMode,
  type TenantContext,
  type UserId,
  type UsernameCaptureCloseReason,
} from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { PanelRepository } from '../../../platform/panels/application/ports.js';
import type { CustomerRepository } from '../../customers/application/ports.js';
import { modesOffered } from './username-allocator.js';
import type { UsernameAllocator } from './username-allocator.js';
import type {
  ServiceUsernameRepository,
  UsernameCaptureRecord,
  UsernameCaptureRepository,
  UsernameReservation,
} from './username-ports.js';

export interface UsernameChoice {
  readonly mode: ServiceUsernameMode;
  /** What the customer typed, RAW. Only read for CUSTOM. */
  readonly raw?: string | undefined;
}

export interface UsernameLaneTarget {
  readonly orderId: string;
  /**
   * BRANDED, not a bare string.
   *
   * The caller has already parsed it — `OrderService.customerId` — and taking the
   * brand here means this lane cannot be handed an order id by mistake, which is the
   * one substitution that would reserve a name against somebody else's customer.
   */
  readonly customerId: UserId;
  readonly panelId: string;
  /** The ORDER's deadline, so an unfunded hold and its order lapse together. */
  readonly expiresAt: Date;
}

/**
 * What the orders module is allowed to know about usernames.
 *
 * A narrow port rather than the allocator itself, for the reason `PanelSalesGate`
 * exists: `OrderService` would otherwise need a panel repository, a customer
 * repository and the allocator, to answer a question that is not about orders.
 */
export interface OrderUsernameLane {
  /** Which modes this order's panel offers, for a surface deciding what to draw. */
  modesFor(
    scope: TenantContext,
    panelId: string,
    tx?: TransactionScope,
  ): Promise<readonly ServiceUsernameMode[]>;
  /** Take the name the customer chose. Idempotent per order. */
  choose(
    scope: TenantContext,
    target: UsernameLaneTarget,
    choice: UsernameChoice,
    tx: TransactionScope,
  ): Promise<UsernameReservation>;
  /** The name this order holds, or null. */
  held(
    scope: TenantContext,
    orderId: string,
    tx?: TransactionScope,
  ): Promise<UsernameReservation | null>;
  /** At the money boundary: a name must exist. See the implementation. */
  require(
    scope: TenantContext,
    target: UsernameLaneTarget,
    tx: TransactionScope,
  ): Promise<UsernameReservation>;
  markFunded(
    scope: TenantContext,
    orderId: string,
    at: Date,
    tx: TransactionScope,
  ): Promise<boolean>;
  release(scope: TenantContext, orderId: string, tx: TransactionScope): Promise<boolean>;

  /*
   * The typing window. Here rather than in a lane of its own because it answers the
   * same question from the other side: the reservation says what the name IS, and the
   * window says when a plain message is allowed to propose one.
   */
  lockWindow(
    scope: TenantContext,
    botInstanceId: string,
    customerId: string,
    tx: TransactionScope,
  ): Promise<void>;
  openWindow(
    scope: TenantContext,
    input: {
      readonly botInstanceId: string;
      readonly customerId: string;
      readonly orderId: string;
      readonly openedAt: Date;
      readonly expiresAt: Date;
    },
    tx: TransactionScope,
  ): Promise<UsernameCaptureRecord>;
  openWindowFor(
    scope: TenantContext,
    botInstanceId: string,
    customerId: string,
    tx: TransactionScope,
  ): Promise<UsernameCaptureRecord | null>;
  closeWindow(
    scope: TenantContext,
    id: string,
    reason: UsernameCaptureCloseReason,
    at: Date,
    tx: TransactionScope,
  ): Promise<boolean>;
}

export interface UsernameLaneDeps {
  readonly allocator: UsernameAllocator;
  readonly repository: ServiceUsernameRepository;
  readonly captures: UsernameCaptureRepository;
  readonly ids: IdGenerator;
  readonly panels: PanelRepository;
  readonly customers: CustomerRepository;
}

/** The lane, wired to the panels and customers it needs and to nothing else. */
export class PanelUsernameLane implements OrderUsernameLane {
  constructor(private readonly deps: UsernameLaneDeps) {}

  async modesFor(
    scope: TenantContext,
    panelId: string,
    tx?: TransactionScope,
  ): Promise<readonly ServiceUsernameMode[]> {
    return modesOffered((await this.panel(scope, panelId, tx)).usernamePolicy);
  }

  async held(
    scope: TenantContext,
    orderId: string,
    tx?: TransactionScope,
  ): Promise<UsernameReservation | null> {
    return this.deps.repository.findByOrder(scope, orderId, tx);
  }

  async choose(
    scope: TenantContext,
    target: UsernameLaneTarget,
    choice: UsernameChoice,
    tx: TransactionScope,
  ): Promise<UsernameReservation> {
    const panel = await this.panel(scope, target.panelId, tx);
    const customer = await this.deps.customers.findById(scope, target.customerId, tx);
    if (customer === null) {
      throw errors.notFound(COMMERCE_ERROR_CODES.CUSTOMER_NOT_FOUND, 'Unknown customer.');
    }
    return this.deps.allocator.allocate(
      scope,
      {
        orderId: target.orderId,
        customerId: target.customerId,
        telegramId: customer.telegramUserId,
        panelId: panel.id,
        providerType: panel.providerType,
        baseUrl: panel.baseUrl,
        policy: panel.usernamePolicy,
        mode: choice.mode,
        raw: choice.raw,
        expiresAt: target.expiresAt,
      },
      tx,
    );
  }

  /**
   * The name this order will use, allocating one if the step was skipped.
   *
   * Called at the money boundary, where "no name" is not an answer: settlement writes
   * `services.provider_username` and something has to be in it. A reservation is
   * normally already there — the customer chose before confirming — and this returns
   * it unchanged.
   *
   * When there is none, RANDOM is allocated rather than refusing, because the only way
   * to get here is an order whose username step predates this feature or a callback
   * replayed from before it existed, and sending a customer at the confirm button back
   * for something the installation can decide itself is a worse answer than deciding
   * it. On a panel that offers CUSTOM and nothing else it IS refused: there the
   * operator has said the customer chooses, and choosing for them is the legacy defect
   * that put an administrator's own name on thirteen thousand records.
   */
  async require(
    scope: TenantContext,
    target: UsernameLaneTarget,
    tx: TransactionScope,
  ): Promise<UsernameReservation> {
    const held = await this.held(scope, target.orderId, tx);
    if (held !== null) return this.stillUsable(scope, held, tx);

    const panel = await this.panel(scope, target.panelId, tx);
    if (!panel.usernamePolicy.allowAutomatic) {
      throw errors.preconditionFailed(
        COMMERCE_ERROR_CODES.SERVICE_USERNAME_REQUIRED,
        'Choose a username for this service before confirming.',
      );
    }
    return this.choose(scope, target, { mode: 'AUTOMATIC' }, tx);
  }

  /**
   * A held name that the CURRENT contract would still mint, or a refusal that frees it.
   *
   * The one place a frozen name is ever re-judged, and it is fenced by `fundedAt`.
   * An UNFUNDED hold is a draft: no money has moved, nothing exists on a panel, and a
   * name frozen under an older rule — longer than twenty characters, or carrying a
   * character this contract no longer accepts — can be released and chosen again at no
   * cost to anybody. That release happens ONCE, inside the caller's transaction, and
   * the customer is told to choose.
   *
   * A FUNDED name is returned untouched whatever it looks like, and that asymmetry is
   * the whole point. Money has moved and an account may already exist under that name;
   * renaming it would leave this installation addressing an account by a name the
   * panel does not know it by. An ambiguous outcome is reconciliation's problem and a
   * definitive non-delivery is the refund's — neither is a rename.
   *
   * Existing SERVICES are not reachable from here at all: this reads
   * `service_username_reservations`, and a provisioned service's name lives on
   * `services.provider_username`, which nothing in this file writes.
   */
  private async stillUsable(
    scope: TenantContext,
    held: UsernameReservation,
    tx: TransactionScope,
  ): Promise<UsernameReservation> {
    if (held.fundedAt !== null || isNewProviderUsername(held.username)) return held;
    await this.deps.repository.release(scope, held.orderId, tx);
    throw errors.preconditionFailed(
      COMMERCE_ERROR_CODES.SERVICE_USERNAME_STALE,
      'That username is no longer valid. Choose another before confirming.',
    );
  }

  async markFunded(
    scope: TenantContext,
    orderId: string,
    at: Date,
    tx: TransactionScope,
  ): Promise<boolean> {
    return this.deps.repository.markFunded(scope, orderId, at, tx);
  }

  async release(scope: TenantContext, orderId: string, tx: TransactionScope): Promise<boolean> {
    return this.deps.repository.release(scope, orderId, tx);
  }

  async lockWindow(
    scope: TenantContext,
    botInstanceId: string,
    customerId: string,
    tx: TransactionScope,
  ): Promise<void> {
    return this.deps.captures.lockForCustomer(scope, botInstanceId, customerId, tx);
  }

  async openWindow(
    scope: TenantContext,
    input: {
      readonly botInstanceId: string;
      readonly customerId: string;
      readonly orderId: string;
      readonly openedAt: Date;
      readonly expiresAt: Date;
    },
    tx: TransactionScope,
  ): Promise<UsernameCaptureRecord> {
    return this.deps.captures.open(scope, { id: this.deps.ids.uuid(), ...input }, tx);
  }

  async openWindowFor(
    scope: TenantContext,
    botInstanceId: string,
    customerId: string,
    tx: TransactionScope,
  ): Promise<UsernameCaptureRecord | null> {
    return this.deps.captures.findOpen(scope, botInstanceId, customerId, tx);
  }

  async closeWindow(
    scope: TenantContext,
    id: string,
    reason: UsernameCaptureCloseReason,
    at: Date,
    tx: TransactionScope,
  ): Promise<boolean> {
    return this.deps.captures.close(scope, id, reason, at, tx);
  }

  private async panel(scope: TenantContext, panelId: string, tx?: TransactionScope) {
    const view = await this.deps.panels.find(scope, panelId, tx);
    if (view === null) {
      throw errors.notFound(PANEL_ERROR_CODES.PANEL_NOT_FOUND, 'Unknown panel.');
    }
    return view.panel;
  }
}
