-- Package F — a customer hands a service to another customer of the tenant
-- (docs/package-f-service-transfer-audit.md).
--
-- Only services.customer_id moves. Two composite foreign keys made that impossible, and
-- each is replaced by what it actually protected:
--
--   - services_order_fk (tenant, order, customer) -> orders becomes (tenant, order), and
--     nexa_services_ownership_guard keeps the rule it encoded where it is still true: at
--     INSERT a service's customer is its order's. Afterwards order_id is immutable, and
--     customer_id changes only when the NEWEST service_ownership_transfers row for the
--     service names exactly that old owner and that new one.
--   - service_commercial_actions_service_fk (tenant, service, customer) -> services becomes
--     (tenant, service), and nexa_commercial_action_owner_guard requires the row's customer
--     to own the service when the row is written. The order reference still pins the payer.
--
-- service_ownership_transfers is append-only, like audit_logs. Two CHECK lists are re-pinned
-- with the new capture purpose and notification kind.
--
-- Rollback: this only widens what may be written. Every existing row satisfies both rules
-- as it stands. The previous release reads a transferred service without complaint, because
-- the three-column keys it relied on are gone; restoring them would fail on such a row, and
-- no rollback restores them.
CREATE TABLE "service_ownership_transfers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "service_ownership_transfers_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"service_id" uuid NOT NULL,
	"from_customer_id" uuid NOT NULL,
	"to_customer_id" uuid NOT NULL,
	"bot_instance_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_label" text,
	"correlation_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_ownership_transfers_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "service_ownership_transfers_key" UNIQUE("tenant_id","idempotency_key"),
	CONSTRAINT "service_ownership_transfers_parties_check" CHECK (from_customer_id <> to_customer_id),
	CONSTRAINT "service_ownership_transfers_actor_type_check" CHECK (actor_type IN ('CUSTOMER', 'TELEGRAM_ADMIN', 'WEB_ADMIN', 'SYSTEM_JOB', 'API', 'PROVIDER_SYNC')),
	CONSTRAINT "service_ownership_transfers_key_check" CHECK (length(idempotency_key) BETWEEN 1 AND 200)
);
--> statement-breakpoint
ALTER TABLE "customer_notifications" DROP CONSTRAINT "customer_notifications_kind_check";--> statement-breakpoint
ALTER TABLE "customer_text_captures" DROP CONSTRAINT "customer_text_captures_purpose_check";--> statement-breakpoint
ALTER TABLE "customer_text_captures" DROP CONSTRAINT "customer_text_captures_subject_check";--> statement-breakpoint
ALTER TABLE "service_commercial_actions" DROP CONSTRAINT "service_commercial_actions_service_fk";
--> statement-breakpoint
ALTER TABLE "services" DROP CONSTRAINT "services_order_fk";
--> statement-breakpoint
ALTER TABLE "service_ownership_transfers" ADD CONSTRAINT "service_ownership_transfers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_ownership_transfers" ADD CONSTRAINT "service_ownership_transfers_bot_instance_id_bot_instances_id_fk" FOREIGN KEY ("bot_instance_id") REFERENCES "public"."bot_instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_ownership_transfers" ADD CONSTRAINT "service_ownership_transfers_service_fk" FOREIGN KEY ("tenant_id","service_id") REFERENCES "public"."services"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_ownership_transfers" ADD CONSTRAINT "service_ownership_transfers_from_fk" FOREIGN KEY ("tenant_id","from_customer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_ownership_transfers" ADD CONSTRAINT "service_ownership_transfers_to_fk" FOREIGN KEY ("tenant_id","to_customer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "service_ownership_transfers_service_idx" ON "service_ownership_transfers" USING btree ("tenant_id","service_id","seq");--> statement-breakpoint
ALTER TABLE "service_commercial_actions" ADD CONSTRAINT "service_commercial_actions_service_fk" FOREIGN KEY ("tenant_id","service_id") REFERENCES "public"."services"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."orders"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_notifications" ADD CONSTRAINT "customer_notifications_kind_check" CHECK (kind IN ('PAYMENT_REJECTED', 'PAYMENT_EXPIRED', 'ORDER_EXPIRED', 'SERVICE_ACTION_SUCCEEDED', 'SERVICE_ACTION_FAILED', 'SERVICE_PROVISION_DELAYED', 'PAYMENT_TRANSFER_RECORDED', 'ORDER_CANCELLED', 'WALLET_TOPUP_CREDITED', 'ORDER_REFUNDED_TO_WALLET', 'SERVICE_EXPIRY_FIRST', 'SERVICE_EXPIRY_SECOND', 'SERVICE_EXPIRED', 'SERVICE_USAGE_FIRST', 'SERVICE_USAGE_SECOND', 'SERVICE_USAGE_FINAL', 'TRIAL_NOT_DELIVERED', 'RECEIPT_CREDITED_TO_WALLET', 'WALLET_TOPUP_GIFT_CREDITED', 'REFUND_COMPLETED', 'GATEWAY_PAYMENT_FAILED', 'SERVICE_REFUND_REQUEST_REGISTERED', 'SERVICE_REFUND_REQUEST_APPROVED', 'SERVICE_REFUND_REQUEST_REJECTED', 'SERVICE_TRANSFER_RECEIVED'));--> statement-breakpoint
ALTER TABLE "customer_text_captures" ADD CONSTRAINT "customer_text_captures_purpose_check" CHECK (purpose IN ('TOPUP_AMOUNT', 'SERVICE_SEARCH', 'SERVICE_NOTE', 'SERVICE_REFUND_REASON', 'CUSTOM_SERVICE_VOLUME', 'CUSTOM_SERVICE_DAYS', 'SERVICE_TRANSFER_RECIPIENT'));--> statement-breakpoint
ALTER TABLE "customer_text_captures" ADD CONSTRAINT "customer_text_captures_subject_check" CHECK ((purpose IN ('SERVICE_NOTE', 'SERVICE_REFUND_REASON', 'CUSTOM_SERVICE_VOLUME', 'CUSTOM_SERVICE_DAYS', 'SERVICE_TRANSFER_RECIPIENT')) = (subject_id IS NOT NULL));--> statement-breakpoint
-- A service's customer is its order's when it is written, and changes afterwards only
-- through a transfer row written in the same transaction. The order it was bought by never
-- changes: history, refunds and reports name it.
CREATE FUNCTION nexa_services_ownership_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  order_customer uuid;
  newest_from uuid;
  newest_to uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT customer_id INTO order_customer
      FROM orders
     WHERE tenant_id = NEW.tenant_id AND id = NEW.order_id;
    IF order_customer IS NOT NULL AND order_customer <> NEW.customer_id THEN
      RAISE EXCEPTION
        'service % must belong to the customer of order %', NEW.id, NEW.order_id
        USING ERRCODE = 'raise_exception';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.order_id IS DISTINCT FROM OLD.order_id THEN
    RAISE EXCEPTION
      'service % keeps the tenant and the order it was bought by', OLD.id
      USING ERRCODE = 'raise_exception';
  END IF;
  IF NEW.customer_id IS DISTINCT FROM OLD.customer_id THEN
    SELECT from_customer_id, to_customer_id INTO newest_from, newest_to
      FROM service_ownership_transfers
     WHERE tenant_id = NEW.tenant_id AND service_id = NEW.id
     ORDER BY seq DESC
     LIMIT 1;
    IF newest_from IS DISTINCT FROM OLD.customer_id OR newest_to IS DISTINCT FROM NEW.customer_id THEN
      RAISE EXCEPTION
        'service % changes owner only through a service_ownership_transfers row', OLD.id
        USING ERRCODE = 'raise_exception';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER nexa_services_ownership_insert
  BEFORE INSERT ON services
  FOR EACH ROW EXECUTE FUNCTION nexa_services_ownership_guard();--> statement-breakpoint
