-- The one-time Mirza import records a Mirza invoice whose account is not on the panel as an
-- ENDED service (state TERMINATED, never provisioned). Two changes make room for it:
--
--   1. services_panel_provider_username_key becomes PARTIAL, excluding TERMINATED. A
--      terminated account's name is free again — usernameInUseOnPanel already said so; the
--      index now agrees. Widening only: every row that satisfied the full index satisfies
--      the partial one, and the release running beside this one inserts live rows exactly as
--      before. The index is dropped and recreated in one transaction, so no live row is ever
--      unprotected between the two statements.
--   2. services.is_test marks a Mirza TEST invoice. DEFAULT false (expand-only), and only a
--      MIRZA row may be true.
DROP INDEX "services_panel_provider_username_key";--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "is_test" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "services_panel_provider_username_key" ON "services" USING btree ("panel_id","provider_username") WHERE state <> 'TERMINATED';--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_is_test_source_check" CHECK (NOT is_test OR source = 'MIRZA');
--> statement-breakpoint
-- The ended rows are history, and the database says so rather than every lane remembering it.
--
--   3. A TERMINATED service never leaves TERMINATED. SERVICE_MACHINE has no edge out of it and
--      every conditional UPDATE names its from-states, so nothing does today; this is the half
--      that survives a direct write, and it is what makes an ended Mirza service (never on a
--      panel) unable to be "resumed" into a live one by any path, present or future.
--   4. A LEGACY_HISTORY order never changes state or amount. The import writes it once,
--      PAID, at the invoice's own amount; no settlement, expiry, refund or cancellation lane
--      may rewrite it (and none selects it: it is never AWAITING_PAYMENT). The customer may
--      still change (an account transfer moves a customer's orders), so that column is free.
CREATE FUNCTION nexa_services_terminated_frozen() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'service % is TERMINATED and stays so', OLD.id
    USING ERRCODE = 'restrict_violation';
END;
$$;--> statement-breakpoint
CREATE TRIGGER nexa_services_terminated_frozen
  BEFORE UPDATE OF state ON services
  FOR EACH ROW
  WHEN (OLD.state = 'TERMINATED' AND NEW.state IS DISTINCT FROM OLD.state)
  EXECUTE FUNCTION nexa_services_terminated_frozen();--> statement-breakpoint
CREATE FUNCTION nexa_orders_history_frozen() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'order % is a LEGACY_HISTORY order: its state and amounts never change', OLD.id
    USING ERRCODE = 'restrict_violation';
END;
$$;--> statement-breakpoint
CREATE TRIGGER nexa_orders_history_frozen
  BEFORE UPDATE OF state, subtotal_amount, discount_amount, total_amount, settled_at,
                   cancelled_at, refunded_at ON orders
  FOR EACH ROW
  WHEN (OLD.origin = 'LEGACY_HISTORY' AND (
          NEW.state IS DISTINCT FROM OLD.state
       OR NEW.subtotal_amount IS DISTINCT FROM OLD.subtotal_amount
       OR NEW.discount_amount IS DISTINCT FROM OLD.discount_amount
       OR NEW.total_amount IS DISTINCT FROM OLD.total_amount
       OR NEW.settled_at IS DISTINCT FROM OLD.settled_at
       OR NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at
       OR NEW.refunded_at IS DISTINCT FROM OLD.refunded_at))
  EXECUTE FUNCTION nexa_orders_history_frozen();
