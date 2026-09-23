CREATE TABLE "order_referral_commissions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"referral_id" uuid NOT NULL,
	"referrer_id" uuid NOT NULL,
	"referee_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"percent" integer NOT NULL,
	"basis_amount" bigint NOT NULL,
	"amount" bigint NOT NULL,
	"currency" text NOT NULL,
	"state" text DEFAULT 'PENDING' NOT NULL,
	"earned_amount" bigint,
	"earned_entry_id" uuid,
	"earned_at" timestamp with time zone,
	"voided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_referral_commissions_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "order_referral_commissions_state_check" CHECK (state IN ('PENDING', 'EARNED', 'VOID')),
	CONSTRAINT "order_referral_commissions_scope_check" CHECK (scope IN ('FIRST_PAID_ORDER', 'EVERY_PAID_ORDER')),
	CONSTRAINT "order_referral_commissions_currency_check" CHECK (currency IN ('IRT', 'IRR', 'USD', 'EUR', 'USDT')),
	CONSTRAINT "order_referral_commissions_amount_check" CHECK (amount > 0 AND amount <= basis_amount),
	CONSTRAINT "order_referral_commissions_percent_check" CHECK (percent BETWEEN 1 AND 100),
	CONSTRAINT "order_referral_commissions_parties_check" CHECK (referrer_id <> referee_id),
	CONSTRAINT "order_referral_commissions_earned_check" CHECK ((state = 'EARNED') = (earned_at IS NOT NULL) AND (state = 'EARNED') = (earned_amount IS NOT NULL) AND (earned_amount IS NULL OR (earned_amount >= 0 AND earned_amount <= amount))),
	CONSTRAINT "order_referral_commissions_entry_check" CHECK ((earned_entry_id IS NOT NULL) = (earned_amount IS NOT NULL AND earned_amount > 0)),
	CONSTRAINT "order_referral_commissions_void_check" CHECK ((state = 'VOID') = (voided_at IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "referral_codes" (
	"tenant_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"code" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "referral_codes_pkey" PRIMARY KEY("tenant_id","customer_id"),
	CONSTRAINT "referral_codes_code_check" CHECK (code ~ '^[0-9A-HJKMNP-TV-Z]{8}$')
);
--> statement-breakpoint
CREATE TABLE "referral_commission_reversals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"commission_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"referrer_id" uuid NOT NULL,
	"refund_id" uuid NOT NULL,
	"due_amount" bigint NOT NULL,
	"recovered_amount" bigint NOT NULL,
	"unrecovered_amount" bigint NOT NULL,
	"currency" text NOT NULL,
	"wallet_entry_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "referral_commission_reversals_currency_check" CHECK (currency IN ('IRT', 'IRR', 'USD', 'EUR', 'USDT')),
	CONSTRAINT "referral_commission_reversals_amounts_check" CHECK (due_amount > 0 AND recovered_amount >= 0 AND unrecovered_amount >= 0 AND due_amount = recovered_amount + unrecovered_amount),
	CONSTRAINT "referral_commission_reversals_entry_check" CHECK ((wallet_entry_id IS NOT NULL) = (recovered_amount > 0))
);
--> statement-breakpoint
ALTER TABLE "referrals" DROP CONSTRAINT "referrals_trigger_check";--> statement-breakpoint
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_tenant_id_key" UNIQUE("tenant_id","id");--> statement-breakpoint
ALTER TABLE "order_referral_commissions" ADD CONSTRAINT "order_referral_commissions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_referral_commissions" ADD CONSTRAINT "order_referral_commissions_order_fk" FOREIGN KEY ("tenant_id","order_id","referee_id") REFERENCES "public"."orders"("tenant_id","id","customer_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_referral_commissions" ADD CONSTRAINT "order_referral_commissions_referral_fk" FOREIGN KEY ("tenant_id","referral_id") REFERENCES "public"."referrals"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_referral_commissions" ADD CONSTRAINT "order_referral_commissions_referrer_fk" FOREIGN KEY ("tenant_id","referrer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_referral_commissions" ADD CONSTRAINT "order_referral_commissions_earned_entry_fk" FOREIGN KEY ("tenant_id","earned_entry_id") REFERENCES "public"."wallet_entries"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_codes" ADD CONSTRAINT "referral_codes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_codes" ADD CONSTRAINT "referral_codes_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_commission_reversals" ADD CONSTRAINT "referral_commission_reversals_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_commission_reversals" ADD CONSTRAINT "referral_commission_reversals_commission_fk" FOREIGN KEY ("tenant_id","commission_id") REFERENCES "public"."order_referral_commissions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_commission_reversals" ADD CONSTRAINT "referral_commission_reversals_referrer_fk" FOREIGN KEY ("tenant_id","referrer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_commission_reversals" ADD CONSTRAINT "referral_commission_reversals_refund_fk" FOREIGN KEY ("tenant_id","refund_id") REFERENCES "public"."refunds"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_commission_reversals" ADD CONSTRAINT "referral_commission_reversals_entry_fk" FOREIGN KEY ("tenant_id","wallet_entry_id") REFERENCES "public"."wallet_entries"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "order_referral_commissions_tenant_order_key" ON "order_referral_commissions" USING btree ("tenant_id","order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "order_referral_commissions_first_earned_key" ON "order_referral_commissions" USING btree ("tenant_id","referral_id") WHERE state = 'EARNED' AND scope = 'FIRST_PAID_ORDER';--> statement-breakpoint
CREATE INDEX "order_referral_commissions_pending_idx" ON "order_referral_commissions" USING btree ("tenant_id","created_at","id") WHERE state = 'PENDING';--> statement-breakpoint
CREATE INDEX "order_referral_commissions_tenant_created_idx" ON "order_referral_commissions" USING btree ("tenant_id","created_at","id");--> statement-breakpoint
CREATE INDEX "order_referral_commissions_tenant_referrer_idx" ON "order_referral_commissions" USING btree ("tenant_id","referrer_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "referral_codes_tenant_code_key" ON "referral_codes" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "referral_commission_reversals_tenant_refund_key" ON "referral_commission_reversals" USING btree ("tenant_id","refund_id");--> statement-breakpoint
CREATE INDEX "referral_commission_reversals_commission_idx" ON "referral_commission_reversals" USING btree ("tenant_id","commission_id");--> statement-breakpoint
CREATE INDEX "referrals_tenant_created_idx" ON "referrals" USING btree ("tenant_id","created_at","id");--> statement-breakpoint
CREATE INDEX "referrals_tenant_referrer_idx" ON "referrals" USING btree ("tenant_id","referrer_id","created_at","id");--> statement-breakpoint
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_trigger_check" CHECK (trigger IN ('ON_SIGNUP', 'ON_FIRST_PAID_ORDER', 'ON_EVERY_PAID_ORDER'));