# Nexa Custom Gateway Protocol — v1

Status: **v1, built in Nexa (Round 10, C1); not yet accepted against a real bridge**
(`OQ-CG-01`). The constants are `packages/contracts/src/custom-gateway.ts`; Nexa's side is
`CustomGatewayAdapter` (`apps/api/src/modules/commerce/payments/infrastructure/
custom-gateway-adapter.ts`); a reference bridge written from this document lives in Nexa's test
suite only (`tests/support/mock-custom-bridge.ts`). Where this document and the code disagree,
it is a bug in the code.

## 0. What this is, and what it is not

The custom gateway is **Nexa's own protocol**. A third party who wants to take payments for a
Nexa store through a payment service Nexa has no adapter for writes a small HTTPS service, the
**bridge**, that speaks this protocol on one side and its payment service on the other.

- It is ONE code-backed gateway type in Nexa (`CUSTOM`). It is not a way for an operator to
  define a provider: the operator only points the `CUSTOM` route at a bridge. Everything Nexa
  does with the answers is the same code for every bridge.
- It is NOT MirzaBot's "custom gateway", and it is not compatible with any existing provider's
  API. Nothing here is copied from another protocol.
- The bridge never moves money in Nexa. Nexa decides, from the bridge's **inquiry** answer only.
  A callback only tells Nexa to ask now instead of later.

Key words MUST, MUST NOT, SHOULD, MAY are used as in RFC 2119.

## 1. Roles and configuration

| Item                                             | Who sets it                                 | Notes                                                                                                                                                                                                                                                                      |
| ------------------------------------------------ | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Base URL                                         | Nexa operator (Web Admin)                   | `https://` only. May carry a path prefix (`https://pay.example.com/nexa`). No query, no fragment, no userinfo. Max 512 characters.                                                                                                                                         |
| Shared secret                                    | Bridge generates, operator pastes into Nexa | ONE secret per route. Nexa signs every request it sends with it (§4); the bridge signs every 2xx response and every callback with it (§5). Each direction signs a string that starts with its own prefix, so a signature made for one direction never verifies as another. |
| Callback URL                                     | Nexa generates                              | `https://<nexa-origin>/payments/webhook/custom/<tenant-id>`, sent with every create.                                                                                                                                                                                       |
| IP allow-list (optional)                         | Nexa operator                               | Up to 32 IPv4/IPv6 addresses or CIDRs the bridge's callbacks may come from (`/0` refused). Empty = no address check.                                                                                                                                                       |
| Display name, fee, min/max amount, display order | Nexa operator                               | The route's ordinary settings, as for every other gateway.                                                                                                                                                                                                                 |

