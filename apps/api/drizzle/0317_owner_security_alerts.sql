CREATE TABLE "admin_known_ips" (
	"tenant_id" uuid NOT NULL,
	"admin_id" uuid NOT NULL,
	"ip" text NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	CONSTRAINT "admin_known_ips_pkey" PRIMARY KEY("tenant_id","admin_id","ip"),
	CONSTRAINT "admin_known_ips_ip_check" CHECK (length(ip) BETWEEN 2 AND 64)
);
--> statement-breakpoint
CREATE TABLE "admin_read_windows" (
	"tenant_id" uuid NOT NULL,
	"admin_id" uuid NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"rows_read" bigint DEFAULT 0 NOT NULL,
	"alerted_at" timestamp with time zone,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "admin_read_windows_pkey" PRIMARY KEY("tenant_id","admin_id","window_start"),
	CONSTRAINT "admin_read_windows_rows_check" CHECK (rows_read >= 0)
);
--> statement-breakpoint
ALTER TABLE "admin_known_ips" ADD CONSTRAINT "admin_known_ips_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_known_ips" ADD CONSTRAINT "admin_known_ips_tenant_admin_fk" FOREIGN KEY ("tenant_id","admin_id") REFERENCES "public"."admins"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_read_windows" ADD CONSTRAINT "admin_read_windows_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_read_windows" ADD CONSTRAINT "admin_read_windows_tenant_admin_fk" FOREIGN KEY ("tenant_id","admin_id") REFERENCES "public"."admins"("tenant_id","id") ON DELETE no action ON UPDATE no action;