-- The subscription reference and the client id become STORED RANDOM values.
--
-- Both were derived from the service id through an unkeyed SHA-256, and the service id
-- is not a secret: it travels in `operational_events.context`, in `audit_logs.entity_id`
-- and in `outbox_messages.aggregate_id`. `provider_username` is a reversible encoding of
-- it, so reading a name off a panel's client list recovered the id and therefore both
-- values — one of which fetches the customer's configuration with no authentication.
--
-- Added WITH A RANDOM DEFAULT rather than with a later `SET NOT NULL`, because
-- `migration-compatibility.test.ts` forbids narrowing what the release before this one
-- can write. A release rolled back onto this schema keeps inserting into `services`, and
-- any row it writes gets a distinct unguessable value rather than a null or a shared
-- sentinel. Nothing in THIS release relies on the default: `ServiceDraft` requires both.
--
-- The default is deliberately volatile. A constant would give every backfilled row the
-- same subscription reference, which the unique index below would refuse on the second
-- row and which would be a shared capability if it did not.
ALTER TABLE "services" ADD COLUMN "subscription_ref" text DEFAULT md5(gen_random_uuid()::text) NOT NULL;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "provider_client_id" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "services_panel_subscription_ref_key" ON "services" USING btree ("panel_id","subscription_ref");--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_subscription_ref_check" CHECK (subscription_ref ~ '^[0-9a-f]{32}$');