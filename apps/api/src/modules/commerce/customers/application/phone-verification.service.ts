import {
  COMMERCE_ERROR_CODES,
  errors,
  maskPhoneNumber,
  normalisePhoneNumber,
  userIdSchema,
  type ActorContext,
  type AuditWriter,
  type Clock,
  type IdempotencyStore,
  type OperationalEventRecorder,
  type TenantContext,
  type UnitOfWork,
  type UserId,
} from '@nexa/contracts';
import type { OutboxWriter } from '../../../platform/eventing/infrastructure/outbox-writer.js';
import type { PermissionGuard } from '../../../platform/access/application/permission-guard.js';
import { runAuthorizedMutation } from '../../../platform/access/application/authorized-mutation.js';
import { rememberOnce } from '../../../platform/idempotency/application/remember-once.js';
import { hashRequest } from '../../../platform/idempotency/infrastructure/drizzle-idempotency-store.js';
import type { SessionRepository } from '../../../platform/identity/application/ports.js';
import type { ScopeActivityReader } from '../../../platform/system/application/record-ping.service.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import { PHONE_VERIFICATION_FLAG } from '../../payments/domain/gateway-eligibility.js';
import { RESOLVE_CUSTOMER_PERMISSION } from './customer.service.js';
import type { CustomerRecord, CustomerRepository } from './ports.js';

/**
 * R11 B7: a contact a customer shared in the bot, as the Telegram surface read it — and
 * nothing it decided about it. Whether it is the sender's OWN number is decided below.
 */
export interface SharedContact {
  /** `contact.phone_number` as Telegram sent it (international digits, `+` optional). */
  readonly phoneNumber: string;
  /**
   * `contact.user_id`: the Telegram account the contact belongs to, or null when the contact
   * names none (a number typed into an address book). Telegram sets it to the sender's own
   * id when they share their own contact with the contact button.
   */
  readonly userId: string | null;
  /** The message was FORWARDED (`forward_origin` / `forward_from` / `forward_date`). */
  readonly forwarded: boolean;
}

export interface PhoneVerificationDeps {
  readonly customers: Pick<CustomerRepository, 'findById' | 'setVerifiedPhone'>;
  readonly features: {
    isEnabled(
      scope: TenantContext,
      key: typeof PHONE_VERIFICATION_FLAG,
      tx?: unknown,
    ): Promise<boolean>;
  };
  readonly guard: PermissionGuard;
  readonly audit: AuditWriter;
  readonly opsLog: OperationalEventRecorder;
  readonly sessions: SessionRepository;
  readonly scopeActivity: ScopeActivityReader;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly idempotency: IdempotencyStore;
  readonly outbox: OutboxWriter;
  readonly clock: Clock;
}

/** What one verification did: the number now on the row, masked, and whether it changed. */
export interface PhoneVerificationResult {
  readonly customer: CustomerRecord;
  /** `maskPhoneNumber` of the verified number — the only form a reply or a log may carry. */
  readonly masked: string;
  readonly changed: boolean;
}

/** The audit action of a customer's own verification; an operator's is `customer.phone.verify`. */
export const SELF_VERIFY_AUDIT_ACTION = 'customer.phone.self_verify';

/**
 * A Telegram contact number as this installation stores one (E.164, `normalisePhoneNumber`).
 *
 * Telegram sends a contact's number in international form, usually WITHOUT the `+`
 * (`989121234567`), sometimes with it. Digits alone are therefore read as international —
 * which is what Telegram means by them — and NOT as a national number: there is no
 * national form here to guess about. Anything else goes through the one normaliser, which
 * refuses rather than guesses.
 */
export function normaliseContactPhone(raw: string): string | null {
  const trimmed = raw.trim().replace(/[\s\-().]/gu, '');
  const international = /^[1-9][0-9]{7,14}$/u.test(trimmed) ? `+${trimmed}` : trimmed;
  return normalisePhoneNumber(international);
}

/**
 * R11 B7: a customer verifies their OWN phone number by sharing their Telegram contact.
 *
 * Only their own number. Telegram stamps `contact.user_id` with the sharer's own id when
 * they use the contact button, so the rule is exact and needs no guess: the contact's
 * `user_id` must be the Telegram id of the customer this update resolved to — the signed
 * sender, never an id the message chose. A contact naming nobody, somebody else, or one
 * that was FORWARDED (a forwarded own-contact of another account still carries that
 * account's id; a forwarded copy of one's own is not a share) is refused with
 * `PHONE_CONTACT_NOT_OWN` and nothing is stored.
 *
 * The write path is `CustomerService.setMarketingOptOut`'s: `maintenance.run` (the
 * customer-initiated webhook path acts as SYSTEM_JOB), the update's key under the actor's
 * surface, and ONE transaction holding the scope-activity read, the flag (re-read where the
 * row changes, so a stale button after a switch-off stores nothing), the conditional UPDATE,
 * the audit row and the `CustomerPhoneVerificationChanged` event. Idempotent: the same
 * number again changes nothing and keeps its first verification time; a different number
 * replaces the stored one.
 *
 * The number is never written to a log, an event or the audit row: the audit carries
 * `maskPhoneNumber` only, the event `{ verified: true }`.
 */
