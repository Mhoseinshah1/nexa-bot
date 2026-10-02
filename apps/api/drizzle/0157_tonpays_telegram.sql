-- TonPays Telegram (`docs/tonpays-telegram-gateway-audit.md` §7, P1).
--
-- Additive: the provider roster widened on five tables (0127's shape), the card-transfer
-- columns and CHECKs on `gateway_invoices`, four new tables (card history, card-change
-- requests, receipt capture windows, receipt submissions), the two provider-NEUTRAL review
-- timestamps on `payments` with their row-local CHECK and index, the confirmation guard
-- extended to freeze them, an append-only guard on the card history, and the
-- `payments.reconcile` backfill for the seeded roles that already exist. No money data is
-- written, no Persian text, no balance.
--
-- ROLLBACK NOTE. The previous release reads a TONPAYS_TELEGRAM row as a provider it has no
-- adapter for and offers nothing. It does NOT know `provider_review_until`: rolling back
-- while any payment is in provider review lets its `expireDue` expire that payment at its
-- 70-minute deadline, and a later approval is LATE_COMPLETION — recorded, nothing moved, but
-- the customer is told PAYMENT_EXPIRED about a receipt TonPays is reviewing. Before a
-- rollback, read:
--   SELECT count(*) FROM payments WHERE state = 'PENDING' AND provider_review_until IS NOT NULL;
-- `botctl rollback` never restores the database (CLAUDE.md).
CREATE TABLE "gateway_card_changes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"bot_instance_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"state" text NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"claimed_until" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"error_code" text,
	"idempotency_key" text NOT NULL,
	CONSTRAINT "gateway_card_changes_state_check" CHECK (state IN ('REQUESTED', 'SENT', 'APPLIED', 'REFUSED', 'RATE_LIMITED', 'UNKNOWN')),
	CONSTRAINT "gateway_card_changes_decided_check" CHECK ((state IN ('REQUESTED', 'SENT')) = (decided_at IS NULL) AND (state <> 'SENT' OR sent_at IS NOT NULL) AND (state <> 'REQUESTED' OR sent_at IS NULL)),
	CONSTRAINT "gateway_card_changes_error_code_check" CHECK (error_code IS NULL OR length(error_code) BETWEEN 1 AND 64)
);
--> statement-breakpoint
CREATE TABLE "gateway_invoice_cards" (
	"tenant_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"card_number" text NOT NULL,
	"card_name" text,
	"source" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	CONSTRAINT "gateway_invoice_cards_tenant_id_payment_id_seq_pk" PRIMARY KEY("tenant_id","payment_id","seq"),
	CONSTRAINT "gateway_invoice_cards_source_check" CHECK (source IN ('CREATE', 'CHANGE_CARD')),
	CONSTRAINT "gateway_invoice_cards_bounds_check" CHECK (seq >= 1 AND length(card_number) BETWEEN 1 AND 64 AND (card_name IS NULL OR length(card_name) BETWEEN 1 AND 128))
);
--> statement-breakpoint
CREATE TABLE "gateway_receipt_captures" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"bot_instance_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_invoice_id" text NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	"close_reason" text,
	CONSTRAINT "gateway_receipt_captures_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "gateway_receipt_captures_provider_check" CHECK (provider = 'TONPAYS_TELEGRAM'),
	CONSTRAINT "gateway_receipt_captures_close_reason_check" CHECK (close_reason IS NULL OR close_reason IN ('RECEIVED', 'SUPERSEDED', 'EXPIRED', 'PAYMENT_CLOSED')),
	CONSTRAINT "gateway_receipt_captures_closed_check" CHECK ((closed_at IS NULL) = (close_reason IS NULL)),
	CONSTRAINT "gateway_receipt_captures_expiry_check" CHECK (expires_at > opened_at)
);
--> statement-breakpoint
CREATE TABLE "gateway_receipt_submissions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"provider_invoice_id" text NOT NULL,
	"bot_instance_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"capture_id" uuid NOT NULL,
	"telegram_file_id" text NOT NULL,
	"telegram_file_unique_id" text NOT NULL,
	"declared_size" bigint,
	"state" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"claimed_until" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"retry_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"error_code" text,
	"provider_status" text,
	"receipt_received" boolean,
	"opened_review" boolean DEFAULT false NOT NULL,
	"inquiry_resolved_at" timestamp with time zone,
	"byte_length" integer,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "gateway_receipt_submissions_state_check" CHECK (state IN ('QUEUED', 'SENDING', 'ACCEPTED', 'REFUSED', 'UNKNOWN', 'ABANDONED')),
	CONSTRAINT "gateway_receipt_submissions_decided_check" CHECK ((state IN ('QUEUED', 'SENDING')) = (decided_at IS NULL) AND (state <> 'SENDING' OR sent_at IS NOT NULL) AND (NOT opened_review OR state = 'ACCEPTED')),
	CONSTRAINT "gateway_receipt_submissions_bounds_check" CHECK (attempts >= 0 AND (byte_length IS NULL OR byte_length >= 0) AND (declared_size IS NULL OR declared_size > 0) AND (error_code IS NULL OR length(error_code) BETWEEN 1 AND 64) AND (provider_status IS NULL OR length(provider_status) BETWEEN 1 AND 32) AND length(telegram_file_unique_id) BETWEEN 1 AND 255 AND length(telegram_file_id) BETWEEN 1 AND 1024)
);
--> statement-breakpoint
ALTER TABLE "gateway_invoices" DROP CONSTRAINT "gateway_invoices_provider_check";--> statement-breakpoint
ALTER TABLE "payment_gateway_call_budgets" DROP CONSTRAINT "payment_gateway_call_budgets_provider_check";--> statement-breakpoint
ALTER TABLE "payment_gateway_credentials" DROP CONSTRAINT "payment_gateway_credentials_provider_check";--> statement-breakpoint
ALTER TABLE "payment_gateways" DROP CONSTRAINT "payment_gateways_provider_check";--> statement-breakpoint
ALTER TABLE "payments" DROP CONSTRAINT "payments_gateway_provider_check";--> statement-breakpoint
ALTER TABLE "gateway_invoices" ADD COLUMN "card_number" text;--> statement-breakpoint
ALTER TABLE "gateway_invoices" ADD COLUMN "card_name" text;--> statement-breakpoint
ALTER TABLE "gateway_invoices" ADD COLUMN "card_seq" integer;--> statement-breakpoint
ALTER TABLE "gateway_invoices" ADD COLUMN "card_received_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "gateway_invoices" ADD COLUMN "card_change_shown" boolean;--> statement-breakpoint
ALTER TABLE "gateway_invoices" ADD COLUMN "card_change_cooldown_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "gateway_invoices" ADD COLUMN "card_change_exhausted" boolean;--> statement-breakpoint
ALTER TABLE "gateway_invoices" ADD COLUMN "reconcile_inquiry_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "provider_review_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "provider_review_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "gateway_card_changes" ADD CONSTRAINT "gateway_card_changes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gateway_card_changes" ADD CONSTRAINT "gateway_card_changes_bot_instance_id_bot_instances_id_fk" FOREIGN KEY ("bot_instance_id") REFERENCES "public"."bot_instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gateway_card_changes" ADD CONSTRAINT "gateway_card_changes_payment_fk" FOREIGN KEY ("tenant_id","payment_id") REFERENCES "public"."payments"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gateway_card_changes" ADD CONSTRAINT "gateway_card_changes_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gateway_invoice_cards" ADD CONSTRAINT "gateway_invoice_cards_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gateway_invoice_cards" ADD CONSTRAINT "gateway_invoice_cards_payment_fk" FOREIGN KEY ("tenant_id","payment_id") REFERENCES "public"."payments"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gateway_receipt_captures" ADD CONSTRAINT "gateway_receipt_captures_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gateway_receipt_captures" ADD CONSTRAINT "gateway_receipt_captures_bot_instance_id_bot_instances_id_fk" FOREIGN KEY ("bot_instance_id") REFERENCES "public"."bot_instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gateway_receipt_captures" ADD CONSTRAINT "gateway_receipt_captures_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gateway_receipt_captures" ADD CONSTRAINT "gateway_receipt_captures_payment_fk" FOREIGN KEY ("tenant_id","payment_id") REFERENCES "public"."payments"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gateway_receipt_submissions" ADD CONSTRAINT "gateway_receipt_submissions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gateway_receipt_submissions" ADD CONSTRAINT "gateway_receipt_submissions_bot_instance_id_bot_instances_id_fk" FOREIGN KEY ("bot_instance_id") REFERENCES "public"."bot_instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gateway_receipt_submissions" ADD CONSTRAINT "gateway_receipt_submissions_payment_fk" FOREIGN KEY ("tenant_id","payment_id") REFERENCES "public"."payments"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gateway_receipt_submissions" ADD CONSTRAINT "gateway_receipt_submissions_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gateway_receipt_submissions" ADD CONSTRAINT "gateway_receipt_submissions_capture_fk" FOREIGN KEY ("tenant_id","capture_id") REFERENCES "public"."gateway_receipt_captures"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "gateway_card_changes_in_flight_key" ON "gateway_card_changes" USING btree ("tenant_id","payment_id") WHERE state IN ('REQUESTED', 'SENT');--> statement-breakpoint
CREATE UNIQUE INDEX "gateway_card_changes_idempotency_key" ON "gateway_card_changes" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "gateway_card_changes_due_idx" ON "gateway_card_changes" USING btree ("tenant_id","requested_at") WHERE state IN ('REQUESTED', 'SENT');--> statement-breakpoint
CREATE INDEX "gateway_card_changes_payment_idx" ON "gateway_card_changes" USING btree ("tenant_id","payment_id","requested_at");--> statement-breakpoint
CREATE UNIQUE INDEX "gateway_receipt_captures_open_key" ON "gateway_receipt_captures" USING btree ("tenant_id","bot_instance_id","customer_id") WHERE closed_at IS NULL;--> statement-breakpoint
CREATE INDEX "gateway_receipt_captures_due_idx" ON "gateway_receipt_captures" USING btree ("tenant_id","expires_at") WHERE closed_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "gateway_receipt_submissions_file_key" ON "gateway_receipt_submissions" USING btree ("tenant_id","payment_id","telegram_file_unique_id");--> statement-breakpoint
CREATE UNIQUE INDEX "gateway_receipt_submissions_in_flight_key" ON "gateway_receipt_submissions" USING btree ("tenant_id","payment_id") WHERE state IN ('QUEUED', 'SENDING');--> statement-breakpoint
CREATE UNIQUE INDEX "gateway_receipt_submissions_unknown_key" ON "gateway_receipt_submissions" USING btree ("tenant_id","payment_id") WHERE state = 'UNKNOWN' AND inquiry_resolved_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "gateway_receipt_submissions_review_key" ON "gateway_receipt_submissions" USING btree ("tenant_id","payment_id") WHERE opened_review;--> statement-breakpoint
CREATE INDEX "gateway_receipt_submissions_due_idx" ON "gateway_receipt_submissions" USING btree ("tenant_id","created_at") WHERE state IN ('QUEUED', 'SENDING');--> statement-breakpoint
CREATE INDEX "payments_provider_review_idx" ON "payments" USING btree ("tenant_id","provider_review_until") WHERE state = 'PENDING' AND provider_review_until IS NOT NULL;--> statement-breakpoint
ALTER TABLE "gateway_invoices" ADD CONSTRAINT "gateway_invoices_tonpays_telegram_check" CHECK (provider <> 'TONPAYS_TELEGRAM' OR (bot_instance_id IS NOT NULL AND provider_unit = 'IRT' AND conversion_policy = 'SAME_UNIT'));--> statement-breakpoint
ALTER TABLE "gateway_invoices" ADD CONSTRAINT "gateway_invoices_card_check" CHECK ((card_seq IS NULL) = (card_number IS NULL)
          AND (card_seq IS NULL) = (card_received_at IS NULL)
          AND (card_name IS NULL OR card_number IS NOT NULL)
          AND (card_number IS NULL OR provider = 'TONPAYS_TELEGRAM')
          AND (card_seq IS NULL OR card_seq >= 1)
          AND (card_number IS NULL OR length(card_number) BETWEEN 1 AND 64)
          AND (card_name IS NULL OR length(card_name) BETWEEN 1 AND 128));--> statement-breakpoint
