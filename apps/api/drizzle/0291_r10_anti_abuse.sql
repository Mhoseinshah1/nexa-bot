CREATE TABLE "customer_captchas" (
	"tenant_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"state" text DEFAULT 'PENDING' NOT NULL,
	"challenge_id" uuid NOT NULL,
	"operand_a" integer NOT NULL,
	"operand_b" integer NOT NULL,
	"options" jsonb NOT NULL,
	"answer_index" integer NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"locked_until" timestamp with time zone,
	"passed_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "customer_captchas_pkey" PRIMARY KEY("tenant_id","customer_id"),
	CONSTRAINT "customer_captchas_state_check" CHECK (state IN ('PENDING', 'PASSED')),
	CONSTRAINT "customer_captchas_answer_index_check" CHECK (answer_index BETWEEN 0 AND 3),
	CONSTRAINT "customer_captchas_options_check" CHECK (jsonb_typeof(options) = 'array' AND jsonb_array_length(options) = 4),
	CONSTRAINT "customer_captchas_attempts_check" CHECK (attempts >= 0),
	CONSTRAINT "customer_captchas_passed_check" CHECK ((state = 'PASSED') = (passed_at IS NOT NULL)),
	CONSTRAINT "customer_captchas_expiry_check" CHECK (expires_at > issued_at)
);
--> statement-breakpoint
ALTER TABLE "order_referral_commissions" ADD COLUMN "not_before" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "customer_captchas" ADD CONSTRAINT "customer_captchas_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_captchas" ADD CONSTRAINT "customer_captchas_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;