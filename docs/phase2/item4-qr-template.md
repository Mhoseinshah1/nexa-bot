# Phase 2 item 4: the subscription QR on a configurable background

Master prompt ITEM 4. Audit: `phase2-ux-wave-audit.md` §Item 4 (MISSING before this change).
Falsification: `docs/phase2/item4-falsification.md`.

## What a customer receives

Every QR NEXA generates for a customer is still the code of the EXACT subscription link. Only
its presentation is configurable:

- **Default (nothing configured):** the plain black-on-white QR, byte for byte what
  `encodeQrPng` wrote before this change. No tenant sees a difference until an operator
  configures a background AND a placement.
- **Configured:** the tenant's background image, with a square region painted white and the
  code drawn black in its centre.

The three places a customer QR is sent all go through one port, `DeliveryQrRenderer`
(`provisioning/application/ports.ts`), in `delivery.service.ts`:

| Site          | When                                                             |
| ------------- | ---------------------------------------------------------------- |
| `sendCard`    | the delivery card after a purchase AND after a trial (same path) |
| `sendRotated` | a changed link, when the card it was asked from cannot be edited |
| `sendLinkQr`  | the QR under «🔗 لینک اشتراک» on My Services (pre-support A9)    |

A panel whose delivery mode is `CARD_TEXT` still sends no QR at all; that check is unchanged
and precedes the renderer.

## Storage and configuration (no parallel system)

- **Background:** the existing tenant media slot table, `tenant_media_assets`, under a new
  purpose `QR_BACKGROUND` (contract change, then migration `0212_qr_background_media`, which
  only widens the purpose CHECK). Same 1 MiB cap, same magic-number check, same audit
  (`tenant_media.upload` / `tenant_media.clear`, metadata only, never the bytes), same
  idempotency and scope-activity rules as the referral banner. The slot is **PNG only**
  (`TENANT_MEDIA_PURPOSE_MIME_TYPES`): it is decoded on the server, and this release has no
  JPEG decoder (no new dependency in a process that holds bot tokens — a PO decision if JPEG is
  wanted later).
- **Placement:** a registry setting, `delivery.qr_template`: `{ x, y, size, quietZoneModules }`
  or `null` (the default, the plain QR). Versioned and audited like every setting
  (`settings.set`), `settings.edit` to write.
- **Tenant-aware:** both are keyed by tenant. Tenant B never sees tenant A's background, and a
  template is validated against the writer's own tenant's background.

## Validation and the scannability safeguards

At upload (`TenantMediaService` + `QrBackgroundContentCheck`), refused as `MEDIA_INVALID` with a
reason the Web Admin translates:

| Reason                | Rule                                                                      |
| --------------------- | ------------------------------------------------------------------------- |
| `TYPE_NOT_ALLOWED`    | anything but `image/png` for this slot                                    |
| `DIMENSIONS`          | a side under 128 px or over 2048 px                                       |
| `UNSUPPORTED_FORMAT`  | 16-bit, sub-byte, interlaced, an unknown colour type or critical chunk    |
| `DECOMPRESSION_BOUND` | image data that inflates past what its header declares                    |
| `CORRUPT`             | a bad CRC, a truncated stream, a bad filter, no IEND, a bad palette index |

Decompression bombs: the dimensions are read from the header and bounded (≤ 2048 × 2048)
BEFORE anything is inflated, and `inflateSync` is given exactly the size the header implies as
`maxOutputLength`; more output is a refusal, not a truncation.