CREATE TRIGGER nexa_services_ownership_update
  BEFORE UPDATE OF tenant_id, order_id, customer_id ON services
  FOR EACH ROW EXECUTE FUNCTION nexa_services_ownership_guard();--> statement-breakpoint
-- A renewal or an add-on is recorded against the customer who OWNS the service when it is
-- written. The owner is read FOR KEY SHARE: a transfer's reassignment of customer_id holds
-- FOR UPDATE on the row (customer_id is in services_tenant_id_customer_key), so an insert
-- arriving during one waits for it and then reads the new owner.
CREATE FUNCTION nexa_commercial_action_owner_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  owner uuid;
BEGIN
  SELECT customer_id INTO owner
    FROM services
   WHERE tenant_id = NEW.tenant_id AND id = NEW.service_id
   FOR KEY SHARE;
  IF owner IS NOT NULL AND owner <> NEW.customer_id THEN
    RAISE EXCEPTION
      'service % is not owned by customer %', NEW.service_id, NEW.customer_id
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER nexa_commercial_action_owner
  BEFORE INSERT ON service_commercial_actions
  FOR EACH ROW EXECUTE FUNCTION nexa_commercial_action_owner_guard();--> statement-breakpoint
-- The evidence a service changed hands, and what the ownership guard reads: never edited,
-- never removed. The same function audit_logs uses.
CREATE TRIGGER service_ownership_transfers_no_update
  BEFORE UPDATE ON service_ownership_transfers
  FOR EACH ROW EXECUTE FUNCTION nexa_reject_mutation();--> statement-breakpoint
CREATE TRIGGER service_ownership_transfers_no_delete
  BEFORE DELETE ON service_ownership_transfers
  FOR EACH ROW EXECUTE FUNCTION nexa_reject_mutation();
