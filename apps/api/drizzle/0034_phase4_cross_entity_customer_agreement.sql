-- Bind the CUSTOMER to the ORDER in every child that carries both.
--
-- `payments`, `services` and `discount_redemptions` each hold a `customer_id` beside an
-- `order_id`, and a two-column `(tenant_id, order_id)` foreign key lets a child row name
-- order A while claiming customer B. Each of those is a real bypass:
--
--   - a payment that settles another customer's order — a wallet debit against the wrong
--     person;
--   - a service that appears in the wrong customer's list;
--   - a discount redemption whose `(discount_id, customer_id)` pair is a fiction, which
--     makes a per-customer redemption limit advisory rather than enforced.
--
-- The three-column reference makes the disagreement impossible to express. `order_id` is
-- nullable on `payments` — a wallet top-up settles no order — and a MATCH SIMPLE composite
-- foreign key is not enforced when any column is NULL, which is exactly right: a top-up
-- has nothing to agree with.
--
-- Found by the automated security review of the schema commit, which is the class of thing
-- a reviewer sees and an author does not: each foreign key looked correct on its own.
--
-- STATEMENT ORDER IS LOAD-BEARING. The unique key the children reference is created FIRST.
-- drizzle-kit generated it last and the migration failed on
-- `transformFkeyCheckAttrs` — there was no unique constraint matching the referenced
-- columns. Reordered by hand; the file had never applied anywhere, so this is not an edit
-- to an applied migration.
--
-- THE RE-ADDED CONSTRAINT KEEPS THE OLD NAME, and that is a rule rather than a
-- preference. `migration-compatibility.test.ts` requires every `DROP CONSTRAINT` in an
-- incoming migration to be matched by an `ADD CONSTRAINT` of the SAME name in the same
-- file, because the two things that wear `DROP CONSTRAINT` are a removal — which takes a
-- guarantee away from the release still running — and a REDEFINITION, which is the only
-- way PostgreSQL can widen one. This is a redefinition: the same reference, across three
-- columns instead of two. Renaming it while redefining it made it read as a removal plus
-- an unrelated addition, and the test said so.
ALTER TABLE "orders" ADD CONSTRAINT "orders_tenant_id_customer_key" UNIQUE("tenant_id","id","customer_id");--> statement-breakpoint
ALTER TABLE "discount_redemptions" DROP CONSTRAINT "discount_redemptions_order_fk";--> statement-breakpoint
ALTER TABLE "payments" DROP CONSTRAINT "payments_order_fk";--> statement-breakpoint
ALTER TABLE "services" DROP CONSTRAINT "services_order_fk";--> statement-breakpoint
ALTER TABLE "discount_redemptions" ADD CONSTRAINT "discount_redemptions_order_fk" FOREIGN KEY ("tenant_id","order_id","customer_id") REFERENCES "public"."orders"("tenant_id","id","customer_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_order_fk" FOREIGN KEY ("tenant_id","order_id","customer_id") REFERENCES "public"."orders"("tenant_id","id","customer_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_order_fk" FOREIGN KEY ("tenant_id","order_id","customer_id") REFERENCES "public"."orders"("tenant_id","id","customer_id") ON DELETE no action ON UPDATE no action;
