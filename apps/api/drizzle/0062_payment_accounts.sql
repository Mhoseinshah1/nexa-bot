CREATE TABLE "payment_accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"label" text NOT NULL,
	"bank_name" text NOT NULL,
	"holder_name" text NOT NULL,
	"card_number" text NOT NULL,
	"iban" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_accounts_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "payment_accounts_default_enabled_check" CHECK (NOT is_default OR enabled),
	CONSTRAINT "payment_accounts_card_number_check" CHECK (card_number ~ '^[0-9]{16}$'),
	CONSTRAINT "payment_accounts_iban_check" CHECK (iban IS NULL OR iban ~ '^IR[0-9]{24}$'),
	CONSTRAINT "payment_accounts_label_check" CHECK (length(btrim(label)) BETWEEN 1 AND 80),
	CONSTRAINT "payment_accounts_bank_name_check" CHECK (length(btrim(bank_name)) BETWEEN 1 AND 80),
	CONSTRAINT "payment_accounts_holder_name_check" CHECK (length(btrim(holder_name)) BETWEEN 1 AND 120),
	CONSTRAINT "payment_accounts_sort_order_check" CHECK (sort_order BETWEEN 0 AND 100000)
);
--> statement-breakpoint
CREATE TABLE "payment_destinations" (
	"payment_id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"label" text NOT NULL,
	"bank_name" text NOT NULL,
	"holder_name" text NOT NULL,
	"card_number" text NOT NULL,
	"iban" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_destinations_card_number_check" CHECK (card_number ~ '^[0-9]{16}$'),
	CONSTRAINT "payment_destinations_iban_check" CHECK (iban IS NULL OR iban ~ '^IR[0-9]{24}$')
);
--> statement-breakpoint
ALTER TABLE "payment_accounts" ADD CONSTRAINT "payment_accounts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_destinations" ADD CONSTRAINT "payment_destinations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_destinations" ADD CONSTRAINT "payment_destinations_payment_fk" FOREIGN KEY ("tenant_id","payment_id") REFERENCES "public"."payments"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_destinations" ADD CONSTRAINT "payment_destinations_account_fk" FOREIGN KEY ("tenant_id","account_id") REFERENCES "public"."payment_accounts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payment_accounts_tenant_sort_idx" ON "payment_accounts" USING btree ("tenant_id","sort_order","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_accounts_tenant_default_key" ON "payment_accounts" USING btree ("tenant_id") WHERE is_default;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_accounts_tenant_card_key" ON "payment_accounts" USING btree ("tenant_id","card_number") WHERE enabled;--> statement-breakpoint
CREATE INDEX "payment_destinations_account_idx" ON "payment_destinations" USING btree ("tenant_id","account_id");