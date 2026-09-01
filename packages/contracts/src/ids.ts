import { z } from 'zod';

/**
 * Branded identifiers.
 *
 * Every id is a UUIDv7 generated in the application so that the value exists
 * before the INSERT — the outbox row and the aggregate row are written in the
 * same statement batch and must agree on the id.
 *
 * The brands exist so that a ServiceId cannot be passed where an OrderId is
 * expected. In the legacy system one identity was rendered four different ways
 * (`CON-WEB-008`); an unbranded `string` is how that happens.
 */

declare const brand: unique symbol;

export type Branded<T, B extends string> = T & { readonly [brand]: B };

/** A UUIDv7 string. Time-sortable, non-enumerable. */
export const uuidV7Schema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    'must be a UUIDv7',
  );

function brandedId<B extends string>(_brandName: B) {
  return uuidV7Schema.transform((v) => v as Branded<string, B>);
}

export type TenantId = Branded<string, 'TenantId'>;
export type BotInstanceId = Branded<string, 'BotInstanceId'>;
export type UserId = Branded<string, 'UserId'>;
export type AdminId = Branded<string, 'AdminId'>;
export type OrderId = Branded<string, 'OrderId'>;
export type ServiceId = Branded<string, 'ServiceId'>;
export type PaymentId = Branded<string, 'PaymentId'>;
export type ReceiptId = Branded<string, 'ReceiptId'>;
export type RefundId = Branded<string, 'RefundId'>;
export type WalletEntryId = Branded<string, 'WalletEntryId'>;
export type PanelId = Branded<string, 'PanelId'>;
export type ProductId = Branded<string, 'ProductId'>;
export type EventId = Branded<string, 'EventId'>;
export type OutboxMessageId = Branded<string, 'OutboxMessageId'>;
export type AuditLogId = Branded<string, 'AuditLogId'>;
export type OperationalEventId = Branded<string, 'OperationalEventId'>;
export type CorrelationId = Branded<string, 'CorrelationId'>;
export type RateSnapshotId = Branded<string, 'RateSnapshotId'>;

export const tenantIdSchema = brandedId('TenantId');
export const botInstanceIdSchema = brandedId('BotInstanceId');
export const userIdSchema = brandedId('UserId');
export const adminIdSchema = brandedId('AdminId');
export const orderIdSchema = brandedId('OrderId');
export const serviceIdSchema = brandedId('ServiceId');
export const paymentIdSchema = brandedId('PaymentId');
export const eventIdSchema = brandedId('EventId');
export const correlationIdSchema = brandedId('CorrelationId');

/**
 * Casts a validated string to a branded id. Use only at trust boundaries —
 * after a schema parse, or when reading a column the database guarantees.
 */
export function asId<B extends string>(value: string): Branded<string, B> {
  return value as Branded<string, B>;
}

/**
 * Telegram `callback_data` is capped at 64 bytes by the Bot API. A 36-character
 * UUID would leave only 28 bytes for the route — and Persian flow and step
 * names are multi-byte in UTF-8, so 28 bytes runs out fast. Interactive
 * callbacks therefore carry a short opaque reference that resolves through a
 * registry row, which also keeps ids out of a surface a user can read.
 *
 * 16 base62 characters ≈ 95 bits of entropy, leaving 48 bytes for the route.
 */
export const CALLBACK_REF_LENGTH = 16;
export const callbackRefSchema = z
  .string()
  .regex(new RegExp(`^[0-9A-Za-z]{${CALLBACK_REF_LENGTH}}$`), 'must be a callback reference');
export type CallbackRef = Branded<string, 'CallbackRef'>;

/** The maximum byte length Telegram permits for `callback_data`. */
export const TELEGRAM_CALLBACK_DATA_MAX_BYTES = 64;
