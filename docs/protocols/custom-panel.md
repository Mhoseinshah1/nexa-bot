# Nexa Custom Panel Bridge Protocol — v1

Status: **v1, implemented** in Nexa (R10 C2) as the `custom` provider type, behind the
`custom_panel_provider` feature flag, which is **off by default**. **Not yet accepted against
a real bridge** — §12 is the acceptance run the first real bridge must pass before the flag
is turned on in production (`OQ-C2-02`).

Nexa's side: `apps/api/src/modules/platform/providers/infrastructure/custom-panel.adapter.ts`
and `custom-panel-protocol.ts`. This document is the specification, and
`tests/unit/custom-panel-protocol-doc.test.ts` reads its tables (§1, §4.2, §7.2) and its test
vectors (§3.5) and compares them with that code, so the two cannot drift apart silently.

This is Nexa's **own** protocol. It is not derived from, and is not compatible with,
MirzaBot or any panel's API. Nexa defines one fixed request/response format; a third party
who wants Nexa to sell accounts on a panel Nexa does not support writes a small HTTPS service
— the **bridge** — that speaks this protocol on one side and their panel's API on the other.

On the Nexa side there is exactly one code-backed provider type, `custom`, and it speaks only
this protocol. An operator configures a bridge's base URL, its shared secret and a timeout;
they cannot describe a new protocol, add an endpoint or change a field.

**Configuring one in Nexa** (Web Admin → Panels → new panel, provider «Custom (Nexa bridge
v1)»): the base URL (`https://` only — anything else is refused), the shared secret (at least
32 characters; stored encrypted, never shown again) and, optionally, on the panel's
activation card, a request timeout in seconds (§8). Then «test connection» (§5.1) — a panel
is enabled only after a test that vouches for its current address and secret. Creating a
custom panel is refused while the tenant's `custom_panel_provider` flag is off; turning the
flag off later does **not** stop custom panels that already exist.

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119.

---

## 1. Overview

| #   | Operation            | Method | Path (relative to base URL)          | Nexa uses it for                                      |
| --- | -------------------- | ------ | ------------------------------------ | ----------------------------------------------------- |
| 1   | Health               | GET    | `v1/health`                          | operator's "test connection", background monitor      |
| 2   | Create account       | POST   | `v1/accounts`                        | provisioning a paid order                             |
| 3   | Get account          | GET    | `v1/accounts/{username}`             | reconcile/adopt after a lost answer, usage, live card |
| 4   | Set allowance        | POST   | `v1/accounts/{username}/allowance`   | renew, add traffic, add time                          |
| 5   | Disable account      | POST   | `v1/accounts/{username}/disable`     | suspend                                               |
| 6   | Enable account       | POST   | `v1/accounts/{username}/enable`      | resume                                                |
| 7   | Delete account       | POST   | `v1/accounts/{username}/delete`      | terminate                                             |
| 8   | Change link          | POST   | `v1/accounts/{username}/rotate-link` | customer/operator link rotation                       |
| 9   | Get connection links | GET    | `v1/accounts/{username}/links`       | subscription link and raw configs                     |

Every write is a `POST` with a JSON body, including delete — so every write is signed over a
body and carries an `operationId`. There are no query strings in v1; a bridge MUST reject a
request whose URL has one (`INVALID_REQUEST`).

**Base URL.** The operator enters an absolute `https://` URL, optionally with a path prefix,
e.g. `https://bridge.example.com/nexa/`. Nexa resolves every path above against it, never
follows a redirect, and refuses a base URL that is not `https`. In the signature (§3) the path
is always the **protocol path** — beginning `/v1/` — regardless of any prefix, so a bridge behind
a reverse proxy strips its prefix before verifying.

**`{username}`** is the account name Nexa chose: `^[a-z0-9_-]{4,20}$`, lowercase. It is
URL-safe and is sent unencoded. A bridge MUST treat it as case-sensitive and exact.

---

## 2. Transport

- HTTPS only (TLS 1.2+). Nexa validates the certificate against the system trust store or the
  installation's configured CA bundle.
- Request bodies: `Content-Type: application/json; charset=utf-8`, UTF-8, no BOM.
- Responses: `Content-Type: application/json`, UTF-8. Every response — success **and** error —
  has a JSON object body and is signed (§3.4). A response MAY be compressed
  (`Content-Encoding: gzip`, `deflate` or `br`); the signature covers the body **after**
  decoding.
- Header names are case-insensitive, as HTTP says; Nexa sends them in lower case.
- Response size: Nexa reads at most the installation's panel response cap (default 1 MiB);
  a larger response is a failure.
