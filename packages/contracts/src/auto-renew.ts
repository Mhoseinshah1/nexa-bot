import { z } from 'zod';

/**
 * Round 10, D1 — automatic renewal («تمدید خودکار»).
 *
 * A customer opts ONE of their services in, from the bot's service screen or the mini app.
 * Shortly before that service expires — `auto_renew.lead_hours` before its deadline — the
 * worker renews it through the customer's own renewal: the same RENEW draft, the same
 * `PricingService.price` quote, the same confirmation and the same `PURCHASE` debit of the
 * wallet that a tap on «💊 تمدید سرویس» → «پرداخت از کیف پول» makes. There is no second money
 * path; the only new state is the customer's consent and one run row per service per period.
 *
 * The rules this file names, stated once:
 *
 * - Off by default (`service_auto_renew`), switchable from the Web Admin. Off stops new runs
 *   at once: the flag is read inside every run's own transactions, and an opted-in service is
 *   simply not renewed while it is off.
 * - The consent is the OWNER's: it records the customer who gave it, a transfer of the service
 *   clears it, and a run renews only while the service still belongs to that customer.
 * - The consent carries the renewal total the customer was shown when they switched it on. A
 *   quote above it is NOT renewed (`PRICE_ROSE`) and the customer is told once.
 * - A wallet that does not cover the renewal is told ONCE per period
 *   (`SERVICE_AUTO_RENEW_FUNDS_SHORT`); no order is created for money that is not there.
 * - One run per (service, period): a period is the deadline the run was claimed against, and
 *   `service_auto_renew_runs` is unique on it. The run's id derives every idempotency key the
 *   renewal's commands take, so a retried or concurrent pass replays rather than repeats.
 * - Imported (Mirza) services are not offered it in this release: their renewal is a panel plan
 *   the customer chooses at the time (`OQ-R10-D1-01`).
 */

/** The lead time's bounds, in hours: at least one sweep interval, at most a week. */
export const AUTO_RENEW_LEAD_HOURS_MIN = 1;
export const AUTO_RENEW_LEAD_HOURS_MAX = 168;
export const AUTO_RENEW_LEAD_HOURS_DEFAULT = 24;

/**
 * Where one run of one period is.
 *
 * - `CLAIMED` — a pass has claimed the period and is renewing it. A claim whose lease lapsed
 *   (the worker stopped mid-run) is taken over by a later pass, which replays the SAME keys.
 * - `RENEWED` — the renewal order was paid from the wallet. Written in the settling
 *   transaction itself, so a debit and this state commit together or not at all. Final.
 * - `FUNDS_SHORT` — the wallet did not cover the quote. The customer was told once; a later
 *   pass of the same period renews it if the wallet has since been topped up.
 * - `REFUSED` — the period is not renewed automatically, for the reason in `refusal`. Final.
 */
export const AUTO_RENEW_RUN_STATES = ['CLAIMED', 'RENEWED', 'FUNDS_SHORT', 'REFUSED'] as const;
export type AutoRenewRunState = (typeof AUTO_RENEW_RUN_STATES)[number];
export const autoRenewRunStateSchema = z.enum(AUTO_RENEW_RUN_STATES);

/**
 * Why a period was not renewed automatically. A closed set.
 *
 * - `PRICE_ROSE` — the renewal now costs more than the total the customer consented to. The
 *   customer is told once (`SERVICE_AUTO_RENEW_PRICE_CHANGED`) and renews by hand if they wish.
 * - `CONSENT_WITHDRAWN` — the switch or the customer's consent went off while the run was in
 *   flight; decided again inside the settling transaction, so nothing was debited.
 * - `NOT_RENEWABLE` — the renewal itself refused: the product withdrawn, the panel unable or
 *   switched off for renewals, the service no longer in a renewable state, a reseller tier
 *   that no longer grants it, a negative wallet. Nothing was debited; the customer is not sent
 *   an extra message and the ordinary expiry reminders still speak.
 */
export const AUTO_RENEW_REFUSALS = ['PRICE_ROSE', 'CONSENT_WITHDRAWN', 'NOT_RENEWABLE'] as const;
export type AutoRenewRefusal = (typeof AUTO_RENEW_REFUSALS)[number];
export const autoRenewRefusalSchema = z.enum(AUTO_RENEW_REFUSALS);

/** Where a customer's consent was last changed from. */
export const AUTO_RENEW_PREFERENCE_SOURCES = ['TELEGRAM', 'MINI_APP', 'TRANSFER'] as const;
export type AutoRenewPreferenceSource = (typeof AUTO_RENEW_PREFERENCE_SOURCES)[number];
