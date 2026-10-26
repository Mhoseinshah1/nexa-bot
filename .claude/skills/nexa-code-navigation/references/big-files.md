# Files over 800 lines (snapshot)

Taken on `main` at `78b06860` (2026-10-26). **The 800-line rule in `SKILL.md` is
what binds**, not this list: any file over 800 lines is read with `grep -n`, then a
range — listed here or not. Regenerate:

```bash
git ls-files | grep -v -e '^docs/research' -e lock | xargs wc -l | awk '$1>800' | sort -rn
```

Left out: `apps/api/drizzle/meta/NNNN_snapshot.json` (37–41k lines each; never open
one) and binary images under `docs/web-redesign/`. Lines, then path.

## apps/api — modules (80)

```text
  6044 apps/api/src/modules/commerce/payments/application/payment.service.ts
  4609 apps/api/src/modules/commerce/payments/application/gateway-payment.service.ts
  4105 apps/api/src/modules/commerce/provisioning/application/provisioner.service.ts
  4028 apps/api/src/modules/platform/legacy-importer/application/legacy-importer.service.ts
  2737 apps/api/src/modules/platform/identity/application/admin-management.service.ts
  2718 apps/api/src/modules/commerce/orders/application/order.service.ts
  2491 apps/api/src/modules/commerce/provisioning/application/provisioning.service.ts
  2248 apps/api/src/modules/platform/panels/application/panel.service.ts
  2153 apps/api/src/modules/platform/legacy-migration/infrastructure/nxpkg-migration-adapters.ts
  2070 apps/api/src/modules/commerce/campaigns/application/campaign.service.ts
  1991 apps/api/src/modules/commerce/commercial/application/commercial-action.service.ts
  1940 apps/api/src/modules/commerce/messaging/infrastructure/telegram-customer-messenger.ts
  1895 apps/api/src/modules/platform/tenancy/application/bot-bootstrap.service.ts
  1756 apps/api/src/modules/commerce/tickets/application/ticket.service.ts
  1650 apps/api/src/modules/commerce/messaging/application/customer-notification.service.ts
  1646 apps/api/src/modules/commerce/payments/application/gateway-invoice-ports.ts
  1641 apps/api/src/modules/control/ops-group/application/ops-group.service.ts
  1630 apps/api/src/modules/commerce/provisioning/infrastructure/drizzle-service.repository.ts
  1621 apps/api/src/modules/commerce/payments/application/payment-gateway.service.ts
  1583 apps/api/src/modules/platform/panels/application/panel-monitor.service.ts
  1578 apps/api/src/modules/commerce/payments/application/service-refund-request.service.ts
  1578 apps/api/src/modules/commerce/payments/application/refund.service.ts
  1544 apps/api/src/modules/platform/incidents/application/incident.service.ts
  1515 apps/api/src/modules/commerce/provisioning/application/ports.ts
  1514 apps/api/src/modules/commerce/reporting/application/reporting.service.ts
  1503 apps/api/src/modules/commerce/reporting/infrastructure/drizzle-reporting.repository.ts
  1500 apps/api/src/modules/commerce/provisioning/infrastructure/drizzle-operation.repository.ts
  1460 apps/api/src/modules/platform/recovery/application/recovery-executor.ts
  1448 apps/api/src/modules/platform/panels/infrastructure/drizzle-panel.repository.ts
  1448 apps/api/src/modules/commerce/resellers/application/reseller-admin.service.ts
  1396 apps/api/src/modules/platform/tenancy/application/bot-management.service.ts
  1394 apps/api/src/modules/commerce/payments/infrastructure/drizzle-gateway-invoice.repository.ts
  1383 apps/api/src/modules/commerce/payments/infrastructure/drizzle-payment.repository.ts
  1379 apps/api/src/modules/control/support-knowledge/infrastructure/drizzle-support-knowledge.repository.ts
  1367 apps/api/src/modules/platform/backup/application/backup.service.ts
  1365 apps/api/src/modules/commerce/provisioning/application/delivery.service.ts
  1351 apps/api/src/modules/commerce/broadcasts/application/broadcast.service.ts
  1319 apps/api/src/modules/commerce/broadcasts/infrastructure/drizzle-broadcast.repository.ts
  1301 apps/api/src/modules/control/notifications/application/notification-dispatcher.ts
  1275 apps/api/src/modules/commerce/business-chats/infrastructure/drizzle-business-conversation.repository.ts
  1234 apps/api/src/modules/platform/legacy-migration/application/legacy-migration-executor.ts
  1213 apps/api/src/modules/platform/legacy-migration/application/legacy-migration.service.ts
  1209 apps/api/src/modules/control/notifications/infrastructure/drizzle-notification.repository.ts
  1178 apps/api/src/modules/commerce/resellers/infrastructure/drizzle-reseller.repository.ts
  1134 apps/api/src/modules/platform/identity/application/authentication.service.ts
  1100 apps/api/src/modules/control/support-ai/infrastructure/drizzle-support-ai-job.repository.ts
  1088 apps/api/src/modules/platform/backup/infrastructure/pg-tools.ts
  1085 apps/api/src/modules/commerce/bulk-operations/application/bulk-operation.service.ts
  1082 apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository.ts
  1078 apps/api/src/modules/control/support-ai/eval/corpus.ts
  1050 apps/api/src/modules/commerce/business-chats/application/business-conversation.service.ts
  1030 apps/api/src/modules/commerce/catalog/application/product.service.ts
  1017 apps/api/src/modules/commerce/legacy-product-review/application/legacy-product-review.service.ts
  1008 apps/api/src/modules/platform/providers/infrastructure/sanaei.adapter.ts
  1006 apps/api/src/modules/commerce/ops-log/application/presenters.ts
   978 apps/api/src/modules/platform/legacy-importer/infrastructure/rickpanel-inventory-source.ts
   976 apps/api/src/modules/commerce/customers/application/customer.service.ts
   966 apps/api/src/modules/platform/providers/infrastructure/rickpanel.adapter.ts
   962 apps/api/src/modules/control/support-ai/application/support-auto-reply.service.ts
   959 apps/api/src/modules/platform/recovery/application/installation-key.service.ts
   948 apps/api/src/modules/commerce/catalog/application/product-category.service.ts
   940 apps/api/src/modules/platform/providers/infrastructure/rickpanel-inventory.ts
   937 apps/api/src/modules/commerce/bulk-operations/infrastructure/drizzle-bulk-operation.repository.ts
   929 apps/api/src/modules/platform/recovery/application/recovery.service.ts
   921 apps/api/src/modules/commerce/fx/application/fx.service.ts
   915 apps/api/src/modules/commerce/provisioning/application/service-reminder.service.ts
   904 apps/api/src/modules/platform/identity/application/account-security.service.ts
   892 apps/api/src/modules/platform/legacy-import/infrastructure/drizzle-legacy-import.repository.ts
   891 apps/api/src/modules/platform/legacy-importer/application/plan.ts
   871 apps/api/src/modules/control/support-ai/application/support-assist.service.ts
   869 apps/api/src/modules/commerce/payments/infrastructure/drizzle-gateway-card-transfer.repository.ts
   863 apps/api/src/modules/commerce/tickets/infrastructure/drizzle-ticket.repository.ts
   857 apps/api/src/modules/commerce/payments/application/financial-log.consumer.ts
   846 apps/api/src/modules/control/bot-menu-builder/application/bot-menu-builder.service.ts
   842 apps/api/src/modules/platform/legacy-invoice-archive/application/legacy-invoice-archive.service.ts
   838 apps/api/src/modules/control/support-ai/application/support-ai-config.service.ts
   836 apps/api/src/modules/commerce/messaging/application/ports.ts
   819 apps/api/src/modules/platform/legacy-importer/infrastructure/drizzle-legacy-importer.repository.ts
   807 apps/api/src/modules/commerce/business-chats/application/ports.ts
   803 apps/api/src/modules/commerce/campaigns/infrastructure/drizzle-campaign.repository.ts
```

