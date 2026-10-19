-- `payment_destination_switches` is append-only, exactly as `payment_destinations` is (0063).
--
-- Hand-written because `drizzle-kit` does not model triggers; it changes no schema, so the
-- drift check has nothing to compare and no snapshot accompanies it.
--
-- R4 A1: a press of «🔄 تغییر شماره کارت» is a second thing a customer was told about where
-- to send money. If a row here could be updated, a receipt reviewer would be comparing a
-- bank statement against a card the customer was never shown; if one could be deleted, the
-- invoice would quietly fall back to an earlier card. Neither may happen, for any role.
--
-- Tests reset with TRUNCATE, which bypasses row triggers; the guard stays in force for
-- application code (0001).

CREATE TRIGGER payment_destination_switches_no_update
  BEFORE UPDATE ON payment_destination_switches
  FOR EACH ROW EXECUTE FUNCTION nexa_reject_mutation();
--> statement-breakpoint

CREATE TRIGGER payment_destination_switches_no_delete
  BEFORE DELETE ON payment_destination_switches
  FOR EACH ROW EXECUTE FUNCTION nexa_reject_mutation();
