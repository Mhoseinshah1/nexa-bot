import {
  COMMERCE_ERROR_CODES,
  PHONE_ALLOWED_NUMBERS_SETTING_KEY,
  errors,
  maskPhoneNumber,
  normalisePhoneNumber,
  userIdSchema,
  type ActorContext,
  type AuditWriter,
  type Clock,
  type IdempotencyStore,
  type OperationalEventRecorder,
  type PhoneAllowedNumbers,
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
import {
  PHONE_VERIFICATION_FLAG,
  notAcceptedPhoneCounts,
} from '../../payments/domain/gateway-eligibility.js';
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
  readonly customers: Pick<
    CustomerRepository,
    'findById' | 'setVerifiedPhone' | 'setNotAcceptedPhone' | 'setPhoneResume' | 'takePhoneResume'
  >;
  /**
   * NEXA v095 PR-4 B: `phone_verification.allowed_numbers`, read in the verification's own
   * transaction. Absent (a narrow fixture): every number is allowed, the default.
   */
  readonly settings?: {
    valueOf<T>(
      scope: TenantContext,
      key: typeof PHONE_ALLOWED_NUMBERS_SETTING_KEY,
      tx?: unknown,
    ): Promise<T>;
  };
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
  /** `maskPhoneNumber` of the stored number — the only form a reply or a log may carry. */
  readonly masked: string;
  readonly changed: boolean;
  /**
   * NEXA v099 (owner): false when the number was stored as NOT accepted (IRAN_ONLY, not +98)
   * — it is on the row, it is not verified, and nothing resumes (`resume` is null).
   */
  readonly accepted: boolean;
  /**
   * NEXA v095 PR-4 A/C: the action a phone gate held, taken (read and cleared) in this
   * verification's transaction — the bot resumes it. Null when none was remembered, when it
   * was older than `PHONE_RESUME_LIFETIME_MS`, or on a replay.
   */
  readonly resume: string | null;
}

/**
 * NEXA v095 PR-4: how long a held action stays resumable. Long enough to find the contact
 * button, short enough that a contact shared tomorrow does not start yesterday's payment.
 * The resumed action is decided again by its own service in any case.
 */
export const PHONE_RESUME_LIFETIME_MS = 30 * 60 * 1000;

/** The longest action remembered: a callback's data is at most 64 bytes, a command shorter. */
export const PHONE_RESUME_MAX_LENGTH = 300;

/**
 * NEXA v095 PR-4 B: whether a stored (E.164, `normaliseContactPhone`) number is Iranian. The
 * normaliser has already read `98…`, `+98…` and `0098…` as `+98…`.
 */
export function isIranianPhoneNumber(e164: string): boolean {
  return /^\+98[0-9]{8,12}$/u.test(e164);
}

/**
 * NEXA v095 PR-4 A: whether the bot-wide gate holds this customer — the feature is on (asked
 * by the caller), and they have neither a verified number nor an exemption. A number verified
 * earlier, whatever its country, is verified (B never revokes one).
 */
export function phoneGateHolds(
  customer: Pick<CustomerRecord, 'phoneVerifiedAt' | 'phoneVerificationExemptAt'>,
): boolean {
  return customer.phoneVerifiedAt === null && customer.phoneVerificationExemptAt === null;
}

/**
 * What the bot-wide phone gate does with a customer (NEXA v095 PR-4 A, NEXA v099):
 * `OPEN` — let them through; `REQUIRED` — ask for the contact («📞 Share Contact»);
 * `NOT_ACCEPTED` — their own number is stored as NOT accepted and IRAN_ONLY is on: they are
 * told so (`bot.phone.not_accepted`) and NOT asked again. Neither held state blocks or bans.
 */
export type PhoneGateState = 'OPEN' | 'REQUIRED' | 'NOT_ACCEPTED';

/**
 * THE decision of the bot-wide phone gate, for the bot and the mini app alike: off opens; a
 * verified number or an exemption opens (`phoneGateHolds`); a number stored as not accepted
 * opens only when the allowed numbers count it (`notAcceptedPhoneCounts`, ALL) and otherwise
 * holds with `NOT_ACCEPTED`; no number holds with `REQUIRED`.
 */
