# Entities & Relations — User Management

STATUS: initial model, assembled from earlier phases. Every edge is labelled. Nothing here has yet been
verified from the Telegram User Management side; this is the hypothesis the phase will test.

```
        ┌──────────┐        ┌───────────────┐
        │  Admin   │───────►│   AdminLog    │
        └────┬─────┘        └───────────────┘
             │ acts on
             ▼
   ┌────────────────────┐  1..1   ┌──────────────┐
   │       User         │────────►│   UserTier   │  f / n / n2
   │  (Telegram id PK)  │         └──────────────┘
   └─┬───┬───┬───┬───┬──┘
     │   │   │   │   └──────────────► ResellerProfile  (expiry, discount %, sales bot, credit ceiling)
     │   │   │   └──────────────────► Wallet ──► WalletTransaction ──► Gateway
     │   │   └──────────────────────► Referral (referrer 1..1, referees 0..N) ──► ReferralCommission
     │   └──────────────────────────► Order ──► Payment
     │                                  └─────► Service ──► Panel
     └──────────────────────────────► Discount (per-user %)
```

| Relationship | Cardinality | Confidence |
|---|---|---|
| User → UserTier | exactly 1 | **VERIFIED** (prior phases, both surfaces) |
| User → Wallet | exactly 1, single Toman balance, no sub-currency | **VERIFIED** (payments-wallet.md) |
| Wallet → WalletTransaction | 1..N | **VERIFIED** |
| WalletTransaction → Gateway | 1..1, and admin manual adjustments are ledgered as pseudo-gateways (`افزایش موجودی توسط ادمین`, `کسر موجودی توسط ادمین`, `هدیه شروع`) | **VERIFIED** (robot statistics) |
| User → ResellerProfile | 0..1; fields exist for all tiers but setters only for n / n2 | **INFERRED** — the web UI renders the fields for `f` too |
| ResellerProfile → credit ceiling | present only for n2 | **VERIFIED** on the web side; Telegram side **UNKNOWN** |
| User → Referral (referrer) | 0..1, claimed permanent | **INFERRED** — proven only from bot copy, never behaviourally |
| User → Order | 1..N | **VERIFIED** |
| Order → Service | 0..1, provisioning is payment-gated | **VERIFIED** (BR-013) |
| Service → Panel | exactly 1 | **VERIFIED** |
| User → Discount (per-user %) | 0..1, a table separate from the reseller discount | **VERIFIED** on the web side; Telegram side **UNKNOWN** |
| Admin → AdminLog | 1..N, with a target user id (0 = none) | **VERIFIED** |
| Admin privilege → UserTier | **independent axes** | **VERIFIED** (TBR-018) |

## The distinctions that must not be collapsed

Prior phases show at least eight separate状態 concepts on or around a user. They are **not** one status
field:

1. **Account status** (exists / blocked)
2. **Blocked status** — its own flag with its own log verbs
3. **User tier** — f / n / n2
4. **Reseller status** — whether a reseller profile is active
5. **Reseller expiry** — a date, independent of the tier itself
6. **Wallet / credit state** — balance, plus a negative ceiling for n2
7. **Service status** — 7 values (فعال · حذف شده توسط کاربر · پرداخت نشده · حذف شده توسط ادمین · غیرفعال شده توسط ادمین · ناموجود در پنل · ناموفق)
8. **Config status** — activate/deactivate, proven distinct from deletion by the log verbs

`state-transitions.md` models these separately.
