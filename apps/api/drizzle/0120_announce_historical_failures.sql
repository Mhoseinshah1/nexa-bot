-- Customer UX completion §H1: a customer-requested operation that FAILED for good is
-- now announced to the customer, and the announcement sweep picks up terminal FAILED
-- rows that were never stamped. Rows that completed FAILED BEFORE this rule were
-- resolved under the rule in force at the time — nothing was owed for them — so they
-- are stamped as answered at their completion, and the sweep announces no history.
-- Additive: an UPDATE of a bookkeeping column, no shape change.
UPDATE "provisioning_operations"
SET "announced_at" = "completed_at"
WHERE "state" = 'FAILED'
  AND "next_attempt_at" IS NULL
  AND "announced_at" IS NULL
  AND "completed_at" IS NOT NULL;