- Redirects (3xx) are never followed and are treated as a failure.
- Unknown request fields: a bridge MUST ignore fields it does not recognise. Unknown response
  fields: Nexa ignores them. This is what makes additive changes possible within v1 (§9).

---

## 3. Authentication and integrity (HMAC-SHA256)

Each panel configured in Nexa has one **shared secret**: a string of at least 32 characters
(recommended: 32 random bytes, base64url, 43 characters). The bridge's operator generates it
and enters it in Nexa. Nexa stores it encrypted, never displays it again, and never sends it
on the wire. The HMAC key is the secret's UTF-8 bytes.

### 3.1 Request headers (every request, including `GET`)

| Header             | Value                                                             |
| ------------------ | ----------------------------------------------------------------- |
| `X-Nexa-Protocol`  | `1`                                                               |
| `X-Nexa-Timestamp` | Unix time in seconds, decimal integer, UTC (e.g. `1793000000`)    |
| `X-Nexa-Nonce`     | 32 lowercase hex characters (128 random bits), unique per request |
| `X-Nexa-Signature` | `v1=` followed by 64 lowercase hex characters                     |
| `Content-Type`     | `application/json; charset=utf-8` (writes only)                   |

### 3.2 Canonical request string

Six lines joined by a single `\n` (0x0A), with **no** trailing newline:

```
NEXA-HMAC-SHA256
<METHOD>
<PROTOCOL-PATH>
<X-Nexa-Timestamp>
<X-Nexa-Nonce>
<BODY-SHA256>
```

- `<METHOD>`: `GET` or `POST`, uppercase.
- `<PROTOCOL-PATH>`: the path beginning `/v1/`, exactly as in §1 with `{username}` substituted
  (e.g. `/v1/accounts/nx7k2m9p4qwe/disable`). No prefix, no query, no trailing slash.