## apps/api — surfaces (12)

```text
  2493 apps/api/src/surfaces/telegram/bot-runtime.ts
  1651 apps/api/src/surfaces/telegram/runtime/intent-of.ts
  1570 apps/api/src/surfaces/telegram/runtime/admin-services-flow.ts
  1386 apps/api/src/surfaces/telegram/runtime/admin-review-flow.ts
  1291 apps/api/src/surfaces/telegram/runtime/admin-customers-flow.ts
  1191 apps/api/src/surfaces/telegram/runtime/card-receipt-flow.ts
  1133 apps/api/src/surfaces/telegram/runtime/service-card-flow.ts
  1065 apps/api/src/surfaces/telegram/runtime/purchase-flow.ts
  1021 apps/api/src/surfaces/telegram/runtime/payment-screens.ts
  1009 apps/api/src/surfaces/telegram/runtime/admin-flow.ts
   885 apps/api/src/surfaces/telegram/runtime/callbacks.ts
   829 apps/api/src/surfaces/web/payments.controller.ts
```

## apps/api — other (7)

```text
 17020 apps/api/src/infrastructure/persistence/schema.ts
  8777 apps/api/src/container.ts
  1611 apps/api/src/legacy-import.cli.ts
  1577 apps/api/src/infrastructure/telegram/send-message.ts
  1458 apps/api/src/infrastructure/config/config.schema.ts
   904 apps/api/src/infrastructure/redaction.ts
   822 apps/api/src/infrastructure/persistence/online-indexes.ts
```