At save (`QrTemplateGuard`, inside the settings write's transaction): the schema demands whole
numbers, a region of at least 128 px and a quiet zone of 4–16 modules; the guard demands a
stored background and a region wholly inside it, and composes a link of typical length
(`probeQrTemplate`, 41 modules) on it: a region whose modules would reach the customer under
4 px, or a composite over 1.5 MiB, is refused at save. Clearing (null) is never refused.

At render (`composeQrOnBackground`), every delivery:

- the module scale is `floor(size / (modules + 2 × quiet))` — an integer, the same both ways,
  so the code is never stretched, distorted or resampled;
- the whole region is painted white, so the quiet zone is at least the configured number of
  modules on every side (the floor's remainder only adds to it) and the background never
  touches a finder pattern;
- the code is black on white whatever the background, so contrast does not depend on it;
- a module under 4 px **as the customer receives it** — Telegram serves a photo at most
  1280 px on its longest side, so the rule is `scale × min(1, 1280 / longest side) ≥ 4`
  (`qrEffectiveModulePx`, shared by the renderer, the guard and the Web Admin; unverified
  against real Telegram, `OQ-QR-TEMPLATE-01`) — a long link in a small region, a region outside a background that was
  replaced by a smaller one, a background that no longer decodes, or a composed image over
  1.5 MiB sends the **plain QR** instead and is logged (`The QR template was not used`). A
  delivery never fails because of decoration.

The output is a freshly encoded 8-bit RGB PNG (IHDR, IDAT, IEND only; every row Paeth
filtered), so no metadata an uploaded file carried reaches a customer. It is deterministic.

**Why 1.5 MiB.** The upload must finish inside the customer send timeout
(`NOTIFICATION_SEND_TIMEOUT_MS`, 10 s by default), and a timed-out send is an UNKNOWN outcome
the delivery card never retries. Telegram's own 10 MB limit is not the bound that matters.

**Caching.** Composition runs on the API thread for the link view's QR and the preview. The
renderer keeps the decoded background per (tenant, SHA-256) and the composed image per
(tenant, background SHA-256, template, link) in bounded in-process LRUs (2 decoded images,
32 composites / 24 MiB). A warm render reads the template and the background's digest — never
its bytes — and decodes nothing; a replaced background has a new digest, so nothing stale is
served.

## Web Admin

«🎨 ظاهر ربات», section «پس‌زمینهٔ QR اشتراک» (`apps/web/src/pages/qr-template.tsx`), Persian RTL:
a status badge (active / default), the current background's dimensions, size, version and
date, a PNG picker validated in the browser with the contract's own header inspection, the
four placement fields validated with the contract's own schema and placement rule before save,
a «وسط تصویر» helper, «پیش‌نمایش» — the SERVER's rendering of the draft
(`POST /delivery-qr/preview`, read-only, `settings.view`), which states the module size and,
when the plain QR would be sent, why — and «بازگشت به پیش‌فرض», which clears the placement and
then removes the background. The settings page does not draw the key
(`SETTINGS_MANAGED_ELSEWHERE`).

## Telegram

The QR is sent with `sendPhoto`, as before. Telegram recompresses a photo (JPEG), which is why
the minimum module is 4 px and the code is drawn black on white. Nothing about the background
is rendered by Telegram; it is part of the delivered image. Telegram's photo limits (10 MB,
width + height ≤ 10000, aspect ≤ 20) are inside the bounds above (≤ 2048 px a side, ≤ 1.5 MiB).

## Item 6 (provider-originated QR) — the seam, not the feature

`DeliveryQrSource` has two kinds: `PAYLOAD` (NEXA encodes the link) and `PROVIDER_IMAGE` (a QR
image the provider produced). The renderer returns a `PROVIDER_IMAGE` **byte for byte**, with
origin `PROVIDER_ORIGINATED`: never decoded, never re-encoded and never drawn on the template,
because a provider may encode more than the visible link. Nothing in this release passes a
`PROVIDER_IMAGE`; Agent E (RickPanel QR) plugs into this port once the provider's QR source is
evidenced. Whether a provider QR may be framed by the template later is item 6's decision; this
release does not do it.

## Decisions and assumptions (for the PO)

1. **PNG only** for the background (no JPEG decoder dependency). JPEG would need e.g. `jpeg-js`.
2. **No built-in branded default ships.** The default is the plain QR, unchanged, as the
   instructions for this agent specify; a branded default can be any PNG an operator uploads.
3. Replacing the background with a smaller one is accepted; a placement that no longer fits
   sends the plain QR (and the preview says so) rather than refusing the upload.
4. The preview encodes a sample link of typical length; a much longer real link has more
   modules and may fall back where the sample did not. The preview says so.

## Migration number (coordination)

The migration is `0212_qr_background_media` because Agent D's delivery tutorials (PR #216)
take 0211. Until #216 merges, this branch's journal entry sits at `idx` 211 (the journal test
demands consecutive indices) and its snapshot chains from 0210's. When main carries 0211,
merging it here means: set this entry's `idx` to 212, re-stamp `when` with `Date.now()`, and
regenerate `meta/0212_snapshot.json` so its `prevId` is 0211's snapshot id (`pnpm db:check`
must pass). The SQL itself is one self-contained CHECK widen and does not change.
