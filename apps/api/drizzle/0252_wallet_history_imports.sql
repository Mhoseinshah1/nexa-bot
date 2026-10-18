CREATE TABLE "wallet_history_imports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"source" text DEFAULT 'MIRZA' NOT NULL,
	"source_ref" text NOT NULL,
	"origin" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"direction" text,
	"amount_minor" bigint NOT NULL,
	"signed_amount_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"raw_kind" text,
	"note" text,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "wallet_history_imports_source_check" CHECK (source = 'MIRZA'),
	CONSTRAINT "wallet_history_imports_origin_check" CHECK (origin IN ('WALLET_TRANSACTION', 'WHEEL_SPIN')),
	CONSTRAINT "wallet_history_imports_direction_check" CHECK (direction IS NULL OR direction IN ('CREDIT', 'DEBIT')),
	CONSTRAINT "wallet_history_imports_currency_check" CHECK (currency IN ('IRT', 'IRR', 'USD', 'EUR', 'USDT')),
	CONSTRAINT "wallet_history_imports_amount_check" CHECK (amount_minor >= 0 AND amount_minor = abs(signed_amount_minor)),
	CONSTRAINT "wallet_history_imports_text_check" CHECK (length(source_ref) BETWEEN 1 AND 128 AND (raw_kind IS NULL OR length(raw_kind) <= 500) AND (note IS NULL OR length(note) <= 500))
);
--> statement-breakpoint
ALTER TABLE "wallet_history_imports" ADD CONSTRAINT "wallet_history_imports_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_history_imports" ADD CONSTRAINT "wallet_history_imports_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_history_imports_tenant_source_ref_key" ON "wallet_history_imports" USING btree ("tenant_id","source_ref");--> statement-breakpoint
CREATE INDEX "wallet_history_imports_customer_idx" ON "wallet_history_imports" USING btree ("tenant_id","customer_id","occurred_at","id");--> statement-breakpoint
-- History is history: a row written by the one-time import is never rewritten or removed.
CREATE TRIGGER wallet_history_imports_no_update
  BEFORE UPDATE ON wallet_history_imports
  FOR EACH ROW EXECUTE FUNCTION nexa_reject_mutation();--> statement-breakpoint
CREATE TRIGGER wallet_history_imports_no_delete
  BEFORE DELETE ON wallet_history_imports
  FOR EACH ROW EXECUTE FUNCTION nexa_reject_mutation();
