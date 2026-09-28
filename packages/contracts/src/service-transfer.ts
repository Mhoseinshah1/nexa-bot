import { z } from 'zod';

/**
 * Package F — a customer hands one of their own services to another customer of the same
 * tenant (`docs/package-f-service-transfer-audit.md`).
 *
 * Ownership moves; nothing else does. The order stays the payer's, the payment, the wallet,
 * cashback and referral commission stay where they were written, the provider account is
 * not touched, and the customer's own note is cleared. The owner's rule (brief Package F),
 * stated once here so no caller re-derives it.
 */

/**
 * Why a RECIPIENT cannot be given the service. A closed set.
 *
 * - `RECIPIENT_INVALID` — the typed text is not a Telegram numeric id at all.
 * - `RECIPIENT_UNKNOWN` — no customer of THIS tenant has that id. A customer of another
 *   tenant is exactly as unknown, so a transfer can never cross a tenant.
 * - `RECIPIENT_SELF` — the id is the sender's own.
 * - `RECIPIENT_BLOCKED` — the recipient is `BLOCKED`, so they could not manage what they
 *   were given.
 *
 * The customer is told `RECIPIENT_UNKNOWN` and `RECIPIENT_BLOCKED` in ONE sentence: telling
 * them apart would tell a stranger which Telegram accounts an operator has blocked.
 */
export const SERVICE_TRANSFER_RECIPIENT_REFUSALS = [
  'RECIPIENT_INVALID',
  'RECIPIENT_UNKNOWN',
  'RECIPIENT_SELF',
  'RECIPIENT_BLOCKED',
] as const;
export type ServiceTransferRecipientRefusal = (typeof SERVICE_TRANSFER_RECIPIENT_REFUSALS)[number];
export const serviceTransferRecipientRefusalSchema = z.enum(SERVICE_TRANSFER_RECIPIENT_REFUSALS);

/**
 * Why a SERVICE cannot change hands right now (audit §4). Each is decided again under the
 * service's row lock and its lifecycle lock at confirmation; the button is a courtesy.
 *
 * - `SERVICE_STATE` — not `ACTIVE` or `SUSPENDED` (`SERVICE_TRANSFERABLE_STATES`).
 * - `NOT_DELIVERED` — the subscription has not been DELIVERED. A link still on its way
 *   would reach whoever owns the service when the send is retried.
 * - `OPERATION_PENDING` — a provisioning operation on it is undecided (`PLANNED`,
 *   `IN_FLIGHT` or `UNKNOWN`), other than a SCHEDULED usage read. A paid renewal or add-on
 *   not yet applied, a suspend, resume or rotation on its way, a terminate an operator
 *   planned, and a usage read the sender asked for — whose outcome is announced to
 *   whoever owns the service when it ends.
 * - `REFUND_REQUESTED` — a refund request on it is `OPEN` or `EXECUTING`.
 * - `PAYMENT_PENDING` — a commercial order for it is `AWAITING_PAYMENT`: the sender may be
 *   paying for it right now.
 * - `TRIAL` — the service came from a free trial, which counts against the claimant's own
 *   allowance and does not move.
 * - `CONFIRMATION_STALE` — the confirmation was made before the service last changed hands.
 *   Telegram leaves an old keyboard tappable, so a sender who gave a service away and was
 *   given it back could otherwise re-send it from a screen that predates both. Decided only
 *   at confirmation, against the ownership version the confirmation carries.
 */
export const SERVICE_TRANSFER_INELIGIBILITY_REASONS = [
  'SERVICE_STATE',
  'NOT_DELIVERED',
  'OPERATION_PENDING',
  'REFUND_REQUESTED',
  'PAYMENT_PENDING',
  'TRIAL',
  'CONFIRMATION_STALE',
] as const;
export type ServiceTransferIneligibilityReason =
  (typeof SERVICE_TRANSFER_INELIGIBILITY_REASONS)[number];
export const serviceTransferIneligibilityReasonSchema = z.enum(
  SERVICE_TRANSFER_INELIGIBILITY_REASONS,
);

/**
 * Every answer a transfer can be refused with, as one closed set: the four about the
 * recipient, and `SERVICE_NOT_TRANSFERABLE` for every reason about the service. An unknown
 * or foreign service is `SERVICE_NOT_FOUND`, never one of these, so the refusal is not an
 * oracle for another customer's service ids.
 */
export const SERVICE_TRANSFER_REFUSALS = [
  ...SERVICE_TRANSFER_RECIPIENT_REFUSALS,
  'SERVICE_NOT_TRANSFERABLE',
] as const;
export type ServiceTransferRefusal = (typeof SERVICE_TRANSFER_REFUSALS)[number];

/** The service states a transfer may start from. The brief names both. */
export const SERVICE_TRANSFERABLE_STATES = ['ACTIVE', 'SUSPENDED'] as const;
