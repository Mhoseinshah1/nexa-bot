# Package E — RickPanel subscription files: audit and design

The post-WP20 brief's Package E: a customer with a RickPanel service can ask Nexa, from their
service detail, for the panel's ready-made connection files, and receives each one as a
Telegram document.

## 1. The evidence

The only evidence is the owner's `rickpanel-openapi.json`, the same document every other
RickPanel route in `rickpanel.adapter.ts` was built from. Its descriptions are the contract and
its schemas are lossy (`docs/rickpanel-adapter-audit.md`). For
`GET /api/user/{username}/files` it says:

- It returns **every downloadable format**. Each entry carries `content_b64`, `filename`,
  `media_type` and a ready-made `caption`.
  - "You do not need to know which formats exist; a new one starts appearing on its own."
  - A format that fails to build comes back with an **`error` and no content**, and the other
    files stay usable.
- **404** is "a user you do not own", the same as one that does not exist.
- Asking for the bytes is limited to **once a minute per user**, and answers **429 with
  `Retry-After`**. `meta_only=true` returns the list without the bytes and is not limited.
- `caption` overrides every file's caption. Empty uses the panel's own caption.

What the document does NOT say, and how this package handles each gap:

| unstated                                | handled as                                                                                                                                             |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| the response envelope                   | a bare array, or an object whose `files` is an array. Anything else is `MALFORMED_RESPONSE`, never an empty list.                                      |
| the type of `error`                     | any present, non-null `error` marks the entry failed. Its text is never read, stored or shown.                                                         |
| the `Retry-After` format                | delta-seconds are honoured. An HTTP-date or a missing header falls back to the documented window of 60 s.                                              |
| 429 is not among the declared responses | handled anyway, because the prose promises it.                                                                                                         |
| a single-format endpoint                | `GET /api/user/{username}/file/{fmt}` exists and needs a `platform`. The brief says to use the all-files endpoint, and this package uses nothing else. |

This code has not been run against a real RickPanel, exactly like the rest of the adapter
(`docs/real-panel-acceptance.md`). It agrees with a fake this repository wrote. That is the
external acceptance gap, §8.

## 2. The capability (E1)

- **A new capability, `SUBSCRIPTION_FILES`.** `DELIVER_CONFIG_FILE` exists but means a
  different thing: a delivery SHAPE (`ServiceDelivery.CONFIG_FILE`). No adapter declares it,
  and two tests pin that absence. Reusing it would advertise a delivery shape nothing
  produces.
- **An optional adapter method, `fetchSubscriptionFiles`, with `canFetchSubscriptionFiles`.**
  The guard requires the method AND the declaration, exactly as rotation and the management
  operations do. A provider without both never shows the button, and nothing in the Telegram
  handler names a provider.
- **The result is provider-neutral.** Each file has:
  - a file name;
  - a media type from a closed set;
  - bytes;
  - a caption.

  Beside the files is a count of the formats that failed.

- **RickPanel declares the capability in the same change that implements it**, the D7 rule
  of `docs/rickpanel-rotate-audit.md`, on the same evidence. Marzban and 3X-UI do not declare
  it.

## 3. Bounds and validation (E3)

The whole response is bounded by the panel HTTP client's existing cap,
`PANEL_HTTP_MAX_RESPONSE_BYTES`.

- The default is 512 KiB and the configured maximum is 8 MiB. The brief prefers existing
  repository limits, and an adapter still cannot widen its own client.
- A response over the cap is `MALFORMED_RESPONSE`, which the customer hears as
  "unavailable". An operator whose panel produces larger files raises the setting.

Inside the response, after decoding:

- **At most 20 entries.** More is refused as `MALFORMED_RESPONSE`, not truncated.
- **Each file 1 byte to 5 MiB**, and **at most 20 MiB in total**. A file past either bound
  counts as a failed format.
- **Base64 is strict.** It must use the standard alphabet with correct padding, and must
  re-encode to the same text. Anything else is a failed format, never a partial decode.
- **The file name is reduced to a base name.**
  - Path separators, control characters and quotes are removed, and the name is capped at
    128 characters.
  - An empty name becomes `subscription-<n>`.
  - `multipart.ts` escapes it again on the way out.
- **The media type is mapped into a closed set.** Anything else, or a type with parameters
  beyond `charset`, is sent as `application/octet-stream`. Telegram uses the file name for the
  icon.
  - `text/plain`, `application/json`, `application/yaml` / `text/yaml`, `application/xml`,
    `text/xml`, `application/x-yaml`, `image/png`, `application/octet-stream`.
- **The caption** has control characters except newline removed, and is capped at 900
  characters. It is sent through a PLAIN_TEXT template (`bot.service.file_caption`,
  `{caption}`), so a panel's text is never parsed as HTML. With no caption, the file goes bare.

## 4. Security (E3)

- **The bytes live only in memory, for one tap.** They are never written to a table, an audit
  row, an event, the outbox, a notification or a log. No audit row is written for the read
  at all. It changes nothing, and an audit row would be the easiest place to leak a file
  name.
- **Only the service's owner.** The tap re-runs `ProvisioningService.getForCustomer`
  (tenant, customer and not-refunded, in the query), and every miss answers
  `bot.service.not_found`. The files go only to the private chat the tap came from, like
  the subscription link (`serviceResend`).
- **No provider text reaches a log or an error.** A failed entry's `error` is counted, not
  read. A transport failure keeps the closed `ProviderFailureResult` vocabulary.

## 5. Rate limit (E4)

- A 429 carries `retryAfterMs` from the header. The customer is told to try again after
  that many seconds (`bot.service.files_rate_limited`), rounded up and at least 1.
- Nothing retries, in a loop or later. A 429 is the panel declining, not a mutation that
  failed, and no operation, condition or failure counter records it.
- The read takes the tenant's outbound panel budget (`takeProbeBudget`, reserve 0), the
  same bound every other panel read spends. A tap that finds it empty is answered
  "unavailable", and nothing is read.
- **No capability probe is made at all.** Whether a panel offers files is its descriptor's
  answer, so `meta_only` is never needed and the content limit is spent only by a tap.

## 6. The customer (E2)

- `سرویس‌های من → مشخصات سرویس` shows `📁 دریافت فایل‌های اتصال` when both hold:
  - the service is `ACTIVE`, `SUSPENDED` or `EXPIRED`, the states in which a subscription
    link is re-sent;
  - its panel's adapter can fetch files.
- The files are **on demand only**. Nothing sends them after a purchase.
- A tap:
  1. re-checks ownership, the private chat and the state;
  2. reads the files;
  3. sends each as a document with its file name and media type;
  4. stops at the first send Telegram does not accept.

  Then it answers once:
  - every format sent: nothing more;
  - some failed: `bot.service.files_partial` with the count;
  - none usable, the user unknown to the panel, a panel that cannot be read, or an empty
    budget: `bot.service.files_unavailable`;
  - 429: `bot.service.files_rate_limited`.

## 7. Not in this package (E5)

- A Web Admin file browser. `SubscriptionFileService` returns the files to one sender, so an
  admin surface would add a sender, not a second fetch.
- The single-format endpoint, the `meta_only` listing and the caption override.

## 8. External acceptance gap

The adapter and the fake agree. Two things only a real RickPanel settles:

- the real envelope, `error` shape and `Retry-After` format of `/files`;
- whether its files open in the clients they are named for.

`tests/acceptance/real-panel-rickpanel.test.ts` has never been run against a RickPanel.

## 9. Rollback

There is no migration and no stored value. The previous release has no button, no
capability and no template, and a tap on an old message it cannot parse answers as any
unknown callback does.
