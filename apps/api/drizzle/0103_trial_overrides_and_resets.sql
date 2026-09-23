CREATE TABLE "trial_limit_overrides" (
	"tenant_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"trial_limit" integer NOT NULL,
	"set_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trial_limit_overrides_pkey" PRIMARY KEY("tenant_id","customer_id"),
	CONSTRAINT "trial_limit_overrides_limit_check" CHECK (trial_limit >= 0 AND trial_limit <= 100)
);
--> statement-breakpoint
CREATE TABLE "trial_resets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"actor_admin_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"affected_grants" integer NOT NULL,
	"affected_customers" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trial_resets_counts_check" CHECK (affected_grants > 0 AND affected_customers > 0 AND affected_customers <= affected_grants),
	CONSTRAINT "trial_resets_reason_check" CHECK (length(btrim(reason)) > 0)
);
--> statement-breakpoint
DROP INDEX "trial_grants_customer_counting_idx";--> statement-breakpoint
ALTER TABLE "trial_grants" ADD COLUMN "reset_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "trial_grants" ADD COLUMN "reset_id" uuid;--> statement-breakpoint
ALTER TABLE "trial_limit_overrides" ADD CONSTRAINT "trial_limit_overrides_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trial_limit_overrides" ADD CONSTRAINT "trial_limit_overrides_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trial_resets" ADD CONSTRAINT "trial_resets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trial_resets" ADD CONSTRAINT "trial_resets_actor_fk" FOREIGN KEY ("tenant_id","actor_admin_id") REFERENCES "public"."admins"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "trial_limit_overrides_tenant_set_idx" ON "trial_limit_overrides" USING btree ("tenant_id","set_at","customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "trial_resets_tenant_id_key" ON "trial_resets" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE INDEX "trial_resets_tenant_created_idx" ON "trial_resets" USING btree ("tenant_id","created_at","id");--> statement-breakpoint
ALTER TABLE "trial_grants" ADD CONSTRAINT "trial_grants_reset_fk" FOREIGN KEY ("tenant_id","reset_id") REFERENCES "public"."trial_resets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "trial_grants_counting_idx" ON "trial_grants" USING btree ("tenant_id","customer_id") WHERE released_at IS NULL AND reset_at IS NULL;--> statement-breakpoint
ALTER TABLE "trial_grants" ADD CONSTRAINT "trial_grants_reset_pair_check" CHECK ((reset_at IS NULL) = (reset_id IS NULL));