ALTER TABLE "gateway_invoices" ADD CONSTRAINT "gateway_invoices_provider_check" CHECK (provider IN ('MANUAL_TRANSFER', 'TONPAYS', 'TELEGRAM_STARS', 'TONPAYS_TELEGRAM'));--> statement-breakpoint
ALTER TABLE "payment_gateway_call_budgets" ADD CONSTRAINT "payment_gateway_call_budgets_provider_check" CHECK (provider IN ('MANUAL_TRANSFER', 'TONPAYS', 'TELEGRAM_STARS', 'TONPAYS_TELEGRAM'));--> statement-breakpoint
ALTER TABLE "payment_gateway_credentials" ADD CONSTRAINT "payment_gateway_credentials_provider_check" CHECK (provider IN ('MANUAL_TRANSFER', 'TONPAYS', 'TELEGRAM_STARS', 'TONPAYS_TELEGRAM'));--> statement-breakpoint
ALTER TABLE "payment_gateways" ADD CONSTRAINT "payment_gateways_provider_check" CHECK (provider IN ('MANUAL_TRANSFER', 'TONPAYS', 'TELEGRAM_STARS', 'TONPAYS_TELEGRAM'));--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_provider_review_check" CHECK ((provider_review_started_at IS NULL) = (provider_review_until IS NULL) AND (provider_review_until IS NULL OR (method = 'GATEWAY' AND gateway_provider IN ('TONPAYS_TELEGRAM') AND expires_at IS NOT NULL AND provider_review_started_at < expires_at AND provider_review_until = provider_review_started_at + interval '24 hours')));--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_gateway_provider_check" CHECK (gateway_provider IS NULL OR gateway_provider IN ('MANUAL_TRANSFER', 'TONPAYS', 'TELEGRAM_STARS', 'TONPAYS_TELEGRAM'));
--> statement-breakpoint
-- The confirmation guard: 0124's body, unchanged, plus the review-window freeze.
CREATE OR REPLACE FUNCTION nexa_payments_confirmation_guard() RETURNS trigger AS $$
BEGIN
  -- Payment File 02 §17 (D5): the route snapshot is frozen in every state.
  IF NEW.gateway_provider IS DISTINCT FROM OLD.gateway_provider
    OR NEW.topup_cashback_percent IS DISTINCT FROM OLD.topup_cashback_percent THEN
    RAISE EXCEPTION
      'a payment''s route and the top-up gift it promised are fixed when it is created.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- WP18: the customer's gateway fee is a snapshot too, frozen in every state. A
  -- changed rate, fee or payable on an open attempt is an invoice for a figure the
  -- customer was never shown; on a closed one it rewrites what they paid.
  IF NEW.customer_fee_basis_points IS DISTINCT FROM OLD.customer_fee_basis_points
    OR NEW.customer_fee_amount IS DISTINCT FROM OLD.customer_fee_amount
    OR NEW.payable_amount IS DISTINCT FROM OLD.payable_amount THEN
    RAISE EXCEPTION
      'a payment''s customer gateway fee and payable are fixed when it is created.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- 0157, TonPays Telegram (`docs/tonpays-telegram-gateway-audit.md` §7.0): the provider
  -- review window is written ONCE, only while the payment is and stays PENDING, and is
  -- frozen in every state afterwards. A repeated or later acknowledgement can never move
  -- the settlement deadline, whoever writes it.
  IF NEW.provider_review_started_at IS DISTINCT FROM OLD.provider_review_started_at
    OR NEW.provider_review_until IS DISTINCT FROM OLD.provider_review_until THEN
    IF OLD.provider_review_until IS NOT NULL
      OR OLD.state IS DISTINCT FROM 'PENDING'
      OR NEW.state IS DISTINCT FROM 'PENDING' THEN
      RAISE EXCEPTION
        'a payment''s provider review window is written once, while it is pending, and never moves.'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF OLD.state = 'CONFIRMED' AND (
       NEW.amount IS DISTINCT FROM OLD.amount
    OR NEW.currency IS DISTINCT FROM OLD.currency
    OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
    OR NEW.order_id IS DISTINCT FROM OLD.order_id
    OR NEW.method IS DISTINCT FROM OLD.method
    OR NEW.reference IS DISTINCT FROM OLD.reference
    OR NEW.evidence_kind IS DISTINCT FROM OLD.evidence_kind
    OR NEW.evidence_note IS DISTINCT FROM OLD.evidence_note
    OR NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at
    OR NEW.confirmed_by_admin_id IS DISTINCT FROM OLD.confirmed_by_admin_id
    OR NEW.customer_signalled_at IS DISTINCT FROM OLD.customer_signalled_at
    OR NEW.state IS DISTINCT FROM OLD.state
  ) THEN
    RAISE EXCEPTION
      'a confirmed payment''s money, customer, order, method and evidence — including who confirmed it and what the customer claimed — are immutable.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.state IN ('FAILED', 'CANCELLED', 'EXPIRED') AND (
       NEW.state IS DISTINCT FROM OLD.state
    OR NEW.amount IS DISTINCT FROM OLD.amount
    OR NEW.currency IS DISTINCT FROM OLD.currency
    OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
    OR NEW.order_id IS DISTINCT FROM OLD.order_id
    OR NEW.method IS DISTINCT FROM OLD.method
    OR NEW.reference IS DISTINCT FROM OLD.reference
    OR NEW.resolved_at IS DISTINCT FROM OLD.resolved_at
    OR NEW.resolved_by_admin_id IS DISTINCT FROM OLD.resolved_by_admin_id
    OR NEW.resolution_note IS DISTINCT FROM OLD.resolution_note
    OR NEW.evidence_kind IS DISTINCT FROM OLD.evidence_kind
    OR NEW.evidence_note IS DISTINCT FROM OLD.evidence_note
    OR NEW.confirmed_by_admin_id IS DISTINCT FROM OLD.confirmed_by_admin_id
    -- The one 0053 missed. A resolved payment never had a confirmation time, and
    -- acquiring one is the appearance of a confirmation that never happened.
    OR NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at
    OR NEW.customer_signalled_at IS DISTINCT FROM OLD.customer_signalled_at
  ) THEN
    RAISE EXCEPTION
      'a payment that was rejected, withdrawn or expired cannot be reopened, and its money, customer, order, evidence, resolution and the customer''s own claim are immutable.'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