## apps/web (54)

```text
 11245 apps/web/src/i18n/web.fa.ts
  5516 apps/web/src/api/client.ts
  4051 apps/web/src/i18n/templates.fa.ts
  3302 apps/web/src/styles/kit.css
  3195 apps/web/src/pages/panels.tsx
  3015 apps/web/src/pages/payments.tsx
  2602 apps/web/src/ui/kit.tsx
  2472 apps/web/src/pages/campaigns.tsx
  2335 apps/web/src/pages/discounts.tsx
  2172 apps/web/src/pages/broadcasts.tsx
  2169 apps/web/src/pages/customer-360.tsx
  2108 apps/web/src/pages/business.tsx
  2041 apps/web/src/app.tsx
  1924 apps/web/src/pages/recovery-mirza.tsx
  1876 apps/web/src/pages/products.tsx
  1873 apps/web/src/pages/tickets.tsx
  1707 apps/web/src/pages/system.tsx
  1664 apps/web/src/styles/ui.css
  1601 apps/web/src/pages/payment-gateways.tsx
  1567 apps/web/src/pages/services.tsx
  1563 apps/web/src/pages/settings.tsx
  1530 apps/web/src/styles/pages/ops-b.css
  1425 apps/web/src/pages/dashboard.tsx
  1400 apps/web/src/pages/incidents.tsx
  1400 apps/web/src/pages/content.tsx
  1358 apps/web/src/pages/customer-360-sections.tsx
  1349 apps/web/src/pages/recovery.tsx
  1325 apps/web/src/pages/reseller-plans.tsx
  1322 apps/web/src/pages/orders.tsx
  1278 apps/web/src/pages/support-ai.tsx
  1265 apps/web/src/pages/custom-service.tsx
  1218 apps/web/src/pages/client-apps.tsx
  1159 apps/web/src/pages/reminders.tsx
  1151 apps/web/src/pages/resellers.tsx
  1136 apps/web/src/pages/bulk-operations.tsx
  1090 apps/web/src/styles/pages/ops-a.css
  1081 apps/web/src/pages/reseller-tiers.tsx
  1059 apps/web/src/pages/business-chats.tsx
  1052 apps/web/src/ui/audience-builder/index.tsx
  1037 apps/web/src/pages/service-ops.tsx
  1020 apps/web/src/styles/shell.css
   997 apps/web/src/pages/bot-buttons/builder.tsx
   995 apps/web/src/pages/support-knowledge.tsx
   961 apps/web/src/styles/pages/dashboard.css
   925 apps/web/src/pages/alerts.tsx
   923 apps/web/src/pages/audit-log.tsx
   892 apps/web/src/error-text.ts
   881 apps/web/src/pages/account.tsx
   866 apps/web/src/settings-presentation.ts
   850 apps/web/src/pages/bot-buttons/inline-buttons.tsx
   845 apps/web/src/pages/referrals.tsx
   828 apps/web/src/styles/pages/commerce-b.css
   822 apps/web/src/pages/panel-advanced.tsx
   805 apps/web/src/ui/date-field.tsx
```

