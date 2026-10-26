CREATE TABLE "widgets" (
  "id" uuid PRIMARY KEY,
  "tenant_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE INDEX "widgets_tenant_idx" ON "widgets" ("tenant_id");