-- Every payee card a customer was shown is kept: a dispute is answerable only if none can be
-- rewritten or removed.
CREATE OR REPLACE FUNCTION nexa_gateway_invoice_cards_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'gateway_invoice_cards is append-only: a card a customer was shown is never changed or removed.'
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS nexa_gateway_invoice_cards_append_only ON gateway_invoice_cards;--> statement-breakpoint
CREATE TRIGGER nexa_gateway_invoice_cards_append_only
  BEFORE UPDATE OR DELETE ON gateway_invoice_cards
  FOR EACH ROW EXECUTE FUNCTION nexa_gateway_invoice_cards_append_only();--> statement-breakpoint

-- Backfill: `payments.reconcile` reaches the seeded roles that already exist (the 0148 shape).
-- NEW in this release, so no installation can have withdrawn it; a DENY override still wins.
-- `owner` holds every key; `finance` reconciles money.
INSERT INTO "role_permissions" ("tenant_id", "role_id", "permission_key")
SELECT r."tenant_id", r."id", p."key"
FROM "roles" r
JOIN (VALUES
        ('owner', 'payments.reconcile'),
        ('finance', 'payments.reconcile')
     ) AS p("role_key", "key")
  ON p."role_key" = r."key"
WHERE r."is_system" = true
ON CONFLICT DO NOTHING;
