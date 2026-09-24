import {
  CUSTOMER_TEXT_CAPTURE_TTL_MS,
  COMMERCE_ERROR_CODES,
  errors,
  type ActorContext,
  type AuditWriter,
  type BotInstanceId,
  type Clock,
  type CustomerCaptureCloseReason,
  type CustomerCapturePurpose,
  type IdGenerator,
  type IdempotencyStore,
  type Money,
  type OperationalEventRecorder,
  type PermissionKey,
  type TenantContext,
  type UnitOfWork,
  type UserId,
} from '@nexa/contracts';
import type { PermissionGuard } from '../../../platform/access/application/permission-guard.js';
import {
  recordMutationDenial,
  runAuthorizedMutation,
} from '../../../platform/access/application/authorized-mutation.js';
import { rememberOnce } from '../../../platform/idempotency/application/remember-once.js';
import { hashRequest } from '../../../platform/idempotency/infrastructure/drizzle-idempotency-store.js';
import type { SessionRepository } from '../../../platform/identity/application/ports.js';
import type { ScopeActivityReader } from '../../../platform/system/application/record-ping.service.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { CustomerRepository } from './ports.js';
import type {
  CustomerCaptureRecord,
  CustomerCaptureRepository,
  CustomerWindowSuperseder,
} from './customer-capture-ports.js';

const CAPTURE_NAMESPACE = 'TELEGRAM' as const;

/**
 * The permission every customer-initiated write charges (`ORDER_PLACE_PERMISSION`,
 * `PAYMENT_PLACE_PERMISSION`): the customer is the actor and ownership is the
 * authorization, but the guard still runs, deny by default, for every actor type.
 */
const CUSTOMER_CAPTURE_PERMISSION: PermissionKey = 'maintenance.run';

export interface CustomerCaptureServiceDeps {
  readonly captures: CustomerCaptureRepository;
  readonly windows: CustomerWindowSuperseder;
  readonly customers: Pick<CustomerRepository, 'findById'>;
  readonly guard: PermissionGuard;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly audit: AuditWriter;
  readonly opsLog: OperationalEventRecorder;
  readonly sessions: SessionRepository;
  readonly idempotency: IdempotencyStore;
  readonly scopeActivity: ScopeActivityReader;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

export type CaptureReadResult =
  /** Nothing open: the message is not an answer to anything here. */
  | { readonly outcome: 'NO_WINDOW' }
  /** The window was past its deadline; it is closed now and the message is not consumed. */
  | { readonly outcome: 'EXPIRED' }
  /**
   * The open window read the text. A `SERVICE_SEARCH` or `SERVICE_NOTE` window is
   * closed RECEIVED by this call; a `TOPUP_AMOUNT` window stays open, awaiting the
   * amount the caller validates and records.
   */
  | { readonly outcome: 'READ'; readonly capture: CustomerCaptureRecord; readonly text: string };

/**
 * A customer's plain-text windows (customer UX completion §N).
 *
 * The rules, in one place: one open window per (tenant, bot, customer) across ALL the
 * customer's window tables — opening one here supersedes the username and discount
 * windows, and those supersede this one — so the most recent prompt is the only
 * reader; a window past its deadline answers NO_WINDOW and is closed EXPIRED by whoever
 * finds it, never "your window expired" to somebody who typed an unrelated sentence;
 * and a window names its purpose, so a search term is never parsed as an amount.
 */
export class CustomerCaptureService {
  constructor(private readonly deps: CustomerCaptureServiceDeps) {}

