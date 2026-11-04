-- NEXA v099 (owner): a non-+98 number the customer shared while
-- phone_verification.allowed_numbers is IRAN_ONLY is STORED, marked not accepted
-- (`phone_not_accepted_at`), and never verified: `phone_verified_at` keeps its one meaning.
-- `customers_phone_check` now says a stored number is verified or not accepted, never both and
-- never neither. The column is NULL for every existing customer and every existing row already
-- satisfies the new CHECK, so nothing changes until a customer shares a number, and no customer
-- is sent anything by this migration. customers is a large table (scripts/large-tables.txt), so
-- the CHECK is re-added NOT VALID, then VALIDATEd (a SHARE UPDATE EXCLUSIVE lock). Only hand
-- edit of the generated SQL; journal and snapshot are untouched.
ALTER TABLE "customers" DROP CONSTRAINT "customers_phone_check";--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "phone_not_accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_phone_check" CHECK ((phone_number IS NULL) = (phone_verified_at IS NULL AND phone_not_accepted_at IS NULL) AND (phone_verified_at IS NULL OR phone_not_accepted_at IS NULL)) NOT VALID;--> statement-breakpoint
ALTER TABLE "customers" VALIDATE CONSTRAINT "customers_phone_check";