## packages (17)

```text
 13612 packages/contracts/src/templates.ts
  7176 packages/contracts/src/http.ts
  2330 packages/contracts/src/settings.ts
  1919 packages/contracts/src/provider.ts
  1805 packages/contracts/src/errors.ts
  1570 packages/i18n/src/catalogue.fa.ts
  1221 packages/contracts/src/permissions.ts
  1153 packages/contracts/src/support-ai.ts
  1122 packages/contracts/src/ops-log-types.ts
   958 packages/contracts/src/payment-gateways.ts
   944 packages/contracts/src/customer-notifications.ts
   910 packages/contracts/src/reporting.ts
   909 packages/contracts/src/broadcasts.ts
   878 packages/contracts/src/tickets.ts
   854 packages/contracts/src/service-username.ts
   822 packages/contracts/src/promotions.ts
   803 packages/contracts/src/legacy-migration-routes.ts
```

## tests/integration (109)

```text
  4241 tests/integration/panel-monitor.test.ts
  3804 tests/integration/support-auto-reply.test.ts
  3329 tests/integration/codex-findings-round-2.test.ts
  3280 tests/integration/tonpays-gateway.test.ts
  2970 tests/integration/service-refund-requests.test.ts
  2878 tests/integration/legacy-importer.test.ts
  2570 tests/integration/service-management.test.ts
  2515 tests/integration/provisioning-delivery.test.ts
  2362 tests/integration/resellers.test.ts
  2254 tests/integration/panels.test.ts
  2175 tests/integration/referrals.test.ts
  2171 tests/integration/tickets.test.ts
  2139 tests/integration/payments.test.ts
  2103 tests/integration/tonpays-telegram-review-window.test.ts
  2022 tests/integration/panels-http.test.ts
  1866 tests/integration/nxpkg-live-panel-inventory.test.ts
  1816 tests/integration/location-change.test.ts
  1752 tests/integration/telegram-admin-services.test.ts
  1731 tests/integration/ops-log-group.test.ts
  1727 tests/integration/customer-ux-services.test.ts
  1595 tests/integration/telegram-payment-flow.test.ts
  1565 tests/integration/payment-accounts.test.ts
  1534 tests/integration/campaigns.test.ts
  1489 tests/integration/round-n-close.test.ts
  1475 tests/integration/web-admin-v2.test.ts
  1472 tests/integration/tonpays-telegram-gateway.test.ts
  1468 tests/integration/admin-security.test.ts
  1461 tests/integration/service-transfer.test.ts
  1458 tests/integration/support-learning.test.ts
  1452 tests/integration/refunds.test.ts
  1436 tests/integration/control-plane-review-round-3.test.ts
  1428 tests/integration/legacy-migration-nxpkg.test.ts
  1396 tests/integration/custom-service.test.ts
  1384 tests/integration/tonpays-telegram-round6.test.ts
  1379 tests/integration/recovery-executor.test.ts
  1360 tests/integration/customer-order-actions.test.ts
  1358 tests/integration/identity-concurrency.test.ts
  1321 tests/integration/client-apps.test.ts
  1312 tests/integration/r2-wizard-edit-in-place.test.ts
  1304 tests/integration/miniapp-surface.test.ts
  1301 tests/integration/legacy-service-review.test.ts
  1269 tests/integration/nxpkg-case-variant-p1.test.ts
  1264 tests/integration/wallet-topup.test.ts
  1256 tests/integration/terms.test.ts
  1249 tests/integration/telegram-order-flow.test.ts
  1246 tests/integration/legacy-adoption.test.ts
  1238 tests/integration/admin-http.test.ts
  1237 tests/integration/support-assist.test.ts
  1223 tests/integration/trials.test.ts
  1219 tests/integration/legacy-cutover.test.ts
  1211 tests/integration/late-gateway-credit.test.ts
  1186 tests/integration/bot-menu-builder.test.ts
  1176 tests/integration/automatic-refund.test.ts
  1168 tests/integration/telegram-stars.test.ts
  1165 tests/integration/products-http.test.ts
  1162 tests/integration/telegram-customer-turn.test.ts
  1155 tests/integration/provisioning.test.ts
  1135 tests/integration/receipt-dispositions.test.ts
  1135 tests/integration/panel-capacity.test.ts
  1135 tests/integration/incidents.test.ts
  1134 tests/integration/legacy-materialize-history.test.ts
  1120 tests/integration/wallet-payments-http.test.ts
  1077 tests/integration/extra-devices.test.ts
  1076 tests/integration/telegram-admin.test.ts
  1076 tests/integration/referral-signup-gift.test.ts
  1072 tests/integration/service-operations-http.test.ts
  1059 tests/integration/customer-360.test.ts
  1049 tests/integration/wp-a9-reminders.test.ts
  1044 tests/integration/support-tb10.test.ts
  1019 tests/integration/services-http.test.ts
   997 tests/integration/service-username.test.ts
   994 tests/integration/customer-ux-payments.test.ts
   977 tests/integration/pricing-discounts.test.ts
   977 tests/integration/legacy-review-queue.test.ts
   976 tests/integration/bot-management.test.ts
   971 tests/integration/fx-stars.test.ts
   970 tests/integration/tetrapay-gateway.test.ts
   962 tests/integration/payment-discovery-latency.test.ts
   958 tests/integration/payment-settlement-latency.test.ts
   958 tests/integration/nowpayments-gateway.test.ts
   955 tests/integration/dashboard.test.ts
   949 tests/integration/reports.test.ts
   946 tests/integration/payment-operations.test.ts
   941 tests/integration/web-disaster-recovery.test.ts
   939 tests/integration/legacy-invoice-archive.test.ts
   937 tests/integration/backup.test.ts
   935 tests/integration/reseller-plan-controls.test.ts
   926 tests/integration/notification-claim-ownership.test.ts
   921 tests/integration/support-ai-config.test.ts
   921 tests/integration/centralpay-gateway.test.ts
   908 tests/integration/financial-reports.test.ts
   895 tests/integration/support-knowledge-build.test.ts
   889 tests/integration/r9-char-admin.test.ts
   886 tests/integration/legacy-product-review.test.ts
   886 tests/integration/customers-http.test.ts
   881 tests/integration/telegram-admin-customers.test.ts
   880 tests/integration/legacy-materialize-catalog.test.ts
   862 tests/integration/support-vision.test.ts
   859 tests/integration/payment-receipts.test.ts
   853 tests/integration/panel-advanced-settings.test.ts
   851 tests/integration/rbac.test.ts
   842 tests/integration/transactional-authorization.test.ts
   838 tests/integration/support-context.test.ts
   822 tests/integration/r3-service-card.test.ts
   815 tests/integration/rickpanel-rotate-link.test.ts
   813 tests/integration/bot-token-replacement.test.ts
   811 tests/integration/orders.test.ts
   808 tests/integration/reminder-quiet-hours.test.ts
   803 tests/integration/ops-log-nightly-reader.test.ts
```