  async open(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly idempotencyKey: string;
      readonly botInstanceId: BotInstanceId;
      readonly customerId: UserId;
      readonly purpose: CustomerCapturePurpose;
      readonly subjectId: string | null;
    },
  ): Promise<CustomerCaptureRecord> {
    const denial = {
      action: 'customer.capture.open',
      entityType: 'Customer',
      entityId: input.customerId,
    };
    await this.authorize(scope, actor, denial);
    const requestHash = hashRequest({
      bot: input.botInstanceId,
      customerId: input.customerId,
      purpose: input.purpose,
      subjectId: input.subjectId,
    });
    const replayed = await this.deps.idempotency.find<{ captureId: string }>(
      scope,
      CAPTURE_NAMESPACE,
      input.idempotencyKey,
      requestHash,
    );
    if (replayed !== null) {
      const found = await this.deps.captures.findById(scope, replayed.result.captureId);
      if (found !== null) return found;
    }

    return this.mutate(scope, actor, denial, async (tx) => {
      await this.assertScopeActive(scope, tx);
      await this.assertCustomerActive(scope, input.customerId, tx);
      await this.deps.captures.lockForCustomer(scope, input.botInstanceId, input.customerId, tx);
      const now = this.deps.clock.now();
      // The other two windows first, then this table's own (inside `open`), so that
      // whichever prompt the customer sees LAST is the one that reads their answer.
      await this.deps.windows.closeOpenFor(scope, input.botInstanceId, input.customerId, now, tx);
      const capture = await this.deps.captures.open(
        scope,
        {
          id: this.deps.ids.uuid(),
          botInstanceId: input.botInstanceId,
          customerId: input.customerId,
          purpose: input.purpose,
          subjectId: input.subjectId,
          openedAt: now,
          expiresAt: new Date(now.getTime() + CUSTOMER_TEXT_CAPTURE_TTL_MS),
        },
        tx,
      );
      await rememberOnce(
        this.deps.idempotency,
        scope,
        CAPTURE_NAMESPACE,
        input.idempotencyKey,
        requestHash,
        { captureId: capture.id },
        tx,
      );
      return capture;
    });
  }

