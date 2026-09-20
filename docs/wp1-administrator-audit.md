# Work Package 1 — administrator management: what already exists

Written before any code, against `main` at `0077469`. Every row below was read
in the file it names; nothing here is inferred from a button's absence.

## The finding that shapes this package

**The backend is nearly complete and the Web Admin surface is nearly empty.**

`AdminManagementService` already performs creation, activation and disabling,
role assignment, Telegram binding and self-service password change, each behind
`admins.edit` or `admins.permissions.edit`, each under a tenant lock, each with
the authorization re-checked inside the writing transaction. The HTTP surface
exposes all of them. Web Admin → System → «مدیران» renders a LIST and a Telegram
binding control, and nothing else.

So most of this package is **reach**, not capability: connecting a surface to
writes that exist, tested and guarded, and refusing to rebuild them. The two
genuine capability gaps are credential rotation for somebody else and session
visibility, and they are the only places new application code is warranted.

## The classification

| #   | Requested                                           | State                    | Evidence                                                                                                                                                                                                                                                                                                                  |
| --- | --------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Create an administrator                             | **existing**             | `admin-management.service.ts:138` `create`; `POST admins`; `rbac.test.ts`                                                                                                                                                                                                                                                 |
| 2   | Activate / disable                                  | **existing**             | `:322` `setStatus`, statuses are `ACTIVE`/`DISABLED` only (`identity.ts:30`)                                                                                                                                                                                                                                              |
| 3   | Assign / remove roles                               | **existing**             | `:476` `setRoles`; `POST admins/:id/roles`                                                                                                                                                                                                                                                                                |
| 4   | Telegram numeric-id binding                         | **existing**             | `:680` `setTelegramBinding`; `POST admins/:id/telegram`; already reachable in Web Admin                                                                                                                                                                                                                                   |
| 5   | Administrator list and detail                       | **partial**              | `:120` `list` returns `AdminSummary` (id, username, displayName, status, telegramUserId, roleKeys, createdAt, lastLoginAt). There is no per-administrator DETAIL route — the page renders rows                                                                                                                            |
| 6   | Last-Owner protection                               | **existing**             | `:1337` `assertOwnerSurvivesDisabling`                                                                                                                                                                                                                                                                                    |
| 7   | An actor cannot grant power they lack               | **existing**             | `:1052` `assertGrantsNoMorePrivilegeThanHeld`, `:1095` the restore twin                                                                                                                                                                                                                                                   |
| 8   | Authorization re-checked in the writing transaction | **existing**             | `:1135` `assertMayAttempt` + `:1270` `runLockedMutation`; `create`'s own docblock records the interleavings that forced it                                                                                                                                                                                                |
| 9   | Own password change                                 | **existing**             | `:825` `changeOwnPassword`; `POST auth/password`                                                                                                                                                                                                                                                                          |
| 10  | **Credential rotation for ANOTHER administrator**   | **missing**              | No service method. The primitive exists (`ports.ts:145` `setPasswordHash`, `SessionRepository.revokeAllForAdmin`) — only the guarded application path is absent                                                                                                                                                           |
| 11  | **Session listing**                                 | **missing**              | `SessionRepository` has `create`, `findByTokenHash`, `isLive`, `touch`, `revoke`, `revokeAllForAdmin`, `purgeExpiredBefore` — no list. The ROW carries `ip`, `userAgent`, `issuedAt`, `expiresAt`, so a truthful listing is supportable without inventing device metadata                                                 |
| 12  | Session revocation for an administrator             | **partial**              | `revokeAllForAdmin` exists and is called on password change; no operator-facing path                                                                                                                                                                                                                                      |
| 13  | Promote an existing customer to administrator       | **intentionally absent** | Nothing in `identity/` references a customer. Customers and administrators are separate identities by design (the "mutually blind" boundary), and inventing a promotion would create a second identity for one principal — the thing the boundary exists to prevent. Not built; recorded as a product question, not a gap |
| 14  | Hard delete an administrator                        | **intentionally absent** | No delete on the repository or the service. `audit_logs` references administrators and refuses UPDATE and DELETE, so a hard delete would strand security history. `DISABLED` is the product's answer and stays so                                                                                                         |
| 15  | Telegram Admin `/link` and `/role`                  | **existing**             | `bot-runtime.ts:1497` parses both; `ADMIN_LINK` / `ADMIN_ROLE` intents; `telegram-admin.service.ts:176` `link`                                                                                                                                                                                                            |
| 16  | Telegram Admin administrator LIST                   | **missing**              | No `ADMIN_ADMINS` intent. The section does not exist on that surface                                                                                                                                                                                                                                                      |
| 17  | Audit before/after with redaction                   | **existing**             | `:1217` `recordAdminChange`; the boundary check already forbids a credential in an audit payload                                                                                                                                                                                                                          |

## What this package will therefore do

1. **Web Admin reach** — an «افزودن مدیر» action, status control and role
   assignment on the existing admins section, calling the routes that already
   exist. No new application service for any of these.
2. **Credential rotation for another administrator** — one new guarded method,
   revoking the target's sessions on the existing contract, never transmitting
   a password through Telegram.
3. **Session visibility** — a bounded `listForAdmin` on the session port and a
   read-only panel, showing only fields the row actually holds. If anything
   about it cannot be shown truthfully it will be left out rather than invented.
4. **Telegram Admin parity** for the operations that can be represented safely
   there: the administrator list and status, permission-aware. Not credential
   rotation — no password material crosses Telegram.

## Explicitly out of scope, per the directive

2FA; password recovery by email or SMS; IP allowlists; device fingerprinting;
reseller and customer-tier work; navigation or theme redesign.

## Evidence gaps

None yet. Everything above was read in the file cited; nothing depends on a
provider, a network or a running panel, so nothing in this package is blocked
the way real-panel acceptance is.