- `<BODY-SHA256>`: lowercase hex SHA-256 of the **exact body bytes** sent. For a `GET` (no body)
  this is the hash of the empty string,
  `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.

`X-Nexa-Signature` is `v1=` + lowercase hex `HMAC-SHA256(secret, canonical-request-string)`.

### 3.3 What a bridge MUST check, in this order

1. `X-Nexa-Protocol` is `1`; otherwise `400 UNSUPPORTED_PROTOCOL_VERSION`.
2. The timestamp is within **±300 seconds** of the bridge's clock; otherwise
   `401 TIMESTAMP_OUT_OF_WINDOW`. Bridges MUST keep their clock NTP-synchronised.
3. The signature matches, compared in **constant time**; otherwise `401 INVALID_SIGNATURE`.
4. The nonce has not been seen in the last 600 seconds; otherwise `401 NONCE_REPLAYED`.
   The bridge stores a nonce only after the signature verified.
5. Only then parse and act on the body.

A request refused at steps 1–4 MUST NOT have any effect.

**Secret rotation.** A bridge MAY accept two secrets during a rotation window (try both). Nexa
holds exactly one per panel; the operator replaces it in the Web Admin, and the next connection
test proves the new one.

### 3.4 Response signature (every response)

The bridge signs every response it generates — 2xx and error alike — with header
`X-Nexa-Bridge-Signature: v1=<hex>` over:

```
NEXA-HMAC-SHA256-RESPONSE
<HTTP-STATUS>
<X-Nexa-Nonce of the request being answered>
<BODY-SHA256 of the exact response body bytes>
```

Binding the request's nonce means an old response cannot be replayed as the answer to a new
request. Nexa compares the signature in constant time.

**Nexa relies on the response signature for every answer that changes what it believes.** An
unsigned or wrongly-signed response is never read as success, as "account not found", or as a
refusal:

| Unsigned / wrongly signed response | Nexa's reading                                                         |
| ---------------------------------- | ---------------------------------------------------------------------- |
| 2xx                                | malformed answer (for a write: outcome UNKNOWN → reconciled by a read) |
| 401 / 403                          | authentication failed (e.g. a proxy in front of the bridge refused it) |
| 429                                | rate limited                                                           |
| 404, any other 4xx                 | malformed answer — **never** "account not found"                       |
| 5xx                                | bridge error (for a write: outcome UNKNOWN)                            |

This is what stops a wrong base URL — one pointing at some other web server whose 404 page
says nothing about Nexa's accounts — from being read as "this account does not exist", which
is the one answer that lets Nexa create an account again.

### 3.5 Test vectors

Secret: `k7Qz3N9vR2xW8pL5mT1yB6cH4jD0fG2sA9eU3iO7nK5q`

**Vector A — create.** `POST /v1/accounts`, timestamp `1793000000`, nonce
`b3f1c2d4e5a697887766554433221100`, body (exact bytes, one line):

```
{"operationId":"0b6f3c1e-8f3a-4c2d-9a51-6d1f2e3a4b5c","username":"nx7k2m9p4qwe","nexaRef":"5f0c9a7e-2b1d-4e6f-8a3c-9d2e1f0a7b6c","trafficLimitBytes":"53687091200","expiresAt":"2026-11-25T08:13:20Z","deviceLimit":2}
```

- body SHA-256: `f1c200f7507678920decaef36bbb72ab669a4824a7b8613fbd1d2ba1efbd8f07`
- canonical string:
  `NEXA-HMAC-SHA256\nPOST\n/v1/accounts\n1793000000\nb3f1c2d4e5a697887766554433221100\nf1c200f7507678920decaef36bbb72ab669a4824a7b8613fbd1d2ba1efbd8f07`
- `X-Nexa-Signature: v1=e1043079b5231752434648df1a34ff5619142844ccdfd2aa911cb75ff5cb074b`

**Vector B — get.** `GET /v1/accounts/nx7k2m9p4qwe`, timestamp `1793000000`, nonce
`00112233445566778899aabbccddeeff`, empty body →
`X-Nexa-Signature: v1=b8dcf664d514140ff4351873ba1b9f2f1509def79dea1d60781c53d19577ef6b`

**Vector C — signed 404 answering vector B.** Status `404`, body
`{"error":{"code":"ACCOUNT_NOT_FOUND","message":"no such account"}}` (SHA-256
`258da40cf4133a174c1263b53e412860ea7a5326259265e6ec7cb9714bbc7813`) →
`X-Nexa-Bridge-Signature: v1=5873939127852962daede1adeb82617124a770a316f2ed4eaed5507c5ab9d75f`

These three vectors are pinned by Nexa's unit tests; a bridge SHOULD pin them too.

---

## 4. Data types

| Type            | Encoding                                                                                                                                    |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `Bytes`         | JSON **string** holding a non-negative decimal integer, no sign, no leading zeros, ≤ 2^63−1: `^(0                                           | [1-9][0-9]{0,18})$`. Never a JSON number. |
| `Timestamp`     | JSON string, RFC 3339, **UTC with `Z`**, seconds precision, optional fractional seconds: `2026-11-25T08:13:20Z`. No offsets other than `Z`. |
| `Username`      | `^[a-z0-9_-]{4,20}$`                                                                                                                        |
| `NexaRef`       | UUID string, lowercase. Opaque. Treat as confidential (do not show it to end users).                                                        |
| `OperationId`   | UUID string, lowercase. Nexa's id for one operation; the idempotency key (§6).                                                              |
| `DeviceLimit`   | JSON integer 1..1000, or `null` for no limit.                                                                                               |
| `AccountStatus` | one of `ACTIVE`, `DISABLED`, `LIMITED`, `EXPIRED` (§4.2).                                                                                   |

`trafficLimitBytes` of `"0"` means **unlimited**. `expiresAt` of `null` means **never expires**.

### 4.1 The `Account` object

Returned by create, get and every account write.

```json
{
  "username": "nx7k2m9p4qwe",
  "nexaRef": "5f0c9a7e-2b1d-4e6f-8a3c-9d2e1f0a7b6c",
  "status": "ACTIVE",
  "trafficUsedBytes": "1073741824",
  "trafficLimitBytes": "53687091200",
  "expiresAt": "2026-11-25T08:13:20Z",
  "deviceLimit": 2,
  "lastConnection": { "supported": true, "at": "2026-10-27T19:02:11Z" },
  "subscriptionUrl": "https://sub.example.com/s/Zx81kQ2v",
  "createdAt": "2026-10-26T07:33:21Z"
}
```

| Field               | Type                      | Required | Meaning                                                                                             |
| ------------------- | ------------------------- | -------- | --------------------------------------------------------------------------------------------------- |
| `username`          | Username                  | yes      | Echo of the account's name.                                                                         |
| `nexaRef`           | NexaRef or `null`         | yes      | The `nexaRef` stored when Nexa created it; `null` for an account not created through this protocol. |
| `status`            | AccountStatus             | yes      | See §4.2.                                                                                           |
| `trafficUsedBytes`  | Bytes                     | yes      | Total consumed since creation. Never reset by any v1 operation.                                     |
| `trafficLimitBytes` | Bytes                     | yes      | Total allowance **including** what is already used. `"0"` = unlimited.                              |
| `expiresAt`         | Timestamp or `null`       | yes      | Absolute expiry.                                                                                    |
| `deviceLimit`       | DeviceLimit               | yes      | The limit the panel actually enforces now.                                                          |
| `lastConnection`    | object                    | yes      | `{"supported": false}` if the panel cannot tell; else `{"supported": true, "at": Timestamp          | null}`where`null` means _never connected_. |
| `subscriptionUrl`   | string (absolute `https`) | yes      | The link the customer receives, ≤ 2048 characters. A bearer capability.                             |
| `createdAt`         | Timestamp                 | no       | Informational.                                                                                      |

Every field reports what the **panel holds now**, read from the panel — never an echo of the
request.

### 4.2 `AccountStatus`

| Value      | Meaning                                                                      | Sticky?      |
| ---------- | ---------------------------------------------------------------------------- | ------------ |
| `ACTIVE`   | Serving.                                                                     | —            |
| `DISABLED` | Disabled by an explicit `disable` (§5.5). Only `enable` clears it.           | yes          |
| `LIMITED`  | Not disabled; `trafficUsedBytes >= trafficLimitBytes` with a non-zero limit. | no — derived |
| `EXPIRED`  | Not disabled; `expiresAt` is in the past.                                    | no — derived |

`LIMITED` and `EXPIRED` are **derived**: an allowance change that lifts the condition MUST make
the account `ACTIVE` again without any other call. An allowance change MUST NOT clear
`DISABLED`. If both derived conditions hold, report `EXPIRED`.

---

## 5. Operations

All requests are signed (§3). All examples omit the signature headers.

### 5.1 Health — `GET v1/health`

Response `200`:

```json
{
  "protocol": "nexa-custom-panel",
  "protocolVersions": [1],
  "bridge": { "name": "acme-bridge", "version": "1.4.2" },
  "upstream": "OK",
  "time": "2026-10-26T07:33:20Z"
}
```

- `protocol` MUST be exactly `nexa-custom-panel`; `protocolVersions` MUST contain `1`.
- `upstream`: `OK` | `DEGRADED` | `DOWN` — the bridge's own view of the panel behind it.
  `DEGRADED`/`DOWN` make Nexa record the panel as _degraded_: the bridge authenticated and
  answered, so the secret is right, and something behind it is wrong.
- `bridge.version`: ≤ 64 characters of `[A-Za-z0-9._+-]`; shown to the operator, never acted on.
- `time`: the bridge's clock, for the operator's diagnosis of a timestamp-window refusal.
- Health MUST NOT change any state and SHOULD answer within 2 seconds.

A signed 200 with the right `protocol` and version is the **only** successful connection test.

### 5.2 Create account — `POST v1/accounts`

Request:

```json
{
  "operationId": "0b6f3c1e-8f3a-4c2d-9a51-6d1f2e3a4b5c",
  "username": "nx7k2m9p4qwe",
  "nexaRef": "5f0c9a7e-2b1d-4e6f-8a3c-9d2e1f0a7b6c",
  "trafficLimitBytes": "53687091200",
  "expiresAt": "2026-11-25T08:13:20Z",
  "deviceLimit": 2
}
```

All six fields are required (`expiresAt` and `deviceLimit` may be `null`).

| Outcome                                                                                     | Status | Body                                      |
| ------------------------------------------------------------------------------------------- | ------ | ----------------------------------------- |
| Created now                                                                                 | 201    | `{"account": Account, "replayed": false}` |
| Replay of an `operationId` this bridge already applied (§6)                                 | 200    | `{"account": Account, "replayed": true}`  |
| `username` already exists (created by another operation, by hand, or by anyone)             | 409    | error `ALREADY_EXISTS`                    |
| Same `operationId` with a different `username` or `nexaRef`                                 | 409    | error `IDEMPOTENCY_KEY_REUSED`            |
| The panel refuses by a rule (user quota, minimum duration, cannot enforce `deviceLimit`, …) | 422    | error `RULE_REFUSED`                      |

Requirements:

- **Read-your-writes.** A 2xx MUST NOT be returned until a `GET v1/accounts/{username}` would
  find the account. (Nexa does not poll after a create.)
- **Store `nexaRef`** with the account, and return it on every read. This binding is how Nexa
  proves, after a lost answer, that an account under this name is the one it asked for.
- **Apply exactly what was asked.** The bridge MUST NOT drop a traffic cap, add days, round a
  limit, or reinterpret the plan to find a request the panel will accept. If the panel cannot
  hold what was asked — including `deviceLimit` — the answer is `422 RULE_REFUSED`, and nothing
  is created. A non-null `deviceLimit` MUST be enforced.
- `trafficUsedBytes` of a new account is `"0"`.
- The bridge MUST NOT set a periodic traffic reset on the account.
- The account is created `ACTIVE` (subject to §4.2's derived states).

### 5.3 Get account — `GET v1/accounts/{username}`

| Outcome        | Status | Body                                          |
| -------------- | ------ | --------------------------------------------- |
| Exists         | 200    | `{"account": Account}`                        |
| Does not exist | 404    | error `ACCOUNT_NOT_FOUND` — **signed** (§3.4) |

This read is what Nexa relies on to settle every ambiguous outcome. Its semantics are strict:

- `404 ACCOUNT_NOT_FOUND` is a **positive statement**: the bridge authenticated the request,
  asked its panel, and the panel holds no account with this name. A bridge MUST NOT return it
  because the panel was unreachable, slow, or returned an error — that is a 5xx
  (`UPSTREAM_UNAVAILABLE`). A false "not found" makes Nexa create a second account, or tell an
  operator a customer's account vanished.
- The read MUST reflect every write the bridge has acknowledged (read-your-writes).
- It MUST NOT change any state, and MUST NOT require an `operationId`.

How Nexa uses the answer (informative):

| Answer                                  | Nexa concludes                                                                                                                                                                                                                                                  |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 200, `nexaRef` equals the service's ref | The account is this service's: usage, expiry and the live card are refreshed. After a create whose answer was lost, v1 does **not** adopt it automatically: the service waits for an operator, as on every panel without a recorded create answer (`OQ-C2-01`). |
| 200, `nexaRef` is a different value     | A refusal (read as `PROVIDER_REFUSED`, 409): the name is held by another account. Neither found nor absent; an operator decides.                                                                                                                                |
| 200, `nexaRef` is `null`                | The same: an account not created through this protocol is never managed or adopted.                                                                                                                                                                             |
| signed 404 `ACCOUNT_NOT_FOUND`          | Absent. (After a lost create, Nexa still asks twice before creating again.)                                                                                                                                                                                     |
| anything else                           | Unknown; nothing is concluded.                                                                                                                                                                                                                                  |

### 5.4 Set allowance — `POST v1/accounts/{username}/allowance`

Renew, add traffic and add time are **one** operation that sets **absolute targets** — never
increments.

```json
{
  "operationId": "7d4e2c10-55a1-4f0e-b2c3-0e9d8f7a6b5c",
  "nexaRef": "5f0c9a7e-2b1d-4e6f-8a3c-9d2e1f0a7b6c",
  "expiresAt": "2026-12-25T08:13:20Z",
  "trafficLimitBytes": "107374182400"
}
```

- There is no field saying whether this is a renewal, extra traffic or extra time, and
  there must not need to be one: the targets are the whole instruction.
- `expiresAt` and `trafficLimitBytes` are each **optional; an omitted field is left unchanged**.
  At least one MUST be present; `null` is not allowed for either. `trafficLimitBytes` is the
  **total** allowance including what is already used, never a delta.
- Applying the same targets twice changes nothing (that is why they are absolute).
- MUST NOT reset `trafficUsedBytes`. MUST NOT clear `DISABLED`. MUST lift `LIMITED`/`EXPIRED`
  when the new targets lift them (§4.2).
- Success `200 {"account": Account}` — the account as the panel holds it after the change.
  Nexa checks that it carries the targets it asked for; one that does not is a malformed
  answer, not a renewal. A replay (`"replayed": true`) is not compared (§6.3).
- Errors: `404 ACCOUNT_NOT_FOUND`, `409 ACCOUNT_NOT_BOUND`, `409 IDEMPOTENCY_KEY_REUSED`,
  `422 RULE_REFUSED`.

### 5.5 Disable — `POST v1/accounts/{username}/disable`

### 5.6 Enable — `POST v1/accounts/{username}/enable`

```json
{
  "operationId": "c1a2b3d4-0000-4000-8000-000000000001",
  "nexaRef": "5f0c9a7e-2b1d-4e6f-8a3c-9d2e1f0a7b6c"
}
```

- `disable` makes the account stop serving and sets `DISABLED`. `enable` clears `DISABLED`
  (the account then reads `ACTIVE`, `LIMITED` or `EXPIRED` by §4.2). Neither touches the
  allowance, the usage or the link.
- Both are idempotent by state: disabling a disabled account answers `200` and changes nothing.
- Success `200 {"account": Account}`, which Nexa checks: after `disable` the status is
  `DISABLED`, after `enable` it is not (a replay is not compared). Errors:
  `404 ACCOUNT_NOT_FOUND`, `409 ACCOUNT_NOT_BOUND`.

### 5.7 Delete — `POST v1/accounts/{username}/delete`

Body as §5.5. Removes the account from the panel.

- Success `200 {"deleted": true}`.
- `404 ACCOUNT_NOT_FOUND` if there is no such account — Nexa treats this as "already gone",
  which is the normal answer to a delete repeated after a lost response.
- `409 ACCOUNT_NOT_BOUND` if the account's stored `nexaRef` differs from the request's or is
  `null`. **A bridge MUST NOT delete an account bound to a different `nexaRef`.** This is what
  makes a delete by name safe.

### 5.8 Change link — `POST v1/accounts/{username}/rotate-link`

Body as §5.5. Invalidates the account's current subscription link and issues a new one; nothing
else about the account changes.

- Success `200 {"account": Account}` carrying the **new** `subscriptionUrl`, which MUST differ
  from the previous one.
- Idempotent on `operationId`: a replay MUST NOT rotate a second time; it answers `200` with
  the account as it is now and `"replayed": true`.
- Errors: `404 ACCOUNT_NOT_FOUND`, `409 ACCOUNT_NOT_BOUND`, `422 RULE_REFUSED`.
- The old link SHOULD stop working. Nexa does not claim that it does.

Nexa reads the account back after a rotation and takes the new link from that read; a link
equal to the old one is treated as "no rotation happened".

### 5.9 Get connection links — `GET v1/accounts/{username}/links`

```json
{
  "subscriptionUrl": "https://sub.example.com/s/Zx81kQ2v",
  "configs": [{ "name": "DE-1 vless", "uri": "vless://…" }]
}
```

- `configs`: 0..50 entries; `name` ≤ 64 characters; `uri` ≤ 4096 characters. Bearer credentials.
- Errors: `404 ACCOUNT_NOT_FOUND`. MUST NOT change state.
- Nexa v1 delivers `subscriptionUrl` from the Account object and does **not yet call this
  endpoint**; bridges SHOULD implement it so raw-config delivery can be enabled later without a
  protocol change.

---

## 6. Idempotency, binding and ambiguous outcomes

**Why this section exists.** Nexa never retries a create whose answer was lost. A timeout, a
dropped connection or a 5xx after a create leaves the outcome **UNKNOWN**; Nexa then settles it
by **reading** the account (§5.3), and refunds the customer only when the read proves nothing
was created — a signed `404`, twice. An idempotent write (allowance, disable, enable, delete,
rotate) is instead tried again with the **same** `operationId`, which this section makes safe.
A create is never tried again after a lost answer; when the read then finds the account bound
to the service, v1 leaves it for an operator rather than adopting it (`OQ-C2-01`). The
bridge's job is to make those reads trustworthy and those writes repeatable.

1. **`operationId` is the idempotency key** for every write. Nexa uses one `operationId` per
   operation and reuses it unchanged on every attempt of that operation.
2. A bridge MUST record `(operationId → operation, username, nexaRef)` when a write **takes
   effect**, and keep it for at least **30 days**. It MAY record writes it refused by a rule.
   It MUST NOT record requests refused at authentication (§3.3), rate-limited, or that failed
   before taking effect.
3. A write whose `operationId` is already recorded for the same operation, `username` and
   `nexaRef` MUST NOT be applied again. The bridge answers `200` with the account **as it is
   now** and `"replayed": true` (for delete: `{"deleted": true, "replayed": true}`, or
   `404 ACCOUNT_NOT_FOUND`). Allowance values in a replay are not compared: the first
   application wins.
4. The same `operationId` with a different operation, `username` or `nexaRef` is
   `409 IDEMPOTENCY_KEY_REUSED`, with no effect.
5. **Binding.** Every write addressed to an existing account carries `nexaRef`. A bridge MUST
   refuse it with `409 ACCOUNT_NOT_BOUND`, with no effect, unless the account's stored
   `nexaRef` equals it. Nexa only manages accounts it created through this protocol.
6. A write MUST be atomic from Nexa's point of view: it either takes full effect or none. A
   partial application (e.g. expiry changed, traffic not) MUST be completed or rolled back by
   the bridge before it answers, or answered 5xx and completed/rolled back before the next read.

---

## 7. Errors

### 7.1 Envelope

```json
{ "error": { "code": "RULE_REFUSED", "message": "free text, for the bridge operator's logs" } }
```

- `code` is from the table below. `message` is optional, ≤ 500 characters.
- Nexa **never shows, stores or forwards `message`**. What an operator or customer sees comes
  from Nexa's own Persian text, keyed on the code and status.
- Error responses are signed like any other (§3.4).

### 7.2 Codes

| Code                           | Status | Effect on the bridge | Nexa's reading (`ProviderFailureKind`)                                      |
| ------------------------------ | ------ | -------------------- | --------------------------------------------------------------------------- |
| `INVALID_REQUEST`              | 400    | none                 | refused (`PROVIDER_REFUSED`) — definitive                                   |
| `UNSUPPORTED_PROTOCOL_VERSION` | 400    | none                 | refused (`PROVIDER_REFUSED`)                                                |
| `INVALID_SIGNATURE`            | 401    | none                 | `AUTHENTICATION_FAILED`                                                     |
| `TIMESTAMP_OUT_OF_WINDOW`      | 401    | none                 | `AUTHENTICATION_FAILED` (operator: check clocks)                            |
| `NONCE_REPLAYED`               | 401    | none                 | `AUTHENTICATION_FAILED`                                                     |
| `ACCOUNT_NOT_FOUND`            | 404    | none                 | `NOT_FOUND` — read: absent · delete: already gone · other writes: not found |
| `ALREADY_EXISTS`               | 409    | none                 | refused (`PROVIDER_REFUSED`, 409)                                           |
| `ACCOUNT_NOT_BOUND`            | 409    | none                 | refused (`PROVIDER_REFUSED`, 409)                                           |
| `IDEMPOTENCY_KEY_REUSED`       | 409    | none                 | refused (`PROVIDER_REFUSED`, 409)                                           |
| `RULE_REFUSED`                 | 422    | none                 | refused (`PROVIDER_REFUSED`, 422)                                           |
| `RATE_LIMITED`                 | 429    | none                 | `RATE_LIMITED` (MAY send `Retry-After` in seconds)                          |
| `INTERNAL_ERROR`               | 500    | unknown              | `PROVIDER_ERROR` — for a write, outcome UNKNOWN                             |
| `UPSTREAM_UNAVAILABLE`         | 503    | unknown              | `PROVIDER_ERROR` — for a write, outcome UNKNOWN                             |
| `UNSUPPORTED_OPERATION`        | 501    | none                 | `UNSUPPORTED_CAPABILITY`                                                    |

Rules:

- Every 4xx in this table means **nothing happened**. A bridge MUST NOT return one after a
  write took effect. If it cannot tell, it returns 5xx.
- A code not in this table, or a code with a status other than its row's, is read by Nexa as
  `PROVIDER_ERROR` (UNKNOWN for a write) — the safe reading, because it costs a read rather than
  a refund for an account the customer may hold.
- Every v1 operation is mandatory except `links` (§5.9); `UNSUPPORTED_OPERATION` exists for
  forward compatibility and makes Nexa refuse the operation without retrying.
- These readings apply to **signed** answers only. An unsigned or wrongly signed answer is
  read by §3.4's table, whatever code it carries.

### 7.3 Malformed answers

Nexa treats as **malformed** (`MALFORMED_RESPONSE`): a body that is not a JSON object; a 2xx
missing a required field; a `Bytes` field that is a JSON number, negative, has leading zeros
or exceeds 2^63−1; a non-UTC or unparsable `Timestamp`; an unknown `status`; a
`subscriptionUrl` that is not absolute `https`; an `account.username` that differs from the
request; an unsigned or wrongly signed response (§3.4). For a write, a malformed 2xx is an
UNKNOWN outcome: the write probably happened, and a read settles it.

---

## 8. Timeouts and pacing

- The operator MAY set a **request timeout per panel** (1–30 s, the activation field
  `requestTimeoutMs`). Nexa uses the **smaller** of it and the installation's panel HTTP
  timeout (`PANEL_HTTP_TIMEOUT_MS`, 10 s by default): a per-panel value can make Nexa give
  up on one bridge sooner, never wait longer than for any other panel. It covers one request
  end to end: DNS, connect, TLS, request, response. Below about 5 s, slow successes start to
  become UNKNOWN outcomes; the Web Admin says so.
- A bridge SHOULD answer health within 2 s and every other request within 5 s. A bridge that
  cannot finish a write in time SHOULD still finish it and let Nexa's read settle the outcome;
  it MUST NOT answer 2xx for a write that has not taken effect.
- Nexa never retries a write automatically and retries reads only within its own monitor
  cadence. Background health checks run at the installation's monitor interval with a
  per-panel cooldown and a per-tenant budget.
- `429` is honoured as a rate limit, not a fault: Nexa backs off rather than retrying sooner.

---

## 9. Versioning

- The version is in the path (`/v1/`) and the `X-Nexa-Protocol` header, and advertised by
  health's `protocolVersions`.
- **Within v1**, only additive changes: a new optional response field, a new optional request
  field a bridge may ignore, a new endpoint Nexa calls only after health advertises it. Nothing
  that changes the meaning of an existing field, status or code.
- Anything else is **v2**, at `/v2/`. A bridge MAY serve several versions; Nexa uses the
  highest version both sides support and never silently falls back.

---

## 10. Security notes for bridge authors

- Verify before parsing (§3.3). Compare signatures in constant time. Reject bodies over 64 KiB.
- Never log the secret, `X-Nexa-Signature`, `subscriptionUrl`, `configs` or `nexaRef`.
- Bind the bridge to HTTPS with a valid certificate; Nexa will not call `http://`.
- The bridge holds your panel's admin credentials; Nexa never sees them. Give the bridge the
  least privilege your panel allows.
