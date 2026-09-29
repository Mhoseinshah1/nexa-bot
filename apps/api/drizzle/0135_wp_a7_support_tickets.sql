-- WP-A7 — the support ticket system (docs/wp-a7-tickets-audit.md).
--
-- Four tables: the tenant's ticket categories and their one-time seed marker, the tickets,
-- and their messages. A message is append-only (nexa_reject_mutation, the audit log's guard):
-- the conversation is its rows, and a Telegram send that fails or is lost cannot take a
-- message with it. An administrator's reply is pushed through customer_notifications, whose
-- kind CHECK is re-pinned with TICKET_REPLY; the two customer_text_captures CHECKs are
-- re-pinned with the two ticket windows, which name their category or their ticket.
--
-- The role backfill at the end gives the five ticket permissions to the system roles that
-- already exist, as ROLE_SEEDS now does for new installations.
--
-- Rollback: this only adds. The previous release never reads the new tables; a TICKET_REPLY
-- row it cannot render is deferred by its dispatcher, not spent (docs/conventions.md, "A
-- widened enum is write-compatible, not reader-compatible").
CREATE TABLE "ticket_categories" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"title" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ticket_categories_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "ticket_categories_title_key" UNIQUE("tenant_id","title"),
	CONSTRAINT "ticket_categories_title_check" CHECK (length(btrim(title)) BETWEEN 1 AND 64),
	CONSTRAINT "ticket_categories_sort_order_check" CHECK (sort_order BETWEEN 0 AND 100000)
);
--> statement-breakpoint
CREATE TABLE "ticket_category_seeds" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"seeded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"ticket_id" uuid NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "ticket_messages_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"sender_type" text NOT NULL,
	"author_admin_id" uuid,
	"body" text,
	"system_event" text,
	"attachment_kind" text,
	"attachment_bot_instance_id" uuid,
	"attachment_file_id" text,
	"attachment_file_unique_id" text,
	"attachment_mime_type" text,
	"attachment_file_name" text,
	"attachment_file_size" bigint,
	"idempotency_key" text,
	"request_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ticket_messages_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "ticket_messages_key" UNIQUE("tenant_id","idempotency_key"),
	CONSTRAINT "ticket_messages_sender_check" CHECK (sender_type IN ('CUSTOMER', 'ADMIN', 'SYSTEM')),
	CONSTRAINT "ticket_messages_system_event_check" CHECK (system_event IS NULL OR system_event IN ('CLOSED_BY_CUSTOMER', 'CLOSED_BY_SUPPORT', 'REOPENED_BY_SUPPORT')),
	CONSTRAINT "ticket_messages_attachment_kind_check" CHECK (attachment_kind IS NULL OR attachment_kind IN ('PHOTO', 'DOCUMENT')),
	CONSTRAINT "ticket_messages_body_check" CHECK (body IS NULL OR length(body) BETWEEN 1 AND 3000),
	CONSTRAINT "ticket_messages_attachment_check" CHECK ((attachment_kind IS NULL) = (attachment_file_id IS NULL)
          AND (attachment_kind IS NULL) = (attachment_file_unique_id IS NULL)
          AND (attachment_kind IS NULL) = (attachment_bot_instance_id IS NULL)
          AND (attachment_kind IS NOT NULL OR (attachment_mime_type IS NULL AND attachment_file_name IS NULL AND attachment_file_size IS NULL))),
	CONSTRAINT "ticket_messages_attachment_size_check" CHECK (attachment_file_size IS NULL OR attachment_file_size BETWEEN 1 AND 10485760),
	CONSTRAINT "ticket_messages_attachment_name_check" CHECK (attachment_file_name IS NULL OR length(attachment_file_name) BETWEEN 1 AND 200),
	CONSTRAINT "ticket_messages_shape_check" CHECK (CASE sender_type
            WHEN 'CUSTOMER' THEN author_admin_id IS NULL AND system_event IS NULL
                 AND (body IS NOT NULL OR attachment_kind IS NOT NULL) AND idempotency_key IS NOT NULL
            WHEN 'ADMIN' THEN author_admin_id IS NOT NULL AND system_event IS NULL
                 AND body IS NOT NULL AND attachment_kind IS NULL AND idempotency_key IS NOT NULL
            WHEN 'SYSTEM' THEN author_admin_id IS NULL AND system_event IS NOT NULL
                 AND body IS NULL AND attachment_kind IS NULL
            ELSE false
          END),
	CONSTRAINT "ticket_messages_key_check" CHECK ((idempotency_key IS NULL) = (request_hash IS NULL)
          AND (idempotency_key IS NULL OR length(idempotency_key) BETWEEN 1 AND 300))
);
--> statement-breakpoint
CREATE TABLE "tickets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"number" bigint GENERATED ALWAYS AS IDENTITY (sequence name "tickets_number_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"customer_id" uuid NOT NULL,
	"bot_instance_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"category_title" text NOT NULL,
	"subject" text,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"priority" text DEFAULT 'NORMAL' NOT NULL,
	"assigned_admin_id" uuid,
	"service_id" uuid,
	"order_id" uuid,
	"payment_id" uuid,
	"opening_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_message_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "tickets_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "tickets_opening_key" UNIQUE("tenant_id","opening_key"),
	CONSTRAINT "tickets_status_check" CHECK (status IN ('OPEN', 'WAITING_FOR_CUSTOMER', 'WAITING_FOR_SUPPORT', 'CLOSED')),
	CONSTRAINT "tickets_priority_check" CHECK (priority IN ('LOW', 'NORMAL', 'HIGH', 'URGENT')),
	CONSTRAINT "tickets_closed_check" CHECK ((status = 'CLOSED') = (closed_at IS NOT NULL)),
	CONSTRAINT "tickets_subject_check" CHECK (subject IS NULL OR length(subject) BETWEEN 1 AND 80),
	CONSTRAINT "tickets_category_title_check" CHECK (length(category_title) BETWEEN 1 AND 64),
	CONSTRAINT "tickets_opening_key_check" CHECK (length(opening_key) BETWEEN 1 AND 300)
);
--> statement-breakpoint
ALTER TABLE "customer_notifications" DROP CONSTRAINT "customer_notifications_kind_check";--> statement-breakpoint
ALTER TABLE "customer_text_captures" DROP CONSTRAINT "customer_text_captures_purpose_check";--> statement-breakpoint
ALTER TABLE "customer_text_captures" DROP CONSTRAINT "customer_text_captures_subject_check";--> statement-breakpoint
ALTER TABLE "ticket_categories" ADD CONSTRAINT "ticket_categories_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_category_seeds" ADD CONSTRAINT "ticket_category_seeds_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_messages" ADD CONSTRAINT "ticket_messages_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_messages" ADD CONSTRAINT "ticket_messages_attachment_bot_instance_id_bot_instances_id_fk" FOREIGN KEY ("attachment_bot_instance_id") REFERENCES "public"."bot_instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_messages" ADD CONSTRAINT "ticket_messages_ticket_fk" FOREIGN KEY ("tenant_id","ticket_id") REFERENCES "public"."tickets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_messages" ADD CONSTRAINT "ticket_messages_author_fk" FOREIGN KEY ("tenant_id","author_admin_id") REFERENCES "public"."admins"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_bot_instance_id_bot_instances_id_fk" FOREIGN KEY ("bot_instance_id") REFERENCES "public"."bot_instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_category_fk" FOREIGN KEY ("tenant_id","category_id") REFERENCES "public"."ticket_categories"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_assignee_fk" FOREIGN KEY ("tenant_id","assigned_admin_id") REFERENCES "public"."admins"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_service_fk" FOREIGN KEY ("tenant_id","service_id") REFERENCES "public"."services"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."orders"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_payment_fk" FOREIGN KEY ("tenant_id","payment_id") REFERENCES "public"."payments"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ticket_categories_tenant_sort_idx" ON "ticket_categories" USING btree ("tenant_id","sort_order","id");--> statement-breakpoint
CREATE INDEX "ticket_messages_ticket_idx" ON "ticket_messages" USING btree ("tenant_id","ticket_id","seq");--> statement-breakpoint
CREATE INDEX "tickets_tenant_created_idx" ON "tickets" USING btree ("tenant_id","created_at","id");--> statement-breakpoint
CREATE INDEX "tickets_tenant_status_idx" ON "tickets" USING btree ("tenant_id","status","created_at");--> statement-breakpoint
CREATE INDEX "tickets_tenant_customer_idx" ON "tickets" USING btree ("tenant_id","customer_id","status");--> statement-breakpoint
CREATE INDEX "tickets_tenant_assignee_idx" ON "tickets" USING btree ("tenant_id","assigned_admin_id");--> statement-breakpoint
ALTER TABLE "customer_notifications" ADD CONSTRAINT "customer_notifications_kind_check" CHECK (kind IN ('PAYMENT_REJECTED', 'PAYMENT_EXPIRED', 'ORDER_EXPIRED', 'SERVICE_ACTION_SUCCEEDED', 'SERVICE_ACTION_FAILED', 'SERVICE_PROVISION_DELAYED', 'PAYMENT_TRANSFER_RECORDED', 'ORDER_CANCELLED', 'WALLET_TOPUP_CREDITED', 'ORDER_REFUNDED_TO_WALLET', 'SERVICE_EXPIRY_FIRST', 'SERVICE_EXPIRY_SECOND', 'SERVICE_EXPIRED', 'SERVICE_USAGE_FIRST', 'SERVICE_USAGE_SECOND', 'SERVICE_USAGE_FINAL', 'TRIAL_NOT_DELIVERED', 'RECEIPT_CREDITED_TO_WALLET', 'WALLET_TOPUP_GIFT_CREDITED', 'REFUND_COMPLETED', 'GATEWAY_PAYMENT_FAILED', 'SERVICE_REFUND_REQUEST_REGISTERED', 'SERVICE_REFUND_REQUEST_APPROVED', 'SERVICE_REFUND_REQUEST_REJECTED', 'SERVICE_TRANSFER_RECEIVED', 'TICKET_REPLY'));--> statement-breakpoint
ALTER TABLE "customer_text_captures" ADD CONSTRAINT "customer_text_captures_purpose_check" CHECK (purpose IN ('TOPUP_AMOUNT', 'SERVICE_SEARCH', 'SERVICE_NOTE', 'SERVICE_REFUND_REASON', 'CUSTOM_SERVICE_VOLUME', 'CUSTOM_SERVICE_DAYS', 'SERVICE_TRANSFER_RECIPIENT', 'TICKET_NEW_MESSAGE', 'TICKET_REPLY'));--> statement-breakpoint
ALTER TABLE "customer_text_captures" ADD CONSTRAINT "customer_text_captures_subject_check" CHECK ((purpose IN ('SERVICE_NOTE', 'SERVICE_REFUND_REASON', 'CUSTOM_SERVICE_VOLUME', 'CUSTOM_SERVICE_DAYS', 'SERVICE_TRANSFER_RECIPIENT', 'TICKET_NEW_MESSAGE', 'TICKET_REPLY')) = (subject_id IS NOT NULL));--> statement-breakpoint
-- A message sent is a message kept: never edited, never removed.
CREATE TRIGGER ticket_messages_no_update
  BEFORE UPDATE ON ticket_messages
  FOR EACH ROW EXECUTE FUNCTION nexa_reject_mutation();--> statement-breakpoint