## tests/unit (23)

```text
  2580 tests/unit/bot-runtime.test.ts
  2546 tests/unit/legacy-migration.test.ts
  2227 tests/unit/backup-pipeline.test.ts
  2169 tests/unit/bot-bootstrap.test.ts
  1461 tests/unit/ops-log-consumers.test.ts
  1400 tests/unit/rickpanel-targeted-inventory.test.ts
  1274 tests/unit/rickpanel-adapter.test.ts
  1219 tests/unit/fx-service.test.ts
  1135 tests/unit/config-upgrade.test.ts
  1070 tests/unit/web-asset-publication.test.ts
  1064 tests/unit/nxpkg-import-checks.test.ts
  1023 tests/unit/delivery-qr-template.test.ts
  1011 tests/unit/sanaei-adapter.test.ts
   980 tests/unit/nxpkg-reader.test.ts
   969 tests/unit/ops-error-events.test.ts
   954 tests/unit/support-ai-vision.test.ts
   919 tests/unit/tonpays-telegram-screen.test.ts
   894 tests/unit/client-apps.test.ts
   888 tests/unit/deployment-compose.test.ts
   838 tests/unit/registries.test.ts
   836 tests/unit/ops-log-builders.test.ts
   830 tests/unit/panel-eligibility.test.ts
   814 tests/unit/nxpkg-inventory-completeness.test.ts
```

