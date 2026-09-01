# MASTER — MirzaBot Telegram Admin → Financial (`💎 مالی`) — AUTHORITATIVE

> Authoritative index for this phase. If any other file disagrees, this one wins.

## PHASE_STATUS
**PARTIAL.** The menu is fully mapped and one gateway schema is fully captured. Ten gateway schemas and
the five global settings remain uninspected.

## Scope
`👨‍💼 پنل مدیریت` → `💎 مالی`. **Read-only phase**: edit screens may be opened and inspected, but
nothing may be saved, toggled, submitted or confirmed.

## COMPLETED_AREAS
Full Financial menu map with byte-exact button strings · the 11-gateway inventory with enabled state and
colour · the `🔌 کارت به کارت` settings schema (16 controls) · the NOT_EXPOSED register · FBR-001..008.

## PARTIAL_AREAS
Gateway edit schemas — 1 of 11 captured.

## UNKNOWN_AREAS
The five global settings (`حداکثر/حداقل شارژ موجودی`, `آدرس ولت`, `نمایش/مخفی کردن درگاه همگانی`) ·
crypto gateway schemas (plisio, nowpayment) · FX gateway schemas and any exchange-rate fields · IPG
schemas (آقای پرداخت, زرین پال) · the custom gateway · Telegram Stars · gateway fee fields · whether
per-gateway or global amount limits win.

## NOT_EXPOSED
See `financial-not-exposed.md`. In short: no payment list, no ledger, no refunds, no settlements, no
reports, no dashboard **anywhere in this section**. Reporting lives in Bot Statistics; per-user money
lives in User Management.

## TEST_DATA
None. This phase creates no records.

## IMPORTANT_SOURCE_BUGS
None found in Financial yet.

## INCIDENTS
**INCIDENT-FIN-001 — a production gateway setting was written during a read-only phase.** A typed
navigation string arrived at the bot as a different menu label and the `🔌 کارت به کارت` tutorial was
overwritten. The gateway is currently disabled so no customer sees it. Full detail, cause and the
correction to method are in `incidents.md`. **Navigation in this section is now click-only.**

## AUTHORITATIVE_FILES
`menu-tree.md` · `payment-gateways.md` · `financial-not-exposed.md` · `business-rules.md` ·
`incidents.md` · this file.

## STALE_FILES
None.

## NEXT_PHASE
Finish the remaining gateway schemas and the five global settings, by clicking only.
