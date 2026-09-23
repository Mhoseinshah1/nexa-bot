-- WP9-B: a reseller purchase's record is a record (`docs/wp9-reseller-audit.md` R9, R10).
--
-- `order_reseller_terms` is append-only. It is what a reseller's order WAS when it was
-- confirmed: the tier, the layer that priced it, the list amount, the cost, the promotion
-- and the margin. A margin re-derived from live tier settings is the thing the plan
-- forbids ("never derive historical margin from live tier settings"), and a row that could
-- be edited would be exactly that, one UPDATE later. A refund does not rewrite it either:
-- the refund is its own record, read beside this one.
--
-- Tests reset with TRUNCATE, which bypasses row triggers, deliberately.
--
-- Hand-written because drizzle-kit does not model triggers, and it adds nothing the
-- schema file describes, so it does not affect the drift check.

CREATE TRIGGER order_reseller_terms_no_update
  BEFORE UPDATE ON order_reseller_terms
  FOR EACH ROW EXECUTE FUNCTION nexa_reject_mutation();
--> statement-breakpoint

CREATE TRIGGER order_reseller_terms_no_delete
  BEFORE DELETE ON order_reseller_terms
  FOR EACH ROW EXECUTE FUNCTION nexa_reject_mutation();