export class PhoneVerificationService {
  constructor(private readonly deps: PhoneVerificationDeps) {}

  /** Whether the bot offers verification now. A courtesy; the write decides again. */
  async enabled(scope: TenantContext, tx?: unknown): Promise<boolean> {
    return this.deps.features.isEnabled(scope, PHONE_VERIFICATION_FLAG, tx);
  }

  async verifyOwnContact(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly idempotencyKey: string;
      readonly customerId: string;
      readonly contact: SharedContact;
    },
  ): Promise<PhoneVerificationResult> {
    const customerId = this.customerId(input.customerId);
    // Refused before anything is read or stored: a forwarded contact is never a share.
    if (input.contact.forwarded || input.contact.userId === null) throw notOwn();
    const phone = normaliseContactPhone(input.contact.phoneNumber);
    if (phone === null) {
      throw errors.validation(
        COMMERCE_ERROR_CODES.CUSTOMER_PHONE_INVALID,
        'The shared contact is not a phone number this installation can store.',
      );
    }
    // The hash carries the number's mask, never the number: the idempotency row is durable.
    const requestHash = hashRequest({
      customerId,
      contactUserId: input.contact.userId,
      phone: maskPhoneNumber(phone),
      phoneLength: phone.length,
    });
    const namespace = actor.surface;
    const replay = await this.deps.idempotency.find<{ customerId: string; changed: boolean }>(
      scope,
      namespace,
      input.idempotencyKey,
      requestHash,
    );
    if (replay !== null) {
      const replayed = await this.deps.customers.findById(scope, customerId);
      if (replayed !== null && replayed.phoneNumber !== null) {
        return {
          customer: replayed,
          masked: maskPhoneNumber(replayed.phoneNumber),
          changed: replay.result.changed,
        };
      }
    }
    const now = this.deps.clock.now();
    return runAuthorizedMutation(
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
      RESOLVE_CUSTOMER_PERMISSION,
      { action: SELF_VERIFY_AUDIT_ACTION, entityType: 'Customer', entityId: customerId },
      async (tx) => {
        if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) {
          throw errors.conflict(
            COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
            'This installation has stopped accepting work.',
          );
        }
        if (!(await this.enabled(scope, tx))) {
          throw errors.conflict(
            COMMERCE_ERROR_CODES.PHONE_VERIFICATION_DISABLED,
            'This installation does not verify phone numbers.',
          );
        }
        const before = await this.deps.customers.findById(scope, customerId, tx);
        if (before === null) {
          throw errors.notFound(COMMERCE_ERROR_CODES.CUSTOMER_NOT_FOUND, 'Unknown customer.');
        }
        /*
         * THE rule: the contact belongs to the account that sent it. Compared with the row's
         * own Telegram id — the identity the signed update resolved to — as decimal strings,
         * so no id is ever rounded through a float.
         */
        if (input.contact.userId !== before.telegramUserId) throw notOwn();
        const changed = await this.deps.customers.setVerifiedPhone(
          scope,
          customerId,
          phone,
          now,
          tx,
        );
        const after = await this.deps.customers.findById(scope, customerId, tx);
        if (after === null) {
          throw errors.notFound(COMMERCE_ERROR_CODES.CUSTOMER_NOT_FOUND, 'Unknown customer.');
        }
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: SELF_VERIFY_AUDIT_ACTION,
            entityType: 'Customer',
            entityId: customerId,
            before: {
              phoneNumber: before.phoneNumber === null ? null : maskPhoneNumber(before.phoneNumber),
            },
            after: { phoneNumber: maskPhoneNumber(phone), changed },
            result: 'SUCCESS',
          },
          tx,
        );
        if (changed) {
          await this.deps.outbox.write(tx, actor, {
            eventType: 'CustomerPhoneVerificationChanged',
            aggregateType: 'Customer',
            aggregateId: customerId,
            payload: { verified: true },
          });
        }
        await rememberOnce(
          this.deps.idempotency,
          scope,
          namespace,
          input.idempotencyKey,
          requestHash,
          { customerId, changed },
          tx,
        );
        return { customer: after, masked: maskPhoneNumber(phone), changed };
      },
    );
  }

  private customerId(candidate: string): UserId {
    const parsed = userIdSchema.safeParse(candidate);
    if (!parsed.success) {
      throw errors.notFound(COMMERCE_ERROR_CODES.CUSTOMER_NOT_FOUND, 'Unknown customer.');
    }
    return parsed.data;
  }
}

function notOwn() {
  return errors.conflict(
    COMMERCE_ERROR_CODES.PHONE_CONTACT_NOT_OWN,
    'Only the sender’s own contact verifies a phone number.',
  );
}