- Enforce the binding (§6.5) on every write. It is what stops a delete or a suspend by name from
  reaching an account Nexa did not create.

---

## 11. Conformance checklist (for a bridge)

1. Health answers per §5.1, signed.
2. Vectors A–C (§3.5) verify.
3. Stale timestamp, bad signature and repeated nonce are refused 401 with no effect.
4. Create → get returns the same account immediately (read-your-writes), with `nexaRef`.
5. The same create replayed returns `200 replayed:true` and creates nothing.
6. Create of an existing name answers `409 ALREADY_EXISTS`.
7. Get of a missing name answers a **signed** `404 ACCOUNT_NOT_FOUND`; with the panel down, a 5xx.
8. Allowance with only `expiresAt` leaves the traffic limit unchanged, and vice versa; usage is
   never reset; `LIMITED`/`EXPIRED` lift, `DISABLED` does not.
9. Disable/enable twice in a row changes nothing the second time.
10. Delete twice: `200` then `404`. Delete or disable with a different `nexaRef`: `409
ACCOUNT_NOT_BOUND`, account untouched.
11. Rotate replayed with the same `operationId` does not rotate twice.
12. Bytes are always strings; timestamps always `Z`.

---

## 12. Acceptance against the first real bridge (recommended before the flag is turned on)