CREATE TRIGGER ticket_messages_no_delete
  BEFORE DELETE ON ticket_messages
  FOR EACH ROW EXECUTE FUNCTION nexa_reject_mutation();--> statement-breakpoint
-- Backfill: the ticket permissions reach the system roles that already exist.
--
-- `ensureSystemRoles` writes a seed's permissions only when it CREATES the role, so a key
-- newly added to a seeded role reaches an existing installation only through a migration.
-- All five keys are NEW in this release: no installation can have withdrawn any of them, so
-- this deletes nothing and replaces nothing, and a DENY override still beats it because
-- resolution subtracts DENY last. `observer` holds every LOW key; `tickets.view` is LOW.
--
-- The VALUES-join shape matches the earlier backfills, because the seed/backfill coverage
-- guard reads the PAIRS out of this statement.
INSERT INTO "role_permissions" ("tenant_id", "role_id", "permission_key")
SELECT r."tenant_id", r."id", p."key"
FROM "roles" r
JOIN (VALUES
        ('owner', 'tickets.view'),
        ('owner', 'tickets.reply'),
        ('owner', 'tickets.assign'),
        ('owner', 'tickets.close'),
        ('owner', 'tickets.categories.edit'),
        ('operator', 'tickets.view'),
        ('operator', 'tickets.reply'),
        ('operator', 'tickets.assign'),
        ('operator', 'tickets.close'),
        ('operator', 'tickets.categories.edit'),
        ('support', 'tickets.view'),
        ('support', 'tickets.reply'),
        ('support', 'tickets.assign'),
        ('support', 'tickets.close'),
        ('observer', 'tickets.view')
     ) AS p("role_key", "key")
  ON p."role_key" = r."key"
WHERE r."is_system" = true
ON CONFLICT DO NOTHING;
