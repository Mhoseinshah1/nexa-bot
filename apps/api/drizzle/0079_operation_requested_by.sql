ALTER TABLE "provisioning_operations" ADD COLUMN "requested_by_customer_id" uuid;--> statement-breakpoint
ALTER TABLE "provisioning_operations" ADD CONSTRAINT "provisioning_operations_requested_by_fk" FOREIGN KEY ("tenant_id","requested_by_customer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
/*
 * The backfill, and why it is exact rather than a guess.
 *
 * Every existing row of these six types WAS asked for by the service's own customer.
 * `requestFromOperator` is Phase 6A and reaches a panel through no released build, so
 * until this migration runs there has never been an operator-planned SUSPEND, RESUME,
 * TERMINATE, RENEW, ADD_TRAFFIC or ADD_TIME anywhere. Leaving them NULL instead would
 * silence the outcome message for every one of them that is still open — a customer
 * who paid for a renewal, told nothing when it lands.
 *
 * The other four types stay NULL, which is what they mean: PROVISION and RECONCILE
 * are this installation's own work, SYNC_USAGE is housekeeping, and none of them is
 * announced as a customer's request.
 */
UPDATE "provisioning_operations" AS o
   SET "requested_by_customer_id" = s."customer_id"
  FROM "services" AS s
 WHERE s."tenant_id" = o."tenant_id"
   AND s."id" = o."service_id"
   AND o."type" IN ('SUSPEND', 'RESUME', 'TERMINATE', 'RENEW', 'ADD_TRAFFIC', 'ADD_TIME');