export function phoneGateOf(
  customer: Pick<
    CustomerRecord,
    'phoneVerifiedAt' | 'phoneVerificationExemptAt' | 'phoneNotAcceptedAt'
  >,
  enabled: boolean,
  allowed: PhoneAllowedNumbers,
): PhoneGateState {
  if (!enabled || !phoneGateHolds(customer)) return 'OPEN';
  // `== null`: a row read without the column is asked for a number, never let through.
  if (customer.phoneNotAcceptedAt == null) return 'REQUIRED';
  return notAcceptedPhoneCounts(allowed) ? 'OPEN' : 'NOT_ACCEPTED';
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
 * surface, and ONE transaction holding the scope-activity read, the allowed-numbers setting
 * (NEXA v095 PR-4 B), the conditional UPDATE, the audit row, the
 * `CustomerPhoneVerificationChanged` event and the held action it resumes (A/C). Not bound to
 * the `phone_verification` flag any more (C): a route's rule verifies with the flag off. Idempotent: the same
 * number again changes nothing and keeps its first verification time; a different number
 * replaces the stored one.
 *
 * The number is never written to a log, an event or the audit row: the audit carries
 * `maskPhoneNumber` only, the event `{ verified: true }`.
 */
export class PhoneVerificationService {
  constructor(private readonly deps: PhoneVerificationDeps) {}

  /**
   * Whether the bot-wide gate (`phone_verification`, NEXA v095 PR-4 A) is on. Verification
   * itself does not depend on it: a payment route's rule asks for a number with it off.
   */
  async enabled(scope: TenantContext, tx?: unknown): Promise<boolean> {
    return this.deps.features.isEnabled(scope, PHONE_VERIFICATION_FLAG, tx);
  }

  /**
   * NEXA v099: the bot-wide gate's decision for this customer row (`phoneGateOf`), reading
   * the switch and — only for a number stored as not accepted — the allowed numbers.
   */
  async gateFor(
    scope: TenantContext,
    customer: Pick<
      CustomerRecord,
      'phoneVerifiedAt' | 'phoneVerificationExemptAt' | 'phoneNotAcceptedAt'
    >,
    tx?: unknown,
  ): Promise<PhoneGateState> {
    if (!phoneGateHolds(customer)) return 'OPEN';
    const enabled = await this.enabled(scope, tx);
    if (!enabled) return 'OPEN';
    // The allowed numbers decide only a number stored as not accepted; none is read otherwise.
    const allowed =
      customer.phoneNotAcceptedAt === null ? 'ALL' : await this.allowedNumbers(scope, tx);
    return phoneGateOf(customer, enabled, allowed);
  }

  /** `phone_verification.allowed_numbers`; ALL when no settings are wired (a narrow fixture). */
  async allowedNumbers(scope: TenantContext, tx?: unknown): Promise<PhoneAllowedNumbers> {
    return this.deps.settings === undefined
      ? 'ALL'
      : this.deps.settings.valueOf<PhoneAllowedNumbers>(
          scope,
          PHONE_ALLOWED_NUMBERS_SETTING_KEY,
          tx,
        );
  }

  /**
   * NEXA v095 PR-4 A/C: remember the action a phone gate held, for the verification to
   * resume. UI state (like the wizard rows): no audit row and no event; the scope must still
   * accept work, read in the write's transaction. A value too long to be an action is dropped.
   */
  async rememberResume(
    scope: TenantContext,
    _actor: ActorContext,
    input: { readonly customerId: string; readonly resume: string },
  ): Promise<void> {
    if (input.resume.length === 0 || input.resume.length > PHONE_RESUME_MAX_LENGTH) return;
    const customerId = this.customerId(input.customerId);
    const now = this.deps.clock.now();
    await this.deps.uow.run(scope, async (tx) => {
      if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) return;
      await this.deps.customers.setPhoneResume(scope, customerId, input.resume, now, tx);
    });
  }

  /**
   * NEXA v095 PR-4 C: take (read and clear) the remembered action without verifying — the
   * customer chose «↩️ انتخاب درگاه دیگر» instead. Null when none, or when it is stale.
   */
  async takeResume(
    scope: TenantContext,
    _actor: ActorContext,
    input: { readonly customerId: string },
  ): Promise<string | null> {
    const customerId = this.customerId(input.customerId);
    const now = this.deps.clock.now();
    return this.deps.uow.run(scope, async (tx) => {
      if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) return null;
      const held = await this.deps.customers.takePhoneResume(scope, customerId, now, tx);
      return held !== null && now.getTime() - held.at.getTime() <= PHONE_RESUME_LIFETIME_MS
        ? held.resume
        : null;
    });
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
    const replay = await this.deps.idempotency.find<{
      customerId: string;
      changed: boolean;
      accepted?: boolean;
    }>(scope, namespace, input.idempotencyKey, requestHash);
    if (replay !== null) {
      const replayed = await this.deps.customers.findById(scope, customerId);
      if (replayed !== null && replayed.phoneNumber !== null) {
        return {
          customer: replayed,
          masked: maskPhoneNumber(replayed.phoneNumber),
          changed: replay.result.changed,
          accepted: replay.result.accepted ?? true,
          resume: null,
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
        /*
         * NEXA v095 PR-4 C: no longer refused while `phone_verification` is off — a payment
         * route's verified-phone rule asks for a number whatever the bot-wide switch says.
         *
         * B: the allowed numbers, read here, in the write's transaction.
         *
         * NEXA v099 (owner): a foreign number under IRAN_ONLY is no longer refused unstored —
         * it is STORED, marked NOT accepted, and never verified (`setNotAcceptedPhone`); the
         * gate stops asking and says why. A customer who already has a VERIFIED number keeps
         * it untouched (B never revokes one): their foreign share is refused as before, with
         * nothing stored.
         */
        const allowed = await this.allowedNumbers(scope, tx);
        const accepted = allowed !== 'IRAN_ONLY' || isIranianPhoneNumber(phone);
        if (!accepted && before.phoneVerifiedAt !== null) {
          throw errors.conflict(
            COMMERCE_ERROR_CODES.PHONE_NOT_IRANIAN,
            'Only Iranian (+98) phone numbers are accepted here.',
          );
        }
        const changed = accepted
          ? await this.deps.customers.setVerifiedPhone(scope, customerId, phone, now, tx)
          : await this.deps.customers.setNotAcceptedPhone(scope, customerId, phone, now, tx);
        const after = await this.deps.customers.findById(scope, customerId, tx);
        if (after === null) {
          throw errors.notFound(COMMERCE_ERROR_CODES.CUSTOMER_NOT_FOUND, 'Unknown customer.');
        }
        // A verification that raced in between this read and the conditional write wins.
        if (!accepted && after.phoneVerifiedAt !== null) {
          throw errors.conflict(
            COMMERCE_ERROR_CODES.PHONE_NOT_IRANIAN,
            'Only Iranian (+98) phone numbers are accepted here.',
          );
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
            // NEXA v099: audited like any share; `accepted: false` is a number stored NOT verified.
            after: { phoneNumber: maskPhoneNumber(phone), changed, accepted },
            result: 'SUCCESS',
          },
          tx,
        );
        // A not-accepted number changes no verification: no event (its payload says `verified`).
        if (changed && accepted) {
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
          { customerId, changed, accepted },
          tx,
        );
        // NEXA v099: nothing resumes behind a not-accepted number — every gate still holds.
        if (!accepted) {
          return {
            customer: after,
            masked: maskPhoneNumber(phone),
            changed,
            accepted,
            resume: null,
          };
        }
        // A/C: the held action, taken in THIS transaction, so it resumes once and only after
        // the number is on the row.
        const held = await this.deps.customers.takePhoneResume(scope, customerId, now, tx);
        const resume =
          held !== null && now.getTime() - held.at.getTime() <= PHONE_RESUME_LIFETIME_MS
            ? held.resume
            : null;
        return { customer: after, masked: maskPhoneNumber(phone), changed, accepted, resume };
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
