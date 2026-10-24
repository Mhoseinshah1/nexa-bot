ALTER TABLE "fx_quotes" DROP CONSTRAINT "fx_quotes_source_check";--> statement-breakpoint
ALTER TABLE "fx_source_states" DROP CONSTRAINT "fx_source_states_source_check";--> statement-breakpoint
ALTER TABLE "gateway_invoices" DROP CONSTRAINT "gateway_invoices_fx_source_check";--> statement-breakpoint
ALTER TABLE "fx_quotes" ADD CONSTRAINT "fx_quotes_source_check" CHECK (source IS NULL OR source IN ('NOBITEX', 'WALLEX', 'TABDEAL', 'BITPIN', 'RAMZINEX'));--> statement-breakpoint
ALTER TABLE "fx_source_states" ADD CONSTRAINT "fx_source_states_source_check" CHECK (source IN ('NOBITEX', 'WALLEX', 'TABDEAL', 'BITPIN', 'RAMZINEX'));--> statement-breakpoint
ALTER TABLE "gateway_invoices" ADD CONSTRAINT "gateway_invoices_fx_source_check" CHECK (fx_source IS NULL OR fx_source IN ('NOBITEX', 'WALLEX', 'TABDEAL', 'BITPIN', 'RAMZINEX'));