Nexa's tests prove that its adapter and **this document** agree: a mock bridge written from
this document (`tests/support/fake-custom-bridge.ts`, tests only) verifies every request,
signs every answer, keeps the idempotency log and the binding, and is driven through every
operation and every failure mode — timeout, 5xx before and after applying, a dropped
connection, unsigned and wrongly signed answers, an unsigned 404, every malformed payload
§7.3 names, an unknown code, a missing account, an account bound elsewhere, a reused
operation id, a rate limit and a skewed clock. They cannot prove that any real bridge does.

So before `custom_panel_provider` is turned on for a production tenant, run an **acceptance
test against the first real bridge**, with a disposable account namespace on its panel:

- Driven by Nexa's own shipped adapter over its real HTTP client — not by a script that
  re-implements the protocol, which would only prove that two readings of this document
  agree.
- Configured from the environment (the bridge's base URL and secret), and **failing**,
  never skipping, when they are absent — the rule `pnpm test:acceptance` already follows
  for real panels (`docs/real-panel-acceptance.md`).
- Covering §11 items 1–12 in order, each observed from the **panel's** side as well as
  the bridge's answer: the account exists with exactly the traffic, expiry and device
  limit asked for; a replayed create creates nothing; an allowance with one field leaves
  the other unchanged and never resets usage; a disable stops the account serving and an
  enable restarts it; a rotation invalidates nothing it should not; a delete or disable
  carrying another `nexaRef` leaves the account untouched; and a signed `404` comes back for
  a name that does not exist while a stopped upstream yields a 5xx, never a `404`.
- Recorded with the bridge's name and version (`GET v1/health`) and the date, so the
  capability list in the `custom` descriptor rests on evidence rather than on this
  document alone.
