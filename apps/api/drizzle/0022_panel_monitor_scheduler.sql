CREATE TABLE "panel_monitor_schedule" (
	"panel_id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"next_eligible_at" timestamp with time zone NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"deferred_reason" text,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "panel_monitor_schedule_deferred_reason_check" CHECK (deferred_reason IS NULL OR deferred_reason IN ('CREDENTIALS_MISSING', 'TARGET_BLOCKED', 'STATUS_NOT_PROBEABLE', 'COOLDOWN', 'BUDGET_EXHAUSTED', 'NOT_AUTHORIZED'))
);
--> statement-breakpoint
CREATE TABLE "panel_monitor_tenants" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"next_eligible_at" timestamp with time zone NOT NULL,
	"last_served_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "panel_monitor_schedule" ADD CONSTRAINT "panel_monitor_schedule_panel_id_panels_id_fk" FOREIGN KEY ("panel_id") REFERENCES "public"."panels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "panel_monitor_schedule" ADD CONSTRAINT "panel_monitor_schedule_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "panel_monitor_schedule" ADD CONSTRAINT "panel_monitor_schedule_tenant_panel_fk" FOREIGN KEY ("tenant_id","panel_id") REFERENCES "public"."panels"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "panel_monitor_tenants" ADD CONSTRAINT "panel_monitor_tenants_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "panel_monitor_schedule_due_idx" ON "panel_monitor_schedule" USING btree ("tenant_id","next_eligible_at","panel_id");--> statement-breakpoint
CREATE INDEX "panel_monitor_tenants_rotation_idx" ON "panel_monitor_tenants" USING btree ("next_eligible_at","last_served_at");--> statement-breakpoint
-- Backfill: every existing panel gets a schedule row, and every tenant that
-- owns one gets a rotation row.
--
-- Not optional and not deferrable to the application. A panel with no schedule
-- row is a panel the monitor cannot see, and "create it lazily the first time
-- the monitor meets the panel" is circular — the monitor only meets panels the
-- schedule tells it about. An installation upgrading with panels already in it
-- would simply stop monitoring them, silently, which is the failure this whole
-- phase exists to prevent.
--
-- ACTIVE panels become eligible now: the first tick after an upgrade probes
-- what it should, spread by the deterministic per-panel offset as it goes.
-- Everything else is eligible in year 9999, which is the monitor's real status
-- filter — a DISABLED panel is not skipped by the discovery scan, it is outside
-- the range the scan reads. A concrete far-future timestamp rather than
-- 'infinity' because node-postgres parses an infinite timestamptz to the NUMBER
-- Infinity rather than to a Date, and the application reads this column.
INSERT INTO panel_monitor_schedule
  (panel_id, tenant_id, next_eligible_at, consecutive_failures, deferred_reason, updated_at)
SELECT p.id,
       p.tenant_id,
       CASE WHEN p.status = 'ACTIVE' THEN now() ELSE timestamptz '9999-12-31 23:59:59+00' END,
       0,
       CASE WHEN p.status = 'ACTIVE' THEN NULL ELSE 'STATUS_NOT_PROBEABLE' END,
       now()
  FROM panels p
    ON CONFLICT (panel_id) DO NOTHING;
--> statement-breakpoint
-- `to_timestamp(0)` rather than '-infinity', to match exactly what the
-- application writes for a tenant that has never been served. Two spellings of
-- "first in the queue" would work and would differ in one place, which is how a
-- rotation order becomes untestable.
INSERT INTO panel_monitor_tenants (tenant_id, next_eligible_at, last_served_at)
SELECT s.tenant_id, MIN(s.next_eligible_at), to_timestamp(0)
  FROM panel_monitor_schedule s
 GROUP BY s.tenant_id
    ON CONFLICT (tenant_id) DO NOTHING;