  /**
   * Offers a plain message to the customer's open window, if there is one.
   *
   * No permission check and no transaction unless a window exists: this runs for EVERY
   * plain message a customer sends, and most are not answers to anything.
   */
  async readText(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly idempotencyKey: string;
      readonly botInstanceId: BotInstanceId;
      readonly customerId: UserId;
      readonly text: string;
    },
  ): Promise<CaptureReadResult> {
    const requestHash = hashRequest({
      bot: input.botInstanceId,
      customerId: input.customerId,
      text: input.text,
      read: true,
    });
    const replayed = await this.deps.idempotency.find<{ captureId: string }>(
      scope,
      CAPTURE_NAMESPACE,
      input.idempotencyKey,
      requestHash,
    );
    if (replayed !== null) {
      // A redelivered update re-reads the window it read the first time, so the caller
      // recomputes the same answer rather than falling through to "unknown command".
      const capture = await this.deps.captures.findById(scope, replayed.result.captureId);
      if (capture !== null) return { outcome: 'READ', capture, text: input.text };
      return { outcome: 'NO_WINDOW' };
    }

    const open = await this.deps.captures.findOpen(scope, input.botInstanceId, input.customerId);
    if (open === null) return { outcome: 'NO_WINDOW' };

    const denial = {
      action: 'customer.capture.read',
      entityType: 'Customer',
      entityId: input.customerId,
    };
    return this.mutate(scope, actor, denial, async (tx) => {
      await this.deps.captures.lockForCustomer(scope, input.botInstanceId, input.customerId, tx);
      const capture = await this.deps.captures.findOpen(
        scope,
        input.botInstanceId,
        input.customerId,
        tx,
      );
      if (capture === null) return { outcome: 'NO_WINDOW' } as const;
      const now = this.deps.clock.now();
      if (now.getTime() >= capture.expiresAt.getTime()) {
        await this.deps.captures.close(scope, capture.id, 'EXPIRED', now, tx);
        return { outcome: 'EXPIRED' } as const;
      }
      // An amount window that already holds its figure is waiting for a ROUTE, not for
      // text; a second figure typed under the buttons is not an answer to anything.
      if (capture.state === 'AMOUNT_RECORDED') return { outcome: 'NO_WINDOW' } as const;
      if (capture.purpose !== 'TOPUP_AMOUNT') {
        await this.deps.captures.close(scope, capture.id, 'RECEIVED', now, tx);
      }
      await rememberOnce(
        this.deps.idempotency,
        scope,
        CAPTURE_NAMESPACE,
        input.idempotencyKey,
        requestHash,
        { captureId: capture.id },
        tx,
      );
      return { outcome: 'READ', capture, text: input.text } as const;
    });
  }

  /** `AWAITING_TEXT → AMOUNT_RECORDED` for a TOPUP_AMOUNT window, inside the caller's transaction. */
  async recordAmount(
    scope: TenantContext,
    captureId: string,
    amount: Money,
    tx: TransactionScope,
  ): Promise<boolean> {
    return this.deps.captures.recordAmount(scope, captureId, amount, tx);
  }

  /**
   * The customer's OWN open window by id, or null. A crafted id, another customer's
   * capture, a closed one and an expired one are all null — one answer, no oracle.
   */
  async findOwnedOpen(
    scope: TenantContext,
    customerId: UserId,
    captureId: string,
    tx?: unknown,
  ): Promise<CustomerCaptureRecord | null> {
    const capture = await this.deps.captures.findById(scope, captureId, tx);
    if (capture === null || capture.customerId !== customerId || capture.closedAt !== null) {
      return null;
    }
    if (this.deps.clock.now().getTime() >= capture.expiresAt.getTime()) return null;
    return capture;
  }

  async close(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly customerId: UserId;
      readonly captureId: string;
      readonly reason: CustomerCaptureCloseReason;
    },
  ): Promise<boolean> {
    const denial = {
      action: 'customer.capture.close',
      entityType: 'Customer',
      entityId: input.customerId,
    };
    await this.authorize(scope, actor, denial);
    return this.mutate(scope, actor, denial, async (tx) => {
      const capture = await this.deps.captures.findById(scope, input.captureId, tx);
      if (capture === null || capture.customerId !== input.customerId) return false;
      return this.deps.captures.close(scope, capture.id, input.reason, this.deps.clock.now(), tx);
    });
  }

  private async assertCustomerActive(
    scope: TenantContext,
    customerId: UserId,
    tx: TransactionScope,
  ): Promise<void> {
    const customer = await this.deps.customers.findById(scope, customerId, tx);
    if (customer === null) {
      throw errors.notFound(COMMERCE_ERROR_CODES.CUSTOMER_NOT_FOUND, 'Unknown customer.');
    }
    if (customer.status === 'BLOCKED') {
      throw errors.conflict(COMMERCE_ERROR_CODES.CUSTOMER_BLOCKED, 'This account is blocked.');
    }
  }

  private async assertScopeActive(scope: TenantContext, tx: TransactionScope): Promise<void> {
    if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) {
      throw errors.conflict(
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
        'This installation has stopped accepting work.',
      );
    }
  }

  private async authorize(
    scope: TenantContext,
    actor: ActorContext,
    denial: { action: string; entityType: string; entityId: string | null },
  ): Promise<void> {
    try {
      await this.deps.guard.check(scope, actor, CUSTOMER_CAPTURE_PERMISSION);
    } catch (error) {
      await recordMutationDenial(
        this.mutationDeps(),
        scope,
        actor,
        CUSTOMER_CAPTURE_PERMISSION,
        denial,
        error,
      );
      throw error;
    }
  }

  private mutate<T>(
    scope: TenantContext,
    actor: ActorContext,
    denial: { action: string; entityType: string; entityId: string | null },
    work: (tx: TransactionScope) => Promise<T>,
  ): Promise<T> {
    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      CUSTOMER_CAPTURE_PERMISSION,
      denial,
      work,
    );
  }

  private mutationDeps() {
    return {
      uow: this.deps.uow,
      guard: this.deps.guard,
      audit: this.deps.audit,
      opsLog: this.deps.opsLog,
      sessions: this.deps.sessions,
      clock: this.deps.clock,
    };
  }
}
