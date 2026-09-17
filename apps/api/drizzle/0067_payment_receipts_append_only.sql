-- `payment_receipts` is append-only, in the database rather than in a code review.
--
-- Hand-written, like 0001 and 0063, because `drizzle-kit` generates from `schema.ts` and
-- does not model triggers. No snapshot accompanies it: it changes no schema, so the drift
-- check has nothing to compare.
--
-- A receipt is what somebody LOOKS AT when deciding whether money arrived. A row that
-- could be edited afterwards is the legacy `/admin/logs` with a picture attached — a
-- free-text sentence with no before and no after — and a row that could be deleted is a
-- reviewer's evidence disappearing between the decision and the audit of it.
--
-- `receipt_captures` is deliberately NOT append-only. Its whole life is being opened and
-- then closed, and the close is an UPDATE naming the state it moves from.
--
-- Tests reset with TRUNCATE, which bypasses row triggers. That is deliberate and 0001
-- records it: the guard stays in force for application code.

CREATE TRIGGER payment_receipts_no_update
  BEFORE UPDATE ON payment_receipts
  FOR EACH ROW EXECUTE FUNCTION nexa_reject_mutation();
--> statement-breakpoint

CREATE TRIGGER payment_receipts_no_delete
  BEFORE DELETE ON payment_receipts
  FOR EACH ROW EXECUTE FUNCTION nexa_reject_mutation();
