-- WP15 G2, G3, G7 (docs/wp15-provider-hardening-audit.md). Additive columns and checks,
-- plus one partial index widened. The number is TEMPORARY: it is renumbered to the next
-- free slot when this branch is integrated behind #74/#75.
--
-- create_accepted_at   G7: the panel answered THIS create 2xx; the only provenance a
--                      RECONCILE may adopt on. PROVISION rows only.
-- absence_observed_at  G3: this RECONCILE saw the account absent once; a second absence,
--                      a backoff later, is what re-plans a create. RECONCILE rows only.
-- verification_attempts G2: bounded READS of an ambiguous commercial write.
-- open_commercial_key  now counts UNKNOWN as open, so a second purchase cannot be
--                      computed from an allowance a lost write may already have changed.
--                      No commercial row was UNKNOWN before this release (idempotent
--                      mutations failed or re-planned), so the rebuilt index cannot
--                      collide on existing data.
DROP INDEX "provisioning_operations_open_commercial_key";--> statement-breakpoint
ALTER TABLE "provisioning_operations" ADD COLUMN "create_accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "provisioning_operations" ADD COLUMN "absence_observed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "provisioning_operations" ADD COLUMN "verification_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "provisioning_operations_open_commercial_key" ON "provisioning_operations" USING btree ("tenant_id","service_id") WHERE type IN ('RENEW', 'ADD_TRAFFIC', 'ADD_TIME') AND state IN ('PLANNED', 'IN_FLIGHT', 'UNKNOWN');--> statement-breakpoint
ALTER TABLE "provisioning_operations" ADD CONSTRAINT "provisioning_operations_verification_attempts_check" CHECK (verification_attempts >= 0 AND verification_attempts <= 100);--> statement-breakpoint
ALTER TABLE "provisioning_operations" ADD CONSTRAINT "provisioning_operations_create_accepted_check" CHECK (create_accepted_at IS NULL OR type = 'PROVISION');--> statement-breakpoint
ALTER TABLE "provisioning_operations" ADD CONSTRAINT "provisioning_operations_absence_observed_check" CHECK (absence_observed_at IS NULL OR type = 'RECONCILE');