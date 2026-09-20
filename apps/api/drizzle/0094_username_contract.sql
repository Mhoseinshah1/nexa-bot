/*
 * The universal username contract, forward.
 *
 * Three shapes change at once and the ORDER below is the whole safety of this file:
 * every constraint is dropped or deferred until the rows it judges have been
 * backfilled. Adding `panels_username_prefix_check` before the backfill would fail on
 * the first existing panel, because `username_strategy` defaults to PREFIX_RANDOM and
 * its prefix is not written until two statements later.
 *
 * ## Why the backfill may be assertive about `username_template`
 *
 * `username_template`, `allow_random_username` and `service_username_reservations`
 * were all introduced by 0088, which is on this branch and has never been in a
 * release. No deployed installation has written any of them, so the only rows a
 * template can exist on are development and test rows — written against a grammar
 * (`{customer_id}`, `{order_id}`, a 34-character ceiling) that this release removed.
 *
 * Keeping them would be worse than clearing them: a template that no longer validates
 * would leave the panel on CUSTOM_TEMPLATE with an unusable generator, refusing every
 * automatic purchase until an operator noticed, and blocking unrelated edits to the
 * same panel in the meantime. They are cleared, and the panel falls to the default
 * preset — `nx` plus ten random characters — which is what a panel that has never been
 * configured should do.
 *
 * Provisioned services are NOT touched by any statement here. Their
 * `provider_username` keeps whatever length it has; this contract binds names being
 * minted and nothing else.
 */
ALTER TABLE "panels" RENAME COLUMN "allow_random_username" TO "allow_automatic_username";--> statement-breakpoint
ALTER TABLE "panels" DROP CONSTRAINT "panels_username_policy_check";--> statement-breakpoint
ALTER TABLE "service_username_reservations" DROP CONSTRAINT "service_username_reservations_mode_check";--> statement-breakpoint
ALTER TABLE "panels" ADD COLUMN "username_strategy" text DEFAULT 'PREFIX_RANDOM' NOT NULL;--> statement-breakpoint
ALTER TABLE "panels" ADD COLUMN "username_prefix" text;--> statement-breakpoint
/* Pre-contract templates, cleared for the reason the header states. */
UPDATE "panels" SET "username_template" = NULL WHERE "username_template" IS NOT NULL;--> statement-breakpoint
/* Every panel onto the default preset, with the prefix its check constraint requires. */
UPDATE "panels" SET "username_prefix" = 'nx' WHERE "username_strategy" = 'PREFIX_RANDOM';--> statement-breakpoint
/* RANDOM was the mode; it is now one of four presets, and the mode is AUTOMATIC. */
UPDATE "service_username_reservations" SET "mode" = 'AUTOMATIC' WHERE "mode" = 'RANDOM';--> statement-breakpoint
ALTER TABLE "panels" ADD CONSTRAINT "panels_username_strategy_check" CHECK (username_strategy IN ('RANDOM', 'PREFIX_RANDOM', 'TELEGRAM_ID_RANDOM', 'CUSTOM_TEMPLATE'));--> statement-breakpoint
ALTER TABLE "panels" ADD CONSTRAINT "panels_username_prefix_check" CHECK (("panels"."username_strategy" = 'PREFIX_RANDOM') = ("panels"."username_prefix" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "panels" ADD CONSTRAINT "panels_username_template_check" CHECK (("panels"."username_strategy" = 'CUSTOM_TEMPLATE') = ("panels"."username_template" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "panels" ADD CONSTRAINT "panels_username_policy_check" CHECK ("panels"."allow_custom_username" OR "panels"."allow_automatic_username");--> statement-breakpoint
ALTER TABLE "service_username_reservations" ADD CONSTRAINT "service_username_reservations_mode_check" CHECK (mode IN ('CUSTOM', 'AUTOMATIC'));
