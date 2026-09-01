# Entity / relationship model — admin domain

```
                 ┌──────────────────────┐
                 │   TelegramUser       │   the numeric Telegram id — the only shared key
                 │   (numeric id)       │
                 └───────┬──────────────┘
                         │ 1
            ┌────────────┴─────────────┐
          0..1                        0..1
  ┌────────▼─────────┐        ┌────────▼──────────────┐
  │      User        │        │        Admin          │
  │  tier f/n/n2     │        │  role (4-value enum)  │
  │  wallet, orders  │        │  — no other field —   │
  └──────────────────┘        └───────────────────────┘
            (mutually blind — neither references the other)

  ┌───────────────────────┐
  │      AdminRole        │   enum, not a table: 4 fixed values, no id/code exposed
  └───────────────────────┘

  ┌───────────────────────┐
  │      Permission       │   DOES NOT EXIST as an entity
  └───────────────────────┘

  ┌───────────────────────┐
  │  AdminPermission /    │   DOES NOT EXIST — no overrides
  │  override             │
  └───────────────────────┘

  ┌───────────────────────┐
  │        Bot            │   multi-bot exists (reseller sub-bots), but the admin
  └───────────────────────┘   section shows no bot/scope column — scope UNKNOWN

  ┌───────────────────────┐
  │      AdminLog         │   exists in the WEB panel only, keyed by admin *username*
  └───────────────────────┘   — not by numeric id, and not visible from Telegram
```

## Relations

| Relation | Cardinality | Confidence | Evidence |
|---|---|---|---|
| `TelegramUser` → `Admin` | 0..1 | **VERIFIED** | uniqueness proven: re-adding the same id created no second row |
| `TelegramUser` → `User` | 0..1 | **VERIFIED** | prior phases |
| `Admin` → `AdminRole` | exactly 1, mandatory | **VERIFIED** | role is required at creation and every row shows one |
| `Admin` → `Permission` | — | **VERIFIED ABSENT** | no permission surface exists |
| `Admin` ↔ `User` | none | **VERIFIED** | neither record displays the other; tier unchanged by admin grant |
| `Admin` → `Bot` | ? | **UNKNOWN** | the Web `Admin` entity has a "bot username (scope)" field; Telegram shows no scope at all |
| `Admin` → `AdminLog` | ? | **UNKNOWN** | web log keys by username; no admin-management verbs observed in its vocabulary |
| `Admin` has status | — | **VERIFIED ABSENT** | no status field |
| `Admin` has audit metadata (created/by/when) | — | **VERIFIED ABSENT in the UI** | not displayed anywhere |

## Do not over-claim

Nothing above asserts a database schema. `Admin` is modelled as an entity because the UI treats it as
one (a keyed, unique, list-able record with exactly one enum attribute). Whether it is a table, a
column on the user row, or a JSON blob is **UNKNOWN** — though the observed behaviour (unique key,
insert-conflict silently ignored, no update path) is most consistent with a small dedicated table
whose primary key is the numeric id.
