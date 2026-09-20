ALTER TABLE "service_reminders" DROP CONSTRAINT "service_reminders_basis_check";--> statement-breakpoint
ALTER TABLE "service_reminders" ALTER COLUMN "basis_traffic_limit_bytes" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "service_reminders" ADD CONSTRAINT "service_reminders_basis_check" CHECK ("service_reminders"."basis_traffic_limit_bytes" >= 0);