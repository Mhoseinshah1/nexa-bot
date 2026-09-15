-- `service_commercial_actions` is financial evidence, and evidence that can be
-- edited is not evidence.
--
-- Each row answers, for one renewal or one quantity purchase: which customer,
-- which service, what kind, how much was bought and what was paid for it. The
-- legacy system's equivalent — `/invoice/service` — is append-only for the same
-- reason, and everything the research says about its reports being
-- unreconcilable comes from records that were rewritten by later edits: a
-- renamed product rewrites past reports, a deleted one collapses a line to
-- «محصول حذف‌شده».
--
-- So the row is written once, in the transaction that confirms the order, and
-- the database refuses both an UPDATE and a DELETE. `nexa_reject_mutation` is
-- the same function `audit_logs` and `processed_messages` already use — this
-- adds no new mechanism, only a third table to it.
--
-- Tests reset with TRUNCATE, which bypasses row triggers. That is deliberate and
-- is what `docs/conventions.md` and the migrations skill both record: the guard
-- stays in force for application code, which is the only thing it is protecting
-- against.
--
-- Hand-written because drizzle-kit does not model triggers, and it adds nothing
-- the schema file describes, so it does not affect the drift check.

CREATE TRIGGER service_commercial_actions_no_update
  BEFORE UPDATE ON service_commercial_actions
  FOR EACH ROW EXECUTE FUNCTION nexa_reject_mutation();
--> statement-breakpoint

CREATE TRIGGER service_commercial_actions_no_delete
  BEFORE DELETE ON service_commercial_actions
  FOR EACH ROW EXECUTE FUNCTION nexa_reject_mutation();
