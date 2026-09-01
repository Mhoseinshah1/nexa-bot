# Admin role ↔ customer tier (f / n / n2)

## Confirmed again, on a second and stronger data point

The Web-Admin phase recorded **TBR-018**: bot-admin privilege is orthogonal to customer tier,
evidenced by one account that was simultaneously a Normal User (`f`) customer and a full bot admin.

This phase produces an independent second point on **both** axes:

| Account | Customer tier | Admin role | Source |
|---|---|---|---|
| prior evidence | `f` — کاربر عادی | `👑 مدیر کل` (full) | Web-Admin phase |
| **`[TELEGRAM_USER_ID_REDACTED]`** | **`n` — نماینده عادی** | **`🧾 تأییدکنندهٔ رسید`** (narrowest) | this phase |

Two accounts, different tiers, different roles, all four values distinct. The axes are genuinely
independent. **VERIFIED.**

## Granting an admin role does not touch the customer tier

Directly tested: the customer record for `[TELEGRAM_USER_ID_REDACTED]` was read **after** the admin grant and shows

```
⭕️ نوع کاربری : نماینده عادی
```

— unchanged from the User-Management baseline, along with balance `390,000`, status `Active`, and
every other field. **Granting an admin role writes nothing to the customer record. VERIFIED.**

## The customer record has no admin field at all

The full `👀 اطلاعات کاربر` profile — 20+ fields covering identity, dates, verification, tier,
referral, reseller expiry and finance — contains **no** admin flag, no role, no "is staff" marker.
An operator looking at a customer cannot tell whether that person is an admin.

Conversely the admin list shows no tier. **The two surfaces are mutually blind.**

## Model consequence

```
TelegramUser (numeric id)
   ├── User          — customer record: tier ∈ {f, n, n2}, wallet, orders, …
   └── Admin         — admin record:    role ∈ {مدیر کل, فروشنده, پشتیبان, تأییدکنندهٔ رسید}
```

Two optional, independent records hanging off the same Telegram numeric id. Neither implies the
other; neither is aware of the other. A rebuild must keep `UserTier` and `AdminRole` as separate
dimensions — and should probably do what MirzaBot does not: surface each on the other's screen.

## What remains unknown

Whether an admin record can exist for a numeric id that has **no** customer record — i.e. someone who
has never started the bot. The add flow performed no validation of any kind, which suggests yes, but
testing it would mean submitting an id other than the authorised test account. **UNKNOWN**
(UNK-ADM-003).
