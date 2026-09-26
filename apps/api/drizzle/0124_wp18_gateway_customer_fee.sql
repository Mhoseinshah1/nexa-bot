ALTER TABLE "notifications" DROP CONSTRAINT "notifications_kind_check";--> statement-breakpoint
ALTER TABLE "payment_gateways" ADD COLUMN "customer_fee_basis_points" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "customer_fee_basis_points" integer;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "customer_fee_amount" bigint;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "payable_amount" bigint;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_kind_check" CHECK (kind IN ('OPERATIONAL_EVENT', 'OPERATIONS_TEST', 'RECEIPT_AWAITING_REVIEW', 'FINANCIAL_EVENT'));--> statement-breakpoint
ALTER TABLE "payment_gateways" ADD CONSTRAINT "payment_gateways_customer_fee_check" CHECK (customer_fee_basis_points BETWEEN 0 AND 10000);--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_customer_fee_check" CHECK ((customer_fee_basis_points IS NULL AND customer_fee_amount IS NULL AND payable_amount IS NULL) OR (method = 'GATEWAY' AND customer_fee_basis_points BETWEEN 0 AND 10000 AND customer_fee_amount >= 0 AND payable_amount = amount + customer_fee_amount));--> statement-breakpoint

-- WP18: freeze the fee snapshot. The rest of the function is 0114's, unchanged.
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
$$ LANGUAGE plpgsql;
