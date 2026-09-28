import { z } from 'zod';
import { type Branded, uuidV7Schema } from './ids.js';
import { CURRENCY_CODES } from './money.js';

/**
 * Service location change (WP-A6): moving a customer's EXISTING service to another
 * location, as a controlled mutation of the same Nexa service — never a delete and a
 * re-create, and never a rewrite of the service's financial history.
 *
 * ## What a "location" is here, and what V1 refuses
 *
 * Nexa sells from panels, and a panel is the unit a product, a custom-service location
 * and a capacity slot are all tied to. A location change in V1 keeps the account ON ITS
 * PANEL: it moves it between locations that one panel's own management domain holds —
 * the nodes or inbound sets a single panel serves — which is the only form an adapter
 * could make atomic and reconcilable with one absolute write and one read. There is no
 * target-panel column anywhere: a cross-panel or cross-provider move cannot be
 * configured, quoted or planned, rather than being refused at run time.
 *
 * What a location key MEANS is the adapter's: an opaque string the operator copies from
 * their panel and the adapter interprets in `applyLocation` / `readLocation`. Nexa never
 * parses it, never shows it to a customer, and never compares it with anything but
 * another key.
 *
 * ## Unavailable unless configured AND supported
 *
 * A service is offered a change only when BOTH hold: its panel's adapter passes
 * `canChangeLocation` (the declaration AND both methods), and an operator configured an
 * enabled, priced target for it. No row means unavailable — never free. Free is an
 * explicit price of zero.
 */

export type ServiceLocationId = Branded<string, 'ServiceLocationId'>;
export const serviceLocationIdSchema = uuidV7Schema.transform(
  (value) => value as ServiceLocationId,
);

/** The adapter-defined key's longest form. A bound against a paste, not a provider rule. */
export const SERVICE_LOCATION_KEY_MAX_LENGTH = 120;
/** The customer-facing name, as short as the product's own service-location label. */
export const SERVICE_LOCATION_LABEL_MAX_LENGTH = 60;
/** A year. The longest cooldown an operator may configure between two changes. */
export const SERVICE_LOCATION_COOLDOWN_HOURS_MAX = 8760;
/** The most changes a rolling-period limit may allow. */
export const SERVICE_LOCATION_MAX_CHANGES_MAX = 100;
/** The longest rolling period a limit may be counted over. */
export const SERVICE_LOCATION_PERIOD_DAYS_MAX = 365;

// Control characters and line breaks: a key is pasted from a panel, never composed.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;

export const serviceLocationKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(SERVICE_LOCATION_KEY_MAX_LENGTH)
  .refine((value) => !CONTROL_CHARACTERS.test(value), {
    message: 'A location key has no control characters.',
  });

export const serviceLocationLabelSchema = z
  .string()
  .trim()
  .min(1)
  .max(SERVICE_LOCATION_LABEL_MAX_LENGTH)
  .refine((value) => !CONTROL_CHARACTERS.test(value), {
    message: 'A location name has no control characters.',
  });

/**
 * What an operator may limit a location change by. Every field optional; null is "no
 * limit of that kind", and `maxChanges` and `periodDays` come as a pair or not at all.
 */
export interface LocationChangeLimits {
  readonly cooldownHours: number | null;
  readonly maxChanges: number | null;
  readonly periodDays: number | null;
}

export type LocationChangeWindowVerdict =
  { readonly ok: true } | { readonly ok: false; readonly reason: 'COOLDOWN' | 'LIMIT' };

/**
 * Whether one more change may be requested now, from the changes that COUNT.
 *
 * `requestedAt` is the request time of every earlier change of this service that still
 * counts — one awaiting payment, paid and not given back, or free and not failed — read
 * at decision time from the rows, never from a counter, for the reason discount limits
 * have none. Pure, so the verdict is one table a unit test can walk.
 *
 * - The cooldown runs from the LATEST counted request: `now` inside
 *   `[latest, latest + cooldownHours)` is refused.
 * - The limit counts requests inside the half-open window `[now - periodDays, now]`
 *   (a request stamped a moment ahead of this clock still counts), and refuses once
 *   `maxChanges` are there.
 */
export function locationChangeWindow(
  limits: LocationChangeLimits,
  requestedAt: readonly Date[],
  now: Date,
): LocationChangeWindowVerdict {
  const nowMs = now.getTime();
  if (limits.cooldownHours !== null && limits.cooldownHours > 0 && requestedAt.length > 0) {
    const latest = Math.max(...requestedAt.map((at) => at.getTime()));
    if (nowMs < latest + limits.cooldownHours * 3_600_000) {
      return { ok: false, reason: 'COOLDOWN' };
    }
  }
  if (limits.maxChanges !== null && limits.periodDays !== null) {
    const windowStart = nowMs - limits.periodDays * 86_400_000;
    const inWindow = requestedAt.filter((at) => at.getTime() >= windowStart).length;
    if (inWindow >= limits.maxChanges) return { ok: false, reason: 'LIMIT' };
  }
  return { ok: true };
}

