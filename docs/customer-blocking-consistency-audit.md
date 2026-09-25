# Customer blocking consistency — audit and design (WP10G)

Baseline: `main` at `4e6fb3915f8ff02aec60354b5ff2c26a45b64cfc` (PR #73 merged). Branch
`claude/wp10g-customer-blocking-consistency`.

The package closes **OQ-WP10F-03**: every generic block of a customer takes the receipt-review
path's semantics — an explicit confirmation, a MANDATORY reason, the reason persisted on the
customer's row and shown to them, a truthful actor and surface in the audit row. Nothing about
the receipt-review Block User path changes except that it now shares one rule with everybody
else.

Falsification rows are deferred to the acceptance pass; this document is the audit-before-code
and the minimal design.

## 1. Every block/unblock entry point, as found

| # | Entry point | Where | Confirmation | Reason | Note |
|---|---|---|---|---|---|
| E1 | `POST /users/:id/block` | `customers.controller.ts` | none (one request) | **optional**, `blockCustomerRequestSchema` `reason?: string.trim().max(500)` | The only generic HTTP write. |
| E2 | `POST /users/:id/unblock` | same | none | optional; audit-only, the service clears the stored reason | Same schema as E1. |
| E3 | Web Admin customer detail, «مسدود کردن» | `apps/web/src/pages/users.tsx` `UserDetailPage` | **none — one click** | optional field «دلیل (اختیاری)» | Calls E1. |
| E4 | Web Admin customer detail, «رفع مسدودی» | same | **none — one click** | the same optional field, passed through | Calls E2. |
| E5 | Telegram Admin customers section, `9:b:<customerId>` | `bot-runtime.ts` `adminCustomerStatus` | **none — one tap** | **none typed**: stores the fixed English sentence `PRE_REASON_BLOCK_NOTE` | `blockedReply` recognises the sentence and never shows it. |
| E6 | Telegram Admin customers section, `9:u:<customerId>` | same | **none — one tap** | none | |
| E7 | Telegram Admin receipt message, Block User (`xa:` → `xb:` → typed reason → `xc:`) | `ReceiptReasonCaptureService` + `receiptBlockCaptures` policy | ask, then a restating confirm | **mandatory**, trimmed, 1–500, refused not cut | The intended semantics. Unchanged by this package. |
| E8 | `CustomerService.block` / `blockWithOutcome` / `unblock` → private `setStatus` | `customer.service.ts` | n/a | `string \| null`; a null or blank reason is stored as NULL; an over-long one is **truncated** to 500 code points | Every surface above ends here. |

No other writer touches `customers.status`: `resolveFromUpdate` never does (the DO UPDATE list
omits it), and no job or worker blocks customers.

## 2. Source of truth

`customers` (0118 shape): `status`, `blocked_at` (CHECK-tied to the status), `blocked_reason`,
`blocked_reason_shown`. The reason column IS the customer-visible reason — File 01 §9 made it so,
and `blocked_reason_shown` (pre-release hardening V2) says whether the row's reason was written
under that promise. `blockedReply` shows a reason only when all three hold: BLOCKED, a reason, and
`blocked_reason_shown`. A row blocked before the promise, or by E5's fixed note, is answered with
the whole-sentence `bot.blocked`.

There is no second reason field, no private note column, and none is added. **No customer
migration.**

## 3. What is reused

- **The rule** lives in `CustomerService.setStatus`, which every surface already calls. The
  mandatory reason is enforced THERE, so a caller that forgets it is refused rather than served.
- **The typed-reason capture** (`admin_amount_captures`, `ReceiptReasonCaptureService`) is the
  one INCIDENT-FIN-001-safe way this codebase reads an administrator's next message. The customers
  section's block reuses the same table and the same service, generalised over what the capture
  names (a payment, or now a customer). One partial unique index on (tenant, bot, admin) keeps
  "one open prompt per administrator per bot" a database fact across every purpose — the reason
  the WP10 follow-up chose this table over a sibling.
- **The customer-visible sentence** `bot.blocked_with_reason` / `bot.blocked`, unchanged.
- **The audit row**: `customer.block` / `customer.unblock`, actor, `source_surface` from
  `actor.surface`, `reason`, `before`/`after` with the stored reason and `changed`, and an optional
  `context` naming where the command came from. The idempotency namespace is already the actor's
  surface (OQ-WP10F-04).

## 4. Design

### 4.1 Shared rule (`CustomerService.setStatus`)

- `to = BLOCKED` requires a reason that is non-empty after trimming and at most
  `CUSTOMER_BLOCK_REASON_MAX_LENGTH` code points. Anything else is refused with the new
  `commerce.customer_block_reason_required` (400), BEFORE the idempotency lookup, so a refused
  request leaves no record and the same key can carry a corrected request. Refused, never cut:
  a reason truncated is a different reason (the capture already refuses; the service now agrees).
- `to = ACTIVE` keeps an optional reason: it is the audit's justification and the stored reason is
  cleared, exactly as before. Unblock does not require one — nothing in the system treated it as
  mandatory.
- Blocking an already-blocked customer: the conditional UPDATE (`WHERE status = 'ACTIVE'`) does
  not match, so the stored reason is **never overwritten**; the audit row records `changed: false`
  and the caller is told the state it found. Changing a stored reason is not a replay side effect
  and no in-place edit is added: the explicit path is unblock, then block with the new reason.
- Unblocking an already-active customer is the same no-op.
- `CustomerStatusContext` gains a second member: `{ source: 'CUSTOMERS_SECTION', captureId }`
  for the Telegram customers section, beside `RECEIPT_REVIEW`. The Web sends none — its surface is
  the context.

### 4.2 HTTP / contract

- `blockCustomerRequestSchema.reason` becomes required: `z.string().trim().min(1).max(500)`.
  A block without a reason fails closed at the schema (400) and again at the service.
- A new `unblockCustomerRequestSchema` keeps the optional reason, so an unblock never accidentally
  requires one. `POST /users/:id/unblock` parses with it.
- `customerSummarySchema` gains `blockedReasonShown: boolean`, the metadata the system already
  holds, so an operator can tell a reason the customer sees from a historical note they do not.

### 4.3 Web Admin (two-step, no one-click destructive action)

- Step 1: «مسدود کردن» opens the confirmation panel. Step 2: a MANDATORY reason field and a
  confirm button that is disabled until the trimmed reason is non-empty, plus cancel. The hint
  says the reason is shown to the customer.
- «رفع مسدودی» opens a confirmation panel with confirm and cancel; no reason field.
- The access card shows status, blocked-at, the stored reason and whether the customer is shown
  it. Business rules stay on the server: the disabled button is a courtesy, the 400 is the rule.

### 4.4 Telegram Admin customers section (durable capture, no in-memory state)

`9:` codes, validated at the boundary by the same table as before:

| Code | Intent | Step |
|---|---|---|
| `9:b:<customerId>` | `ADMIN_CUSTOMER_BLOCK` | **ask**: «کاربر … مسدود شود؟» with «بله، دلیل را می‌نویسم» / «انصراف». Writes nothing. |
| `9:o:<customerId>` | `ADMIN_CUSTOMER_BLOCK_OPEN` | opens a `CUSTOMER_BLOCK_REASON` capture naming the customer; prompts for the reason. |
| plain text | (capture) | `submitReason`: trimmed, 1–500; invalid text is answered and the capture stays open; a confirmation restates the reason. |
| `9:c:<captureId>` | `ADMIN_CUSTOMER_BLOCK_CONFIRM` | closes the capture CONFIRMED, then `CustomerService.blockWithOutcome` under the capture-derived key with the reason and the `CUSTOMERS_SECTION` context. |
| `9:x:<captureId>` | `ADMIN_CUSTOMER_BLOCK_CANCEL` | closes the capture CANCELLED; the customer is untouched. |
| `9:u:<customerId>` | `ADMIN_CUSTOMER_UNBLOCK` | **ask**: confirmation with «رفع مسدودی شود» / «انصراف». Writes nothing. |
| `9:n:<customerId>` | `ADMIN_CUSTOMER_UNBLOCK_CONFIRM` | `CustomerService.unblock` under the update's key. |

Every reply after a write is the detail screen's own builder, so the buttons match the state held.
`PRE_REASON_BLOCK_NOTE` is no longer written by anything; the constant stays so `blockedReply`
keeps hiding it on historical rows.

### 4.5 Persistence — one migration, `0121`

`admin_amount_captures` names a payment (`payment_id NOT NULL`). A customers-section block has no
payment, so the table is widened rather than duplicated:

- `payment_id` becomes nullable; `customer_id uuid` is added with a composite FK to
  `customers(tenant_id, id)`.
- `purpose` gains `CUSTOMER_BLOCK_REASON` (contract `ADMIN_CAPTURE_PURPOSES`).
- A target CHECK: the three receipt purposes require `payment_id NOT NULL AND customer_id IS NULL`;
  `CUSTOMER_BLOCK_REASON` requires `customer_id NOT NULL AND payment_id IS NULL`. Every existing
  row is a receipt purpose with a payment, so the constraint holds on backfill with no data change.
- The confirmed-check and the purpose-column check are extended to the new purpose (a confirmed
  block reason capture has a reason; it never carries an amount).

The partial unique index is untouched. Forward-only, additive, generated from `schema.ts`.

### 4.6 Audit and events

Unchanged mechanism. Each block/unblock writes `customer.block`/`customer.unblock` with the actor
(`actor_id`, `actor_type`), `source_surface` (`WEB` or `TELEGRAM`, from the actor — never a
constant), the customer as entity, the tenant, `reason`, `before`/`after`, `changed`, and the
context when a surface has one. `CustomerBlocked`/`CustomerUnblocked` events are unchanged.

### 4.7 Tenant isolation

Every capture query carries `tenant_id`; the customer FK is composite on `(tenant_id, id)`, so a
capture cannot name another tenant's customer at the database. `CustomerService` reads the
customer under the tenant in its transaction and refuses another tenant's id with the same
refusal it always gave.

### 4.8 Backward compatibility

- Historical blocked rows keep working: a NULL reason, the fixed English note, or a reason written
  before the promise (`blocked_reason_shown = false`) all render `bot.blocked`. Nothing is
  fabricated and no historical data is rewritten.
- Existing idempotency records replay as before: the request hash only gains a context member
  when a caller sends one.
- A client from the previous release that blocks without a reason is refused with a 400 naming
  the rule; an unblock without a reason still succeeds.

## 5. Out of scope, deliberately

No timed or temporary blocks, no expiry, no categories or tags, no bulk blocking, no new roles,
no in-place reason edit, no change to the receipt-review dispositions, no payment work. Full
acceptance (falsification rows, `pnpm verify`, the full integration suite, a Codex review) is a
later pass; only targeted tests run here.
