-- The subscription reference and the client id become STORED RANDOM values.
--
-- Both were derived from the service id through an unkeyed SHA-256, and the service id
-- is not a secret: it travels in `operational_events.context`, in `audit_logs.entity_id`
-- and in `outbox_messages.aggregate_id`. `provider_username` is a reversible encoding of
-- it, so reading a name off a panel's client list recovered the id and therefore both
-- values — one of which fetches the customer's configuration with no authentication.
--
-- ADDED, BACKFILLED, then CONSTRAINED, in that order, because `ADD COLUMN ... NOT NULL`
-- with no default fails outright on a table that has rows. No installation can have any
-- — nothing shipped has ever written this table — but a migration that is only correct
-- because of that is a migration that fails on the first developer database that does.
ALTER TABLE "services" ADD COLUMN "subscription_ref" text;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "provider_client_id" uuid;--> statement-breakpoint

-- The backfill is deliberately RANDOM, not derived.
--
-- Deriving here would reproduce exactly the defect this migration exists to remove, and
-- any row reached by it predates the release that could deliver a subscription, so no
-- customer holds a link built from the old value.
UPDATE "services"
   SET "subscription_ref" = md5(gen_random_uuid()::text),
       "provider_client_id" = gen_random_uuid()
 WHERE "subscription_ref" IS NULL;--> statement-breakpoint

ALTER TABLE "services" ALTER COLUMN "subscription_ref" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "services" ALTER COLUMN "provider_client_id" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "services_panel_subscription_ref_key" ON "services" USING btree ("panel_id","subscription_ref");--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_subscription_ref_check" CHECK (subscription_ref ~ '^[0-9a-f]{32}$');