The secret: 32–512 printable ASCII characters, at least 256 bits of entropy (e.g. 32 random
bytes, base64url). It is stored encrypted in Nexa (the route's existing API-key slot) and is never
shown again after saving.

A Nexa store has ONE custom route in v1 (`OQ-CG-02`). The route starts **disabled**; it cannot be
switched on without its secret and its base URL. Its base URL can be changed only while the route
is switched off (switch off, change, test, switch on); every change is audited. Each payment
attempt FREEZES the base URL it was created with: every inquiry of that attempt goes to that
bridge, whatever the route says later.

## 2. Conventions

### 2.1 Transport

- HTTPS only, TLS 1.2 or newer, a certificate valid for the host. Nexa never follows a
  redirect: a 3xx is an error.
- JSON bodies, `Content-Type: application/json; charset=utf-8`, UTF-8, no BOM.
- Every endpoint path below is **relative to the base URL**: base `https://pay.example.com/nexa`
  - path `/v1/payments` = `https://pay.example.com/nexa/v1/payments`.
- Unknown JSON fields MUST be ignored by both sides (forward compatibility, §10).
- Request bodies from Nexa are at most 4 KiB. Responses from the bridge MUST be at most 16 KiB;
  Nexa stops reading after 64 KiB and treats the answer as unreadable. A callback body MUST be at
  most 16 KiB (Nexa answers 413 beyond that).
- A response MAY be compressed (`Content-Encoding: gzip`, `deflate`, `br`); its signature (§5) is
  over the body bytes BEFORE compression, which is what Nexa verifies after decoding.
- Nexa's base-URL rules: `https://`, a host, an optional port and path prefix of unreserved
  characters; no userinfo, query, fragment, backslash or dot segment; at most 512 characters; a
  trailing `/` is dropped. The host must not be (or resolve to) loopback, link-local (including
  cloud metadata) or Nexa's own infrastructure networks; Nexa resolves the name once per call and
  connects to that address only. Private-network addresses are allowed (`OQ-CG-05`).

### 2.2 Money

Nexa's money is an integer count of **minor units** with an explicit currency, never a float.

```json
{ "value": "12500000", "currency": "IRR" }
```

- `value`: a JSON **string** of decimal digits, the integer number of minor units, matching
  `^(0|[1-9][0-9]{0,18})$` and at most `9223372036854775807`. No sign, no decimal point, no
  exponent, no separators, no Persian digits. A JSON number is NOT accepted.
- `currency`: an uppercase code. **In v1 the only currency is `IRR` (Iranian rial)**, whose
  minor unit is the rial itself (exponent 0).
- A Nexa store may sell in toman (`IRT`) or rial (`IRR`). Nexa always converts to rial before
  sending (1 toman = 10 rial, exact, done in one place in Nexa); a rial sale is sent as it is.
  A bridge whose payment service bills in toman divides by 10 itself; if a rial amount is not
  divisible by 10 and the service cannot take it, the bridge refuses the create with
  `AMOUNT_NOT_PAYABLE` (§8).
- The amount Nexa sends is the **whole amount the customer must pay**, Nexa's own fee included.
  The bridge MUST NOT add any fee on top of it, and MUST NOT let the customer pay a different
  figure. If the bridge's service charges a fee, the operator sets Nexa's route fee instead.

### 2.3 Identifiers and time

| Field             | Format                                                                                                                                                                                                                                                                            |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invoice_id`      | Nexa's id for one payment attempt. `^[A-Za-z0-9_-]{1,64}$`. Unique per bridge for ever; one attempt, one id; a customer's retry is a new attempt with a new id. Nexa v1 generates `cg_` + 26 Crockford base32 characters (130 random bits), unique across the whole installation. |
| `reference`       | The bridge's own id for the payment. `^[A-Za-z0-9_.:-]{1,64}$`. Unique within the bridge, never reused.                                                                                                                                                                           |
| `customer_ref`    | A stable, opaque per-customer number (decimal string, 10 digits). Not a Telegram id, not a phone number; it reveals nothing about the customer. The same customer of the same store always has the same value.                                                                    |
| `delivery_id`     | The bridge's id for one callback event, `^[A-Za-z0-9_.:-]{1,64}$`. Retries of the same event reuse it; a new event gets a new one.                                                                                                                                                |
| timestamps        | RFC 3339 in UTC with `Z`, e.g. `2026-10-26T09:41:00Z` (fractional seconds allowed).                                                                                                                                                                                               |
| header timestamps | Integer Unix seconds, decimal, e.g. `1793007660`.                                                                                                                                                                                                                                 |

## 3. Endpoints

| #   | Direction     | Method and path             | Purpose                                                   | Required                            |
| --- | ------------- | --------------------------- | --------------------------------------------------------- | ----------------------------------- |
| 3.1 | Nexa → bridge | `POST /v1/payments`         | Create a payment                                          | yes                                 |
| 3.2 | Nexa → bridge | `POST /v1/payments/inquiry` | Read a payment's status — the ONLY thing that can approve | yes                                 |
| 3.3 | bridge → Nexa | `POST <callback_url>`       | Tell Nexa the status changed (a hint)                     | yes                                 |
| 3.4 | Nexa → bridge | `GET /v1/ping`              | Connection test from the Web Admin                        | yes                                 |
| 3.5 | Nexa → bridge | `POST /v1/payments/cancel`  | Close a still-pending payment                             | optional (Nexa v1 does not call it) |

Every Nexa → bridge request carries the headers of §4. Every 2xx response from the bridge, and
every callback, carries the signature of §5.

### 3.1 Create — `POST /v1/payments`

Request:

```json
{
  "invoice_id": "cg_7Q2M8K4ZJ1W3X9R5T0V6B2N8CD",
  "amount": { "value": "12500000", "currency": "IRR" },
  "callback_url": "https://shop.example.com/payments/webhook/custom/6f1c7d0e-3a7b-4a0e-9d55-0d3f7c3e2a11",
  "expires_at": "2026-10-26T10:51:00Z",
  "customer_ref": "4829103375"
}
```

| Field          | Type             | Notes                                                                                                                                                                                           |
| -------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invoice_id`   | string           | §2.3. Also sent as the `Idempotency-Key` header.                                                                                                                                                |
| `amount`       | Money            | §2.2. What the customer pays, exactly.                                                                                                                                                          |
| `callback_url` | string or `null` | Where to send callbacks (§3.3). `null` when the Nexa installation has no public address; the bridge then sends no callbacks and Nexa relies on inquiries.                                       |
| `expires_at`   | timestamp        | Nexa's deadline for this attempt. The bridge MUST NOT accept money for this payment after it, and SHOULD close its payment page some minutes before it. It MUST NOT report `EXPIRED` before it. |
| `customer_ref` | string           | §2.3. For the bridge's own fraud and limit rules; never shown to anyone.                                                                                                                        |

Response `201 Created` (new) or `200 OK` (idempotent repeat), signed (§5):

```json
{
  "invoice_id": "cg_7Q2M8K4ZJ1W3X9R5T0V6B2N8CD",
  "reference": "brg-20261026-000417",
  "payment_url": "https://pay.example.com/p/brg-20261026-000417",
  "status": "PENDING",
  "amount": { "value": "12500000", "currency": "IRR" }
}
```

| Field         | Type   | Notes                                                                                      |
| ------------- | ------ | ------------------------------------------------------------------------------------------ |
| `invoice_id`  | string | MUST equal the request's.                                                                  |
| `reference`   | string | §2.3. Nexa stores it and asks by it.                                                       |
| `payment_url` | string | `https://` URL, at most 2048 characters, no userinfo. The customer opens it from Telegram. |
| `status`      | string | MUST be `PENDING` on create.                                                               |
| `amount`      | Money  | MUST equal the request's amount exactly.                                                   |

**Idempotency.** Create is idempotent on `invoice_id`:

- The same `invoice_id` with the same body (same `amount`, `callback_url`, `expires_at`,
  `customer_ref`) MUST return the same `reference` and `payment_url`, with `200`, and MUST NOT
  create a second payment.
- The same `invoice_id` with a different body MUST be refused `409 INVOICE_CONFLICT` and MUST NOT
  change the stored payment.
- The bridge MUST keep `invoice_id` → `reference` for at least 30 days.

Nexa's own rule on top of that: **a create whose answer Nexa did not receive is never sent
again** — not even with the same `invoice_id`. Nexa finds out what happened by an inquiry by
`invoice_id` with `reference: null` (§3.2), which it asks when a verified callback names that
`invoice_id` (the bridge SHOULD send one when the payment's status changes). Idempotency protects
against duplicates below Nexa (proxies, retries in the bridge's own stack); it is not a license
for Nexa to retry.

What Nexa does with the answer:

| Answer                                                                                                                                               | Nexa's reading                                                                                                                                                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 201/200, signed, every check above passes                                                                                                            | Created. The customer is shown `payment_url`.                                                                                                                                                                         |
| 201/200 whose signature does not verify, or a body that does not parse, or no valid `reference`                                                      | **Unknown** — the payment may exist. Never retried; reconciled by inquiry.                                                                                                                                            |
| 201/200 whose `invoice_id` or `amount` differs from the request, or whose `payment_url` is not `https` (or carries userinfo, or is longer than 2048) | Refused. The link is never shown (the customer cannot pay a wrong figure). `reference` is recorded on the attempt's audit row for the operator.                                                                       |
| 409 `INVOICE_CONFLICT`                                                                                                                               | **Unknown** (a payment under this id may exist).                                                                                                                                                                      |
| 429 with `error.code = RATE_LIMITED`                                                                                                                 | Not processed. Nexa may create again later under the SAME `invoice_id`, honouring `Retry-After` (at most 60 s). This is the only answer that lets Nexa send the create again. A 429 without that code is **unknown**. |
| any other 4xx with a JSON error body (§8)                                                                                                            | Refused: the bridge guarantees nothing was created.                                                                                                                                                                   |
| 5xx, timeout, connection lost after sending, 3xx, an oversized answer, a 4xx without a readable error body                                           | **Unknown**.                                                                                                                                                                                                          |
| No connection at all (the name did not resolve, the address is refused by Nexa's policy, the TLS handshake failed)                                   | Refused: nothing was sent.                                                                                                                                                                                            |

### 3.2 Inquiry — `POST /v1/payments/inquiry`

A read. It changes nothing at the bridge. This is the only answer Nexa approves a payment from.

Request:

```json
{ "invoice_id": "cg_7Q2M8K4ZJ1W3X9R5T0V6B2N8CD", "reference": "brg-20261026-000417" }
```

| Field        | Type             | Notes                                                                                                                                                                                                                              |
| ------------ | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invoice_id` | string           | Always present.                                                                                                                                                                                                                    |
| `reference`  | string or `null` | Present once Nexa knows it. `null` after a create whose answer was lost: the bridge MUST then look the payment up by `invoice_id`. When both are present the bridge MUST answer `404 NOT_FOUND` unless they name the same payment. |

Response `200 OK`, signed (§5):

```json
{
  "invoice_id": "cg_7Q2M8K4ZJ1W3X9R5T0V6B2N8CD",
  "reference": "brg-20261026-000417",
  "status": "PAID",
  "amount": { "value": "12500000", "currency": "IRR" },
  "amount_paid": { "value": "12500000", "currency": "IRR" },
  "paid_at": "2026-10-26T09:58:12Z",
  "updated_at": "2026-10-26T09:58:13Z"
}
```

| Field                     | Type                | Notes                                                                                                                                                                                           |
| ------------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invoice_id`, `reference` | string              | Both MUST be present and name this payment.                                                                                                                                                     |
| `status`                  | string              | One of §6.                                                                                                                                                                                      |
| `amount`                  | Money               | The amount Nexa asked for, unchanged.                                                                                                                                                           |
| `amount_paid`             | Money or `null`     | What the bridge's payment service actually captured and holds for this payment. `null` (or `"0"`) when nothing was captured. REQUIRED (non-null, positive) for `PAID`, `UNDERPAID`, `OVERPAID`. |
| `paid_at`                 | timestamp or `null` | When the money was captured.                                                                                                                                                                    |
| `updated_at`              | timestamp           | When this status was last changed.                                                                                                                                                              |

`404 NOT_FOUND`: the bridge has no payment for this `invoice_id` / `reference`.

What Nexa does with the answer: an answer that is not signed for THIS request (§5) is no
information and is asked again later; an answer naming another `invoice_id` or `reference` than
the attempt's is recorded and never acted on; otherwise §6 decides. `429 RATE_LIMITED` is
honoured (`Retry-After`, at most 60 s); 401/403 open a configuration alert for the operator.

### 3.3 Callback — `POST <callback_url>` (bridge → Nexa)

Sent by the bridge whenever a payment's status changes (including to a terminal status). It is a
**hint**: Nexa verifies it, deduplicates it, and brings the next inquiry forward. **A callback
never credits anything by itself, whatever it says.**

Headers:

```
Content-Type: application/json; charset=utf-8
X-Nexa-Bridge-Signature: t=1793007492,v1=5d0c2f...e91a
X-Nexa-Delivery-Id: dlv-01JBC4W3Q8
```

Body:

```json
{
  "version": "1",
  "event": "payment.status_changed",
  "delivery_id": "dlv-01JBC4W3Q8",
  "invoice_id": "cg_7Q2M8K4ZJ1W3X9R5T0V6B2N8CD",
  "reference": "brg-20261026-000417",
  "status": "PAID",
  "occurred_at": "2026-10-26T09:58:12Z"
}
```

- `event` is `payment.status_changed`, or `test` for a test delivery the bridge's own admin
  sends (no `invoice_id`/`reference`/`status`); Nexa answers a verified `test` with 200 and does
  nothing else.
- `X-Nexa-Delivery-Id` MUST equal the body's `delivery_id` (the body is what is signed; a
  mismatch is refused 400).

Nexa's answers:

| Answer            | Meaning                                                                                                                                          | Bridge should                     |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------- |
| `200 {"ok":true}` | Received. Also the answer for a duplicate delivery, an unknown `invoice_id`, or a store that is not accepting work — Nexa does not reveal which. | stop retrying this delivery       |
| `400`             | Not a callback of this protocol (shape, version, header/body mismatch).                                                                          | fix the bridge; do not retry      |
| `401`             | Signature missing, invalid, or timestamp outside ±300 s. Nexa raises one rolled-up operator alert (`payments.gateway_webhook_unverified`).       | check the secret and clock; retry |
| `403`             | The sender's address is not in the route's IP allow-list.                                                                                        | check the allow-list; retry       |
| `404`             | No custom route at this URL.                                                                                                                     | do not retry                      |
| `413`             | Body over 16 KiB.                                                                                                                                | do not retry                      |
| 5xx / timeout     | Nexa did not process it.                                                                                                                         | retry                             |

Retries: on 401, 403, 5xx, or no answer within 10 s, retry the SAME delivery (same
`delivery_id`, a fresh `t` and signature) with exponential backoff starting at 10 s, doubling, up
to 30 minutes between tries, for at least 24 hours. Callbacks MAY arrive out of order; Nexa does
not care, because it re-reads the status by inquiry.

### 3.4 Ping — `GET /v1/ping`

The Web Admin's "test connection". No request body (the body hash in §4 is the SHA-256 of the
empty string). Response `200 OK`, signed (§5):

```json
{
  "protocol": "nexa-custom-gateway",
  "version": "1",
  "bridge_time": "2026-10-26T09:41:03Z",
  "currencies": ["IRR"],
  "capabilities": { "cancel": false }
}
```

Nexa reports the test as passed only when: the call reached the bridge over valid TLS; the bridge
accepted Nexa's request signature (else `401`); the response signature verifies with the shared
secret for this request; `protocol`/`version` match; `currencies` contains `IRR`. A `bridge_time`
more than 60 s from Nexa's clock FAILS the test with `CLOCK_SKEW` (signatures start failing at
300 s, and a clock already drifting a minute is a fault to fix now). The test creates nothing
and moves no money; its result (`ok`, or the reason) is recorded on the route for the operator.

### 3.5 Cancel (optional) — `POST /v1/payments/cancel`

Only for a bridge whose ping says `capabilities.cancel: true`. Asks the bridge to close a payment
that is still `PENDING`, so it can no longer be paid.

Request: `{ "invoice_id": "...", "reference": "..." }`. Response `200`, signed:
`{ "invoice_id": "...", "reference": "...", "status": "FAILED" }` — or `409 CANCEL_NOT_ALLOWED`
when the payment is no longer `PENDING`. After a successful cancel the payment MUST read `FAILED`
for ever. Nexa never decides anything from the cancel answer: the next inquiry does. A cancel
whose answer is lost is not sent again.

**Nexa v1 does not send cancel** (lead decision, Round 10). Nexa's existing pipeline cancels an
expired attempt only on its card-transfer route, through a lane built for that provider; no
link-based gateway is cancelled on expiry. A bridge is protected by `expires_at` instead: it MUST
NOT accept money for a payment after it (§3.1). A bridge MAY implement cancel now; when Nexa
starts calling it (`OQ-CG-04`) it will be on the attempt's expiry, never decisive, never resent.

## 4. Authenticating Nexa's requests (Nexa → bridge)

Every request Nexa sends carries:

```
X-Nexa-Protocol: 1
X-Nexa-Timestamp: 1793007660
X-Nexa-Nonce: 9f2c4e1ab07d4c55a1e3f0b6c28d7e14
X-Nexa-Signature: v1=0b7f4c...c3d2
Idempotency-Key: cg_7Q2M8K4ZJ1W3X9R5T0V6B2N8CD      (create only)
```

- `X-Nexa-Nonce`: 32 lowercase hex characters (128 random bits), new for every request.
- `X-Nexa-Signature`: `v1=` followed by the lowercase hex HMAC-SHA256, keyed by the **shared
  secret** (its bytes exactly as configured), of this string — six lines joined by `\n` (0x0A),
  no trailing newline:

```
NEXA-CGW-V1-REQUEST
<METHOD>
<PATH>
<TIMESTAMP>
<NONCE>
<BODY_SHA256>
```

| Line                  | Value                                                                                                                             |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `NEXA-CGW-V1-REQUEST` | literal (the request direction's prefix)                                                                                          |
| `<METHOD>`            | `GET` or `POST`, uppercase                                                                                                        |
| `<PATH>`              | the protocol path from §3 exactly, e.g. `/v1/payments/inquiry` — **without** the base URL's own path prefix, without query string |
| `<TIMESTAMP>`         | the `X-Nexa-Timestamp` value, as sent                                                                                             |
| `<NONCE>`             | the `X-Nexa-Nonce` value, as sent                                                                                                 |
| `<BODY_SHA256>`       | lowercase hex SHA-256 of the raw request body bytes (of the empty string for `GET`)                                               |

The bridge MUST, before reading the body's fields:

1. recompute the signature over the raw bytes it received and compare in constant time;
2. refuse a timestamp more than **300 seconds** from its own clock, in either direction
   (`401 TIMESTAMP_OUT_OF_WINDOW`);
3. remember each nonce for at least 600 seconds and refuse a repeat (`401 NONCE_REPLAYED`);
4. answer `401 SIGNATURE_INVALID` for anything else that does not verify.

Because the path is in the signed string, a signature for `/v1/ping` cannot be replayed against
`/v1/payments`.

## 5. Authenticating the bridge (callbacks and responses)

The bridge signs every callback body and every **2xx response body** with the **shared secret**,
in the header:

```
X-Nexa-Bridge-Signature: t=<unix seconds>,v1=<hex>
```

`v1` is the lowercase hex HMAC-SHA256, keyed by the shared secret, of its direction's prefix line,
the ASCII `t` value, (for a response) the request's nonce, and then the raw body bytes exactly as
sent — lines joined by `\n` (0x0A):

```
response:  v1 = hex( HMAC_SHA256( secret, "NEXA-CGW-V1-RESPONSE\n" + t + "\n" + request_nonce + "\n" + raw_body ) )
callback:  v1 = hex( HMAC_SHA256( secret, "NEXA-CGW-V1-CALLBACK\n" + t + "\n" + raw_body ) )
```

`request_nonce` is the `X-Nexa-Nonce` of the request being answered: a response is bound to its
request, so a recorded answer can never be replayed as the answer to another request. Because each
direction (request, response, callback) has its own prefix, one secret serves all three without
any signature being usable in another direction.

Nexa:

- verifies over the bytes it received, in constant time, BEFORE reading any field;
- refuses a `t` more than **300 seconds** from its clock, either way;
- accepts the header if ANY of its `v1=` values verifies (several are allowed for rotation,
  §9.3); other keys (`v0=`) are ignored; more than one `t` is refused;
- for a callback: refuses with 401 (and records one rolled-up operator alert); for a 2xx
  response: treats it as unreadable (create → unknown, inquiry → no information, ping → failed).
- an empty secret verifies nothing.

The timestamp bounds clock skew and replay; it is never the dedupe key. Dedupe is
`delivery_id` (§3.3). Error responses (4xx/5xx) SHOULD be signed too; Nexa does not require it,
because no error answer can approve anything.

Example (callback, `t = 1793007492`, body `{"ok":true}`): the signed bytes are
`NEXA-CGW-V1-CALLBACK\n1793007492\n{"ok":true}`.

## 6. Status semantics

| Status      | Meaning                                                                                          | Terminal | Nexa's reading                                                                                                                                                          |
| ----------- | ------------------------------------------------------------------------------------------------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PENDING`   | Created; no money captured yet.                                                                  | no       | Keep asking until the attempt's deadline.                                                                                                                               |
| `PAID`      | Exactly `amount` was captured. `amount_paid` = `amount`.                                         | yes      | **Approved** — only if `invoice_id`, `reference`, `amount` and `amount_paid` all match exactly what Nexa sent and recorded. Otherwise held for an operator (mismatch).  |
| `UNDERPAID` | Money was captured, less than `amount`. 0 < `amount_paid` < `amount`.                            | yes      | Never approved. Held for an operator, who settles the difference with the customer.                                                                                     |
| `OVERPAID`  | More than `amount` was captured. `amount_paid` > `amount`.                                       | yes      | Never approved automatically in v1. Held for an operator.                                                                                                               |
| `FAILED`    | The payment did not happen and no money is held for it (declined, cancelled, or fully reversed). | yes      | Unsuccessful: the attempt fails; the customer may start a new one. A `FAILED` whose `amount_paid` is above zero contradicts itself and is held for an operator instead. |
| `EXPIRED`   | `expires_at` passed and no money was captured.                                                   | yes      | Unsuccessful, as `FAILED` (and held the same way if `amount_paid` is above zero).                                                                                       |

Rules for the bridge:

- A terminal status is **final**: once reported (by inquiry or callback) it MUST NEVER change.
  A bridge that cannot guarantee that no money will arrive later MUST keep reporting `PENDING`
  until it can. `EXPIRED` and `FAILED` therefore promise that the customer's money, if any shows
  up later, is returned to them by the bridge's side — Nexa will not hear of it.
- `PAID` only after the money is final at the payment service (settled/verified — not "the
  customer was redirected back").
- Never report `EXPIRED` before `expires_at`.
- A status not in this table is a protocol violation; Nexa records it, treats the payment as
  still open and alerts the operator.

What Nexa credits is always its OWN recorded amount for the attempt (the principal the customer
was quoted, without Nexa's fee), never a figure from the bridge. "Held for an operator" means the
payment is marked as needing review (`UNKNOWN`), the customer is told it is being reviewed and not
to pay again, nothing is credited, and an operator reconciles it from Nexa's Payment Operations
Center (they may confirm a `PAID` or fail it; the difference of an under- or overpayment is settled
with the customer outside the protocol, `OQ-CG-03`).

A `PAID` answer that arrives after Nexa's deadline is a **late payment**: by default Nexa records
it for an operator and moves nothing; if the operator turned on late credit for this route
(`payments.late_credit.custom_enabled`, OFF by default), Nexa credits the customer's wallet once,
after re-reading the inquiry.

## 7. Timeouts, retries and rate limits

| Call    | Nexa's timeout                       | Nexa retries?                                                                                                                                                                                                                                           |
| ------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| create  | 15 s total (DNS, connect, TLS, body) | Never, except after `429 RATE_LIMITED` (§3.1).                                                                                                                                                                                                          |
| (all)   | Redirects (3xx) are never followed.  | —                                                                                                                                                                                                                                                       |
| inquiry | 15 s                                 | Yes, on its own schedule: ~every 10 s at first, backing off to every few minutes, until the deadline (70 minutes from the attempt's creation), plus a few late reads; a verified callback brings one forward (never more than one per 5 s per payment). |
| ping    | 15 s                                 | No (an operator presses the button again).                                                                                                                                                                                                              |
| cancel  | 15 s                                 | Never.                                                                                                                                                                                                                                                  |

- The bridge SHOULD answer every call within 5 seconds.
- Nexa spends at most 60 calls a minute per store on one bridge (at most 40 of them inquiries).
  The bridge MUST allow at least that. Above its own limit it answers
  `429 RATE_LIMITED` with `Retry-After: <seconds>`; Nexa honours it (bounded).

## 8. Errors

Every non-2xx response from the bridge SHOULD have this body:

```json
{ "error": { "code": "AMOUNT_OUT_OF_RANGE", "message": "free text for logs" } }
```

- `code`: one of the table below (uppercase, `^[A-Z][A-Z0-9_]{1,47}$`). Nexa decides on the
  HTTP status and `code` only.
- `message`: free text for the bridge's own debugging. **Nexa never stores, logs or shows it.**
  Customers and operators see Persian text Nexa maps from `code`.
- `details` (optional object): for `AMOUNT_OUT_OF_RANGE`, `{ "min": Money, "max": Money }`.

| HTTP | `code`                    | When                                                               |
| ---- | ------------------------- | ------------------------------------------------------------------ |
| 400  | `BAD_REQUEST`             | Malformed JSON, a missing or ill-formed field.                     |
| 401  | `SIGNATURE_INVALID`       | §4 signature does not verify.                                      |
| 401  | `TIMESTAMP_OUT_OF_WINDOW` | §4 timestamp more than 300 s off.                                  |
| 401  | `NONCE_REPLAYED`          | §4 nonce seen before.                                              |
| 403  | `FORBIDDEN`               | The merchant account behind the bridge is disabled or not allowed. |

(The codes Nexa itself records for what it read — `UNSIGNED`, `UNREADABLE`, `ECHO_MISMATCH`,
`LINK_REJECTED`, `PROTOCOL_MISMATCH`, `CURRENCY_UNSUPPORTED`, `ENDPOINT_MISSING`, `CLOCK_SKEW`,
`UNKNOWN_CODE` — are never sent by a bridge; they are listed in the constants file with their
Persian labels in the Web Admin.)
| 404 | `NOT_FOUND` | Inquiry/cancel: no such payment. |
| 409 | `INVOICE_CONFLICT` | Create: this `invoice_id` exists with a different body. |
| 409 | `CANCEL_NOT_ALLOWED` | Cancel: the payment is no longer `PENDING`. |
| 422 | `UNSUPPORTED_CURRENCY` | `currency` is not one the bridge takes. |
| 422 | `AMOUNT_OUT_OF_RANGE` | Below the bridge's minimum or above its maximum. |
| 422 | `AMOUNT_NOT_PAYABLE` | The service cannot charge this exact figure (e.g. a rial amount not divisible by 10 for a toman-only service). |
| 422 | `EXPIRES_AT_INVALID` | `expires_at` is in the past or too soon for the service. |
| 422 | `CALLBACK_URL_REJECTED` | The bridge refuses to call this URL. |
| 429 | `RATE_LIMITED` | Too many requests; not processed. With `Retry-After`. |
| 500 | `INTERNAL` | Bridge failure. |
| 503 | `UNAVAILABLE` | The payment service behind the bridge is down. |

For a create, every 4xx with a readable error body other than `409 INVOICE_CONFLICT` and
`429 RATE_LIMITED` is the bridge's **guarantee that nothing was created**. A bridge that is not
sure MUST answer 5xx instead. An unknown `code` is recorded as `UNKNOWN_CODE` and read by its
HTTP status.

## 9. Security notes

### 9.1 Transport and addresses

- HTTPS only, both ways. Nexa refuses an `http://` base URL, refuses to follow redirects, pins
  the address it resolved for the whole call (no DNS rebinding), and refuses base URLs that
  resolve to loopback, link-local, or Nexa's own infrastructure networks (when the URL is saved,
  if its host is a literal address, and on every call after resolving the name). The bridge's
  certificate is verified against the public trust store plus the operator's
  `PANEL_HTTP_CA_FILE`, if set.
- A `payment_url` that is not `https://` is never shown to a customer.

### 9.2 IP allow-list (optional)

The operator may list the CIDRs (IPv4 or IPv6, at most 32 entries) the bridge's callbacks come
from. Nexa reads the sender address behind its own trusted reverse proxy only (never a
client-supplied `X-Forwarded-For`: `TRUSTED_PROXY_IPS`). A callback from outside the list —
or whose sender address Nexa does not know while a list is set — is refused `403` before its
signature or body is read. The list is defence in depth; the signature is the authentication.

### 9.3 Secret rotation

One secret, both directions, rotated in one window:

1. The bridge starts ACCEPTING requests signed with either the old or the new secret, and starts
   SIGNING its responses and callbacks with BOTH (`t=...,v1=<old>,v1=<new>`).
2. The operator saves the new secret in Nexa (the route may stay switched on).
3. The bridge drops the old secret on both sides.

No request, response or callback fails during the switch. Saving the secret in Nexa is audited
(who, when — never the value). A route cannot be switched on without its secret and a base URL.

### 9.4 What a compromised party can and cannot do

- A forged or replayed callback can, at most, make Nexa ask the bridge one inquiry earlier.
- Whoever controls the bridge (or its secret) decides which payments are approved.
  The bridge operator is therefore as trusted as a payment provider: an operator should only point
  the route at a bridge they or a party they trust runs.
- Secrets are never sent in a request, a URL or a log line. Nexa never logs request or response
  bodies, headers, or the base URL with the bridge's answers.

## 10. Versioning

- The protocol version is `1`, carried in the path (`/v1/...`), in `X-Nexa-Protocol: 1`, in
  callbacks (`"version": "1"`) and in ping.
- **Within v1** only additive changes are made: a new OPTIONAL request or response field, a new
  error `code`, a new `capabilities` flag, a new optional endpoint. Both sides ignore what they do
  not know.
- **A new version** (`/v2/...`) is required for anything else: a new status value, a new
  currency that changes the meaning of `amount`, a change to a signed string, a field that becomes
  required, a change of meaning. Nexa keeps speaking v1 to a bridge until its operator switches
  the route to v2; a bridge MAY serve both.
- This document is the specification. Nexa's reference mock bridge (in Nexa's test suite only)
  and the contract tests follow it; where they disagree, it is a bug in the code.

## 11. Worked example (happy path)

1. Customer buys a 125,000-toman plan; route fee 0. Nexa opens attempt `cg_7Q2M...`, deadline
   10:51Z, amount 125,000 IRT → `{ "value": "1250000", "currency": "IRR" }`.
2. Nexa `POST /v1/payments` (signed §4). Bridge creates `brg-...0417`, answers 201 (signed §5)
   with `payment_url`.
3. Customer pays on the bridge's page. The service settles; the bridge records `PAID`,
   `amount_paid` 1250000 IRR.
4. Bridge `POST`s the callback (signed §5). Nexa verifies, dedupes on `delivery_id`, answers 200,
   and schedules an inquiry now.
5. Nexa `POST /v1/payments/inquiry` → `PAID`, ids and amounts match → Nexa settles the order in
   one transaction (payment, ledger, events), under the payment's lock, before the deadline.
6. A retry of the same callback (same `delivery_id`) is answered 200 and does nothing.

Underpayment variant: step 5 answers `UNDERPAID`, `amount_paid` 1000000 → Nexa marks the payment
as needing an operator, tells the customer it is being reviewed, credits nothing.
