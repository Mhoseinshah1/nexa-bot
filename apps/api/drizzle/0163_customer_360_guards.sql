-- Customer 360 (spec §11.4–11.5, `docs/customer-account-transfer-audit.md`): what
-- `drizzle-kit` does not model for 0162 — the append-only guard on the account-transfer
-- record, and the backfill of the five new `users.*` keys to the seeded roles that already
-- exist. Hand-written, so no snapshot accompanies it and the drift check has nothing to
-- compare.
--
-- WHY THE BACKFILL IS SAFE
--
-- All five keys are NEW in this release, so no installation can have withdrawn them, and a
-- DENY override still beats this because resolution subtracts DENY last. `owner` holds every
-- key; `operator` takes the four per-customer controls it answers support questions with.
-- `users.transfer` (CRITICAL) stays the owner's. No key here is LOW, so `observer` gains
-- nothing.
--
-- ROLLBACK NOTE. The previous release does not know the ledger reasons
-- `ACCOUNT_TRANSFER_OUT` / `ACCOUNT_TRANSFER_IN` and has no exhaustive mapping for them in
-- its reports. Before a rollback, read:
--   SELECT count(*) FROM customer_account_transfers;
-- A non-zero count means wallets whose history the previous release would mislabel.
-- `botctl rollback` never restores the database (CLAUDE.md).

DROP TRIGGER IF EXISTS customer_account_transfers_no_update ON customer_account_transfers;--> statement-breakpoint
CREATE TRIGGER customer_account_transfers_no_update
  BEFORE UPDATE ON customer_account_transfers
  FOR EACH ROW EXECUTE FUNCTION nexa_reject_mutation();--> statement-breakpoint
DROP TRIGGER IF EXISTS customer_account_transfers_no_delete ON customer_account_transfers;--> statement-breakpoint
CREATE TRIGGER customer_account_transfers_no_delete
  BEFORE DELETE ON customer_account_transfers
  FOR EACH ROW EXECUTE FUNCTION nexa_reject_mutation();--> statement-breakpoint

INSERT INTO "role_permissions" ("tenant_id", "role_id", "permission_key")
SELECT r."tenant_id", r."id", p."key"
FROM "roles" r
JOIN (VALUES
        ('owner', 'users.channel_membership.exempt'),
        ('owner', 'users.phone.verify'),
        ('owner', 'users.location.edit'),
        ('owner', 'users.notifications.edit'),
        ('owner', 'users.transfer'),
        ('operator', 'users.channel_membership.exempt'),
        ('operator', 'users.phone.verify'),
        ('operator', 'users.location.edit'),
        ('operator', 'users.notifications.edit')
     ) AS p("role_key", "key")
  ON p."role_key" = r."key"
WHERE r."is_system" = true
ON CONFLICT DO NOTHING;