/**
 * Whether the location a panel reports holds the absolute target an operation persisted.
 *
 * Equality, and nothing looser: a location is not a quantity a panel can exceed, and an
 * account the panel reports in NO nameable location (`null`) has not reached any target.
 */
export function locationReached(target: string, reported: string | null): boolean {
  return reported !== null && reported === target;
}

// --- Web Admin: the operator's configuration ----------------------------------------

export const SERVICE_LOCATION_ROUTES = {
  list: '/service-locations',
  create: '/service-locations',
  update: (id: string) => `/service-locations/${encodeURIComponent(id)}`,
  remove: (id: string) => `/service-locations/${encodeURIComponent(id)}/delete`,
} as const;

/**
 * One configured location of one panel, as the Web Admin reads it.
 *
 * `initial` marks the location the panel's new accounts are created in, which is how a
 * service that has never moved knows where it is: without it, "the target is where the
 * service already is" cannot be decided, and such a service is offered no change.
 * `enabled` with a price is a TARGET a service may be moved to; a price of zero is free.
 */
export const serviceLocationSummarySchema = z.object({
  id: z.string(),
  panelId: z.string(),
  /** Null is every product on the panel; set, only services of that product. */
  productId: z.string().nullable(),
  locationKey: z.string(),
  label: z.string(),
  initial: z.boolean(),
  enabled: z.boolean(),
  /** Minor units as text. Null: not priced, so not a target. "0" is free. */
  priceAmount: z.string().nullable(),
  priceCurrency: z.enum(CURRENCY_CODES).nullable(),
  cooldownHours: z.number().int().nullable(),
  maxChanges: z.number().int().nullable(),
  periodDays: z.number().int().nullable(),
  sortOrder: z.number().int(),
  /** Bumped on every edit; a change request records the version it was quoted from. */
  version: z.number().int().min(1),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type ServiceLocationSummaryResponse = z.infer<typeof serviceLocationSummarySchema>;

export const serviceLocationListResponseSchema = z.object({
  locations: z.array(serviceLocationSummarySchema),
});
export type ServiceLocationListResponse = z.infer<typeof serviceLocationListResponseSchema>;

export const serviceLocationResponseSchema = z.object({
  location: serviceLocationSummarySchema,
  /** False when the write landed on exactly what was stored. */
  changed: z.boolean(),
});
export type ServiceLocationResponse = z.infer<typeof serviceLocationResponseSchema>;

export const serviceLocationWriteSchema = z
  .object({
    idempotencyKey: z.string().min(8).max(255),
    panelId: uuidV7Schema,
    productId: uuidV7Schema.nullable(),
    locationKey: serviceLocationKeySchema,
    label: serviceLocationLabelSchema,
    initial: z.boolean(),
    enabled: z.boolean(),
    priceAmount: z
      .string()
      .regex(/^\d{1,19}$/u)
      .nullable(),
    priceCurrency: z.enum(CURRENCY_CODES).nullable(),
    cooldownHours: z.number().int().min(1).max(SERVICE_LOCATION_COOLDOWN_HOURS_MAX).nullable(),
    maxChanges: z.number().int().min(1).max(SERVICE_LOCATION_MAX_CHANGES_MAX).nullable(),
    periodDays: z.number().int().min(1).max(SERVICE_LOCATION_PERIOD_DAYS_MAX).nullable(),
    sortOrder: z.number().int().min(0).max(100_000),
  })
  .refine((a) => (a.priceAmount === null) === (a.priceCurrency === null), {
    message: 'A price is an amount and a currency, or it is absent.',
    path: ['priceAmount'],
  })
  .refine((a) => !a.enabled || a.priceAmount !== null, {
    message: 'An enabled location needs a price. Zero is free; empty is not for sale.',
    path: ['priceAmount'],
  })
  .refine((a) => (a.maxChanges === null) === (a.periodDays === null), {
    message: 'A limit is a number of changes over a number of days, or it is absent.',
    path: ['maxChanges'],
  })
  .refine((a) => !a.initial || a.productId === null, {
    message: 'The initial location belongs to the whole panel, not to one product.',
    path: ['initial'],
  });
export type ServiceLocationWriteRequest = z.infer<typeof serviceLocationWriteSchema>;

export const serviceLocationDeleteSchema = z.object({
  idempotencyKey: z.string().min(8).max(255),
});
export type ServiceLocationDeleteRequest = z.infer<typeof serviceLocationDeleteSchema>;