## tests/web (27)

```text
  3464 tests/web/panels.test.tsx
  1954 tests/web/payments.test.tsx
  1927 tests/web/users.test.tsx
  1571 tests/web/resellers.test.tsx
  1483 tests/web/shots/fixtures/commerce-b.ts
  1446 tests/web/control-plane-pages.test.tsx
  1381 tests/web/bot-buttons-builder.test.tsx
  1340 tests/web/permissions-and-refresh.test.tsx
  1300 tests/web/settings-and-alerts.test.tsx
  1270 tests/web/services.test.tsx
  1241 tests/web/recovery-mirza.test.tsx
  1177 tests/web/products-and-orders.test.tsx
  1124 tests/web/recovery.test.tsx
   979 tests/web/shots/fixtures/demo-parity/finance.ts
   961 tests/web/payment-gateways.test.tsx
   957 tests/web/tickets.test.tsx
   938 tests/web/discounts.test.tsx
   926 tests/web/shots/fixtures/demo-parity/infra.ts
   898 tests/web/shell-recovery.test.tsx
   889 tests/web/dashboard.test.tsx
   885 tests/web/kit.test.tsx
   861 tests/web/shots/fixtures/demo-parity/support.ts
   848 tests/web/campaigns.test.tsx
   819 tests/web/search-autoapply.test.tsx
   809 tests/web/miniapp-account.test.tsx
   803 tests/web/editor-rules.test.tsx
   801 tests/web/support-ai.test.tsx
```

## tests — other (5)

```text
  6281 tests/deploy/botctl.test.sh
  1173 tests/deploy/harness.sh
   887 tests/support/legacy-migration-rig.ts
   815 tests/support/fake-3xui.ts
   808 tests/fixtures/nxpkg/expected.json
```

## deploy and scripts (8)

```text
  2789 deploy/bin/nexa-lib.sh
  2683 deploy/bin/botctl
  1789 scripts/legacy-rehearsal.sh
  1508 deploy/install.sh
  1252 scripts/check-falsification-citations.mjs
  1057 scripts/legacy-archive-inspect.mjs
   824 scripts/check-boundaries.sh
   801 scripts/deployment-update-smoke.sh
```

## docs (15)

```text
 12127 docs/web-redesign/demo-parity/reference/approved-demo.html
  6226 docs/phase3d-falsification.md
  4444 docs/open-questions.md
  3040 docs/deployment.md
  1781 docs/legacy-migration/final-report-v2.schema.json
  1716 docs/config-upgrade-falsification.md
  1421 docs/tonpays-telegram-gateway-audit.md
  1236 docs/web-redesign/commerce-a.md
  1054 docs/legacy-migration/importer.md
   906 docs/legacy-migration/cutover-runbook.md
   905 docs/PROGRESS.md
   887 docs/web-redesign/commerce-b.md
   833 docs/adr/0023-providers-panels-credentials-health.md
   815 docs/round-t-button-builder-audit.md
   815 docs/backup.md
```
