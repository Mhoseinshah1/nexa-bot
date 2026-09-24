-- WP10 follow-up (ADR-0031, docs/wp10-followup-audit.md §3): the administrators' receipt push.
--
-- Generated from `schema.ts`, so the drift check covers it.
--
-- One row per (receipt, administrator), written by the PaymentReceiptSubmitted consumer in the
-- outbox relay's transaction — never in the transaction that filed the receipt. The unique key
-- is the lane's idempotency: an outbox redelivery, a replayed consumer and two worker replicas
-- all land on the row that exists. DELIVERED is definite, FAILED is definitely not delivered,
-- and UNKNOWN is ambiguous and never re-sent. A new, empty table: nothing to backfill.

CREATE TABLE "receipt_review_pushes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"receipt_id" uuid NOT NULL,
	"admin_id" uuid NOT NULL,
	"bot_instance_id" uuid NOT NULL,
	"state" text DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"send_started_at" timestamp with time zone,
	"chat_id" text,
	"last_error_code" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "receipt_review_pushes_receipt_admin_key" UNIQUE("tenant_id","receipt_id","admin_id"),
	CONSTRAINT "receipt_review_pushes_state_check" CHECK (state IN ('PENDING', 'DELIVERED', 'UNKNOWN', 'FAILED', 'SUPERSEDED')),
	CONSTRAINT "receipt_review_pushes_resolved_check" CHECK ((state <> 'PENDING') = (resolved_at IS NOT NULL)),
	CONSTRAINT "receipt_review_pushes_attempts_check" CHECK (attempts >= 0)
);
--> statement-breakpoint
ALTER TABLE "receipt_review_pushes" ADD CONSTRAINT "receipt_review_pushes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_review_pushes" ADD CONSTRAINT "receipt_review_pushes_bot_instance_id_bot_instances_id_fk" FOREIGN KEY ("bot_instance_id") REFERENCES "public"."bot_instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_review_pushes" ADD CONSTRAINT "receipt_review_pushes_payment_fk" FOREIGN KEY ("tenant_id","payment_id") REFERENCES "public"."payments"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_review_pushes" ADD CONSTRAINT "receipt_review_pushes_receipt_fk" FOREIGN KEY ("tenant_id","receipt_id") REFERENCES "public"."payment_receipts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_review_pushes" ADD CONSTRAINT "receipt_review_pushes_admin_fk" FOREIGN KEY ("tenant_id","admin_id") REFERENCES "public"."admins"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "receipt_review_pushes_due_idx" ON "receipt_review_pushes" USING btree ("tenant_id","next_attempt_at") WHERE state = 'PENDING';