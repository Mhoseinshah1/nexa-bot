-- NEXA v095 PR-4 D and A/C: the phone-verification exemption (`phone_verification_exempt_at`,
-- Customer 360's «معاف از تأیید شماره») and the action the bot resumes once a customer has
-- verified their phone (`phone_resume`, `phone_resume_at`). All three are NULL for every
-- existing customer, so nothing changes until an operator or the customer acts, and no
-- customer is sent anything by this migration. customers is a large table
-- (scripts/large-tables.txt), so the CHECK is added NOT VALID, then VALIDATEd. Only hand edit
-- of the generated SQL; journal and snapshot are untouched.
ALTER TABLE "customers" ADD COLUMN "phone_verification_exempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "phone_resume" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "phone_resume_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_phone_resume_check" CHECK ((phone_resume IS NULL) = (phone_resume_at IS NULL) AND (phone_resume IS NULL OR char_length(phone_resume) <= 300)) NOT VALID;--> statement-breakpoint
ALTER TABLE "customers" VALIDATE CONSTRAINT "customers_phone_resume_check";
