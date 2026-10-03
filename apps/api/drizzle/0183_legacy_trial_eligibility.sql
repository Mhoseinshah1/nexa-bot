CREATE TABLE "legacy_trial_eligibility" (
	"tenant_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"legacy_limit_usertest" integer,
	"legacy_had_trial" boolean NOT NULL,
	"decision" text NOT NULL,
	"override_before" integer,
	"override_after" integer,
	"input_hash" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "legacy_trial_eligibility_pkey" PRIMARY KEY("tenant_id","customer_id"),
	CONSTRAINT "legacy_trial_eligibility_decision_check" CHECK (decision IN ('LEGACY_NO_TRIALS', 'LEGACY_TRIAL_CONSUMED', 'LEGACY_LIMIT_UNREADABLE', 'INHERIT_NEXA_POLICY', 'KEPT_EXISTING_OVERRIDE')),
	CONSTRAINT "legacy_trial_eligibility_effect_check" CHECK ((decision IN ('LEGACY_NO_TRIALS', 'LEGACY_TRIAL_CONSUMED', 'LEGACY_LIMIT_UNREADABLE')
            AND override_before IS NULL AND override_after = 0)
       OR (decision = 'INHERIT_NEXA_POLICY' AND override_before IS NULL AND override_after IS NULL)
       OR (decision = 'KEPT_EXISTING_OVERRIDE'
            AND override_before IS NOT NULL AND override_after = override_before)),
	CONSTRAINT "legacy_trial_eligibility_limit_check" CHECK (decision = 'KEPT_EXISTING_OVERRIDE'
       OR (decision = 'LEGACY_LIMIT_UNREADABLE') = (legacy_limit_usertest IS NULL)),
	CONSTRAINT "legacy_trial_eligibility_hash_check" CHECK (input_hash ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "legacy_trial_eligibility" ADD CONSTRAINT "legacy_trial_eligibility_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legacy_trial_eligibility" ADD CONSTRAINT "legacy_trial_eligibility_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "legacy_trial_eligibility_tenant_decision_idx" ON "legacy_trial_eligibility" USING btree ("tenant_id","decision","customer_id");