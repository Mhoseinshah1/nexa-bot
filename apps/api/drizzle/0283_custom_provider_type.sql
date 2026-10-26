ALTER TABLE "client_apps" DROP CONSTRAINT "client_apps_provider_types_check";--> statement-breakpoint
ALTER TABLE "panels" DROP CONSTRAINT "panels_provider_type_check";--> statement-breakpoint
ALTER TABLE "client_apps" ADD CONSTRAINT "client_apps_provider_types_check" CHECK (provider_types <@ ARRAY['marzban', 'rickpanel', 'sanaei', 'custom']::text[]);--> statement-breakpoint
ALTER TABLE "panels" ADD CONSTRAINT "panels_provider_type_check" CHECK (provider_type IN ('marzban', 'rickpanel', 'sanaei', 'custom'));