# Phase 2 item 4 — falsification record

Item: the subscription QR on a configurable background (`docs/phase2/item4-qr-template.md`).

Driver: `scripts/mutate-p2-item4.py`. Each mutation reverts one rule, runs the named test, and
restores the file byte for byte (contract mutants rebuild `@nexa/contracts` before the run and
after the restore). A mutant counts as KILLED only if the named test RAN and FAILED. Run on
2026-10-06 against a dedicated integration database (`nexa_test_p2c`). Every image assertion
decodes the produced PNG with `jsqr` through a reader in `tests/support/qr-decode.ts`, never
through the production decoder.

Unit: `tests/unit/delivery-qr-template.test.ts` (U), `tests/unit/delivery-qr-contract.test.ts`
(C). Integration: `tests/integration/delivery-qr-template.test.ts` (I). Web:
`tests/web/qr-template.test.tsx` (W).

| ID   | Rule reverted                                                                  | Test that failed                                                                       | Result |
| ---- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- | ------ |
| Q-01 | The module scale is the floor (made `Math.round`)                              | never rounds the module up into the quiet zone: the scale is the floor (U)             | KILLED |
| Q-02 | The region is painted white (fill removed)                                     | draws every module as an exact scale × scale block, centred, … quiet zone white (U)    | KILLED |
| Q-03 | The code is centred in the region (left edge pinned)                           | draws every module as an exact scale × scale block, … (U)                              | KILLED |
| Q-04 | A module under 4 px falls back (minimum made 1)                                | refuses a region too small for this link at the minimum module size (U)                | KILLED |
| Q-05 | The region must lie inside the background (check removed)                      | refuses a region that does not lie inside the background (U)                           | KILLED |
| Q-06 | Every module is a full scale × scale block (one pixel short)                   | draws every module as an exact scale × scale block, … (U)                              | KILLED |
| Q-07 | The default is byte for byte the plain QR (scale 9)                            | with nothing configured, is byte for byte the plain QR … (U)                           | KILLED |
| Q-08 | A provider image passes through untouched (re-encoded)                         | passes a provider-originated image through untouched … (U)                             | KILLED |
| Q-09 | An undecodable background falls back (its cached refusal ignored)              | falls back to the plain QR, and reports why, for every template it cannot use (U)      | KILLED |
| Q-10 | An unreadable template setting falls back (error rethrown)                     | falls back when reading the configuration throws, and never fails the delivery (U)     | KILLED |
| Q-12 | The preview renders the DRAFT, not the stored template                         | previews a draft template without storing it, and reports the plain fallback (U)       | KILLED |
| Q-13 | Inflate is held to the header-declared size (`maxOutputLength` removed)        | refuses a decompression bomb by the header-declared size … (U)                         | KILLED |
| Q-14 | Every chunk's CRC is checked (check removed)                                   | checks every chunk’s CRC, an ancillary chunk the image does not need included (U)      | KILLED |
| Q-15 | Alpha is flattened onto white (raw value used)                                 | reads greyscale, palette, grey+alpha and RGBA, alpha flattened onto white (U)          | KILLED |
| Q-16 | An unknown critical chunk is refused (accepted)                                | refuses 16-bit, sub-byte and interlaced images, and an unknown critical chunk (U)      | KILLED |
| Q-17 | A file with no IEND is refused (check removed)                                 | refuses damage as CORRUPT: a bad checksum, a short stream, a bad filter, no IEND (U)   | KILLED |
| Q-18 | The Paeth filter is decoded as Paeth (made Up)                                 | reads RGB in all five scanline filters exactly (U)                                     | KILLED |
| Q-19 | An interlaced header is refused (contract)                                     | refuses 16-bit, sub-byte and interlaced images (C)                                     | KILLED |
| Q-20 | A width over 2048 is refused (contract)                                        | refuses a side under the minimum or over the maximum (C)                               | KILLED |
| Q-21 | The quiet zone is whole (contract `.int()` removed; rewritten by FIX-06)       | accepts a quiet zone of 0..16 whole modules and refuses -1, 17 and 1.5 (C)             | KILLED |
| Q-22 | The region's right edge is inside the background (contract)                    | refuses a template with no background, or one whose region is outside it (I)           | KILLED |
| Q-23 | The delivery card goes through the port (plain encoder called)                 | the delivery card — a purchase and a trial alike — sends the templated QR (U)          | KILLED |
| Q-24 | A changed link goes through the port (plain encoder called)                    | a changed link (sendRotated) sends the templated QR (U)                                | KILLED |
| Q-25 | The link view's QR goes through the port (plain encoder called)                | the link photo of «🔗 لینک اشتراک» sends the templated QR (U)                          | KILLED |
| Q-26 | The code is of the EXACT link (a character appended)                           | the delivery card — a purchase and a trial alike — sends the templated QR (U)          | KILLED |
| Q-27 | The QR background slot is PNG only (per-slot type check removed)               | refuses a JPEG, a damaged PNG, a decompression bomb and an oversized image … (I)       | KILLED |
| Q-28 | The slot's content check refuses (refusal ignored)                             | refuses a JPEG, a damaged PNG, a decompression bomb and an oversized image … (I)       | KILLED |
| Q-29 | The content check applies to QR_BACKGROUND (aimed at the banner)               | refuses what cannot be drawn on, with the reason (U)                                   | KILLED |
| Q-30 | A template needs a stored background (check removed)                           | refuses a template with no background, or one whose region is outside it (I)           | KILLED |
| Q-31 | A template's region lies inside the background (check removed)                 | refuses a template with no background, or one whose region is outside it (I)           | KILLED |
| Q-32 | The guard reads the QR_BACKGROUND slot (reads the banner)                      | refuses a template with no background, or one whose region is outside it (I)           | KILLED |
| Q-33 | The guard is registered with the settings service (removed)                    | refuses a template with no background, or one whose region is outside it (I)           | KILLED |
| Q-34 | The delivery lane uses the configured renderer (a bare one)                    | is wired into the delivery lane: the service sends through this same renderer (I)      | KILLED |
| Q-35 | The renderer reads the QR_BACKGROUND slot (reads the banner)                   | stores a background, places the code on it, and the QR decodes to exactly the link (I) | KILLED |
| Q-36 | The media service is given the decoding content check (a no-op)                | refuses a JPEG, a damaged PNG, a decompression bomb and an oversized image … (I)       | KILLED |
| Q-37 | The form refuses a region outside the background before saving                 | validates the region against the background before saving, then saves it once (W)      | KILLED |
| Q-38 | The form refuses a bad file from its header before uploading                   | refuses a JPEG, an interlaced PNG and an oversized side before uploading anything (W)  | KILLED |
| Q-39 | «بازگشت به پیش‌فرض» removes the background too                                 | reverts to the default: the template cleared, then the background removed (W)          | KILLED |
| Q-40 | The composite cap is 1.5 MiB (made 10 MiB)                                     | refuses a composite over 1.5 MiB, and keeps a photo-like one under it (U)              | KILLED |
| Q-41 | The module minimum is measured after Telegram's downscale (raw scale used)     | measures the module after Telegram’s downscale: 4 px on 2048 px falls back (U)         | KILLED |
| Q-42 | `qrEffectiveModulePx` scales by 1280 / longest side (contract, scale returned) | measures a module as the customer receives it, not as it was uploaded (C)              | KILLED |
| Q-43 | The save guard consults the typical-link probe (removed)                       | refuses at save a region whose modules Telegram would shrink under 4 px (I)            | KILLED |
| Q-44 | The decoded background is cached by digest (cache bypassed)                    | reads and decodes a background once, and composes a given link once (U)                | KILLED |
| Q-45 | The composed image is cached (cache bypassed)                                  | reads and decodes a background once, and composes a given link once (U)                | KILLED |
| Q-46 | A second IHDR is refused (check removed)                                       | refuses a second IHDR (U)                                                              | KILLED |
| Q-47 | A chunk longer than the file is refused (check removed)                        | refuses a chunk whose length runs past the end of the file (U)                         | KILLED |
| Q-48 | A palette index past the end is refused (check removed)                        | refuses a pixel that names a palette entry past the end (U)                            | KILLED |
| Q-49 | A palette tRNS is applied (ignored)                                            | applies a palette tRNS: a half-transparent entry over white, an absent one opaque (U)  | KILLED |
| Q-50 | The preview is charged settings.view (check removed)                           | the preview is charged settings.view before anything is rendered (U)                   | KILLED |
| Q-51 | A failed setting read is CONFIG_UNREADABLE (made BACKGROUND_UNREADABLE)        | falls back when reading the configuration throws, and never fails the delivery (U)     | KILLED |
| Q-52 | The form refuses a region too small after the downscale (check removed)        | refuses a region whose modules Telegram would shrink under 4 px, before saving (W)     | KILLED |
| Q-53 | The preview states the background's size with no template (not read)           | previews a draft without storing it, under settings.view (I)                           | KILLED |
| Q-54 | The renderer finds the background by its stored digest (always null)           | stores a background, places the code on it, and the QR decodes to exactly the link (I) | KILLED |

53 of 53 killed (the second round, after the review of PR #218, on `nexa_test_p2c2`).

## FIX-06 (2026-10-09): a quiet zone of 0..16 whole modules

FIX-06 widened the quiet zone from 4–16 to 0–16 (`docs/phase2/item4-qr-template.md`). Q-21's
rule — a minimum of 4 — is gone, and mutating the minimum to 0 is now the code itself; Q-21 is
rewritten above as "the quiet zone is whole". The review of PR #250 (CX2) found Q-02, Q-07 and
Q-25 anchored to code that had moved (Q-25 already on main, since B9/C3 moved the link view's
QR into `qrPhoto`); their anchors follow the code now. The FIX-06 mutants are F06-01 to F06-18.
F06-15 to F06-18 are SQL mutants: the driver replaces migration 0239's live CHECK in the TEST
database, runs the named test, and restores the CHECK from the 0239 file.

Encoder: `tests/unit/qr-png.test.ts` (P).

| ID     | Rule reverted                                                     | Test that failed                                                                     | Result |
| ------ | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------ |
| F06-01 | The quiet zone minimum is 0 (contract, made 4)                    | accepts a quiet zone of 0..16 whole modules and refuses -1, 17 and 1.5 (C)           | KILLED |
| F06-02 | The quiet zone maximum is 16 (contract `.max` removed)            | refuses a quiet zone outside 0..16 or not whole, and a fractional size (I)           | KILLED |
| F06-03 | A new template starts at 4 (contract DEFAULT made 0)              | shows a stored 0 as 0, and «وسط تصویر» proposes the recommended 4 (W)                | KILLED |
| F06-04 | The encoder reads the margin with `??` (made `\|\|`)              | draws margin 0 with no white border: the first pixel row and column are the code (P) | KILLED |
| F06-05 | The encoder's margin is at most 16 (bound removed)                | draws margin 16, and refuses 17, -1 and 1.5 (P)                                      | KILLED |
| F06-06 | At 0 only the code's square is white (whole region painted)       | at 0, a region larger than the code leaves its remainder as background (U)           | KILLED |
| F06-07 | Above 0 the whole region is white (threshold made `> 4`)          | draws every value an operator could store before byte for byte as it did (U)         | KILLED |
| F06-08 | The scale divides by the quiet zone as stored (`\|\| 4` added)    | at 0, the code fills a region of exactly its size (U)                                | KILLED |
| F06-09 | At 0 the white is exactly the code (a 1 px ring added)            | at 0, the code fills a region of exactly its size (U)                                | KILLED |
| F06-10 | The plain QR's margin is 4 (made 0)                               | with nothing configured, is byte for byte the plain QR every tenant received (U)     | KILLED |
| F06-11 | «وسط تصویر» proposes DEFAULT (made MIN)                           | shows a stored 0 as 0, and «وسط تصویر» proposes the recommended 4 (W)                | KILLED |
| F06-12 | The low-margin warning compares a number (truthiness guard added) | accepts a white margin of 0: warns, previews and saves 0 (W)                         | KILLED |
| F06-13 | The form parses 0 as 0 (`\|\| DEFAULT` added)                     | accepts a white margin of 0: warns, previews and saves 0 (W)                         | KILLED |
| F06-14 | The form shows a stored 0 as 0 (`\|\| DEFAULT` added)             | shows a stored 0 as 0, and «وسط تصویر» proposes the recommended 4 (W)                | KILLED |
| F06-15 | 0239 CHECK: at most 16 (made 17)                                  | migration 0239: the database refuses a stored quiet zone outside 0..16 (I)           | KILLED |
| F06-16 | 0239 CHECK: at least 0 (made -1)                                  | migration 0239: the database refuses a stored quiet zone outside 0..16 (I)           | KILLED |
| F06-17 | 0239 CHECK: 0 is allowed (minimum made 1)                         | migration 0239: the database refuses a stored quiet zone outside 0..16 (I)           | KILLED |
| F06-18 | 0239 CHECK: whole numbers only (`trunc` test removed)             | migration 0239: the database refuses a stored quiet zone outside 0..16 (I)           | KILLED |

Run of the committed driver (537dfb20) over every mutant, Q-01 to Q-54 and F06-01 to F06-18, on
2026-10-09 against `nexa_test_qr` — `python3 scripts/mutate-p2-item4.py`, its output verbatim:

```text
Q-01 KILLED ['Tests  1 failed | 45 skipped (46)', '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯'] ['× never rounds the module up into the quiet zone: the scale is the floor 173ms']
Q-02 KILLED ['Tests  1 failed | 45 skipped (46)', '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯'] ['× draws every module as an exact scale × scale block, centred, with the quiet zone white 150ms', 'FAIL  |unit| tests/unit/delivery-qr-template.test.ts > composing the QR on a background > draws every module as an exact scale × scale block, centred, with the quiet zone white']
Q-03 KILLED ['Tests  1 failed | 45 skipped (46)', '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯'] ['× draws every module as an exact scale × scale block, centred, with the quiet zone white 178ms', 'FAIL  |unit| tests/unit/delivery-qr-template.test.ts > composing the QR on a background > draws every module as an exact scale × scale block, centred, with the quiet zone white']
Q-04 KILLED ['Tests  1 failed | 45 skipped (46)', '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯'] ['× refuses a region too small for this link at the minimum module size 148ms']
Q-05 KILLED ['Tests  1 failed | 45 skipped (46)', '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯'] ['× refuses a region that does not lie inside the background 96ms']
Q-06 KILLED ['Tests  1 failed | 45 skipped (46)', '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯'] ['× draws every module as an exact scale × scale block, centred, with the quiet zone white 219ms', 'FAIL  |unit| tests/unit/delivery-qr-template.test.ts > composing the QR on a background > draws every module as an exact scale × scale block, centred, with the quiet zone white']
Q-07 KILLED ['Tests  1 failed | 45 skipped (46)', '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯'] ['× with nothing configured, is byte for byte the plain QR every tenant received before 117ms']
Q-08 KILLED ['Tests  1 failed | 45 skipped (46)', '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯'] ['× passes a provider-originated image through untouched: never decoded, never re-encoded 33ms']
Q-09 KILLED ['Tests  1 failed | 45 skipped (46)', '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯'] ['× falls back to the plain QR, and reports why, for every template it cannot use 139ms']
Q-10 KILLED ['Tests  1 failed | 45 skipped (46)', '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯'] ['× falls back when reading the configuration throws, and never fails the delivery 25ms']
Q-12 KILLED ['Tests  1 failed | 45 skipped (46)', '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯'] ['× previews a draft template without storing it, and reports the plain fallback 63ms']
Q-13 KILLED ['Tests  1 failed | 45 skipped (46)', '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯'] ['× refuses a decompression bomb by the header-declared size, before using a byte of it 120ms']
Q-14 KILLED ['Tests  1 failed | 45 skipped (46)', '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯'] ['× checks every chunk’s CRC, an ancillary chunk the image does not need included 42ms']
Q-15 KILLED ['Tests  1 failed | 45 skipped (46)', '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯'] ['× reads greyscale, palette, grey+alpha and RGBA, alpha flattened onto white 79ms']
Q-16 KILLED ['Tests  1 failed | 45 skipped (46)', '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯'] ['× refuses 16-bit, sub-byte and interlaced images, and an unknown critical chunk 32ms']
Q-17 KILLED ['Tests  1 failed | 45 skipped (46)', '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯'] ['× refuses damage as CORRUPT: a bad checksum, a short stream, a bad filter, no IEND 26ms']
Q-18 KILLED ['Tests  1 failed | 45 skipped (46)', '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯'] ['× reads RGB in all five scanline filters exactly 28ms']
Q-19 KILLED ['Tests  1 failed | 11 skipped (12)', '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯'] ['× refuses 16-bit, sub-byte and interlaced images 15ms']
Q-20 KILLED ['Tests  1 failed | 11 skipped (12)', '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯'] ['× refuses a side under the minimum or over the maximum 13ms']
Q-21 KILLED ['Tests  1 failed | 11 skipped (12)', '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯'] ['× accepts a quiet zone of 0..16 whole modules and refuses -1, 17 and 1.5 14ms']
Q-22 KILLED ['Tests  1 failed | 18 skipped (19)', '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯'] ['× refuses a template with no background, or one whose region is outside it 5280ms', "231|       message: expect.stringContaining('500×500'),"]
Q-23 KILLED ['Tests  1 failed | 45 skipped (46)', '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯'] ['× the delivery card — a purchase and a trial alike — sends the templated QR 123ms']
Q-24 KILLED ['Tests  1 failed | 45 skipped (46)', '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯'] ['× a changed link (sendRotated) sends the templated QR 119ms']
Q-25 KILLED ['Tests  1 failed | 45 skipped (46)', '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯'] ['× the link photo of «🔗 لینک اشتراک» sends the templated QR 182ms']
Q-26 KILLED ['Tests  1 failed | 45 skipped (46)', '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯'] ['× the delivery card — a purchase and a trial alike — sends the templated QR 605ms']
Q-27 KILLED ['Tests  1 failed | 18 skipped (19)', '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯'] ['× refuses a JPEG, a damaged PNG, a decompression bomb and an oversized image, storing nothing 2876ms']
Q-28 KILLED ['Tests  1 failed | 18 skipped (19)', '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯'] ['× refuses a JPEG, a damaged PNG, a decompression bomb and an oversized image, storing nothing 4796ms']
Q-29 KILLED ['Tests  1 failed | 45 skipped (46)', '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯'] ['× refuses what cannot be drawn on, with the reason 28ms']
Q-30 KILLED ['Tests  1 failed | 18 skipped (19)', '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯'] ['× refuses a template with no background, or one whose region is outside it 5109ms']
Q-31 KILLED ['Tests  1 failed | 18 skipped (19)', '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯'] ['× refuses a template with no background, or one whose region is outside it 5608ms', '-   "message": StringContaining "500×500",']
Q-32 KILLED ['Tests  1 failed | 18 skipped (19)', '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯'] ['× refuses a template with no background, or one whose region is outside it 5246ms', '-   "message": StringContaining "500×500",']
Q-33 KILLED ['Tests  1 failed | 18 skipped (19)', '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯'] ['× refuses a template with no background, or one whose region is outside it 4797ms']
Q-34 KILLED ['Tests  1 failed | 18 skipped (19)', '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯'] ['× is wired into the delivery lane: the service sends through this same renderer 3716ms']
Q-35 KILLED ['Tests  1 failed | 18 skipped (19)', '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯'] ['× stores a background, places the code on it, and the QR decodes to exactly the link 5083ms']
Q-36 KILLED ['Tests  1 failed | 18 skipped (19)', '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯'] ['× refuses a JPEG, a damaged PNG, a decompression bomb and an oversized image, storing nothing 5493ms']
Q-37 KILLED ['Tests  1 failed | 11 skipped (12)', '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯'] ['× validates the region against the background before saving, then saves it once 1145ms', '\x1b[0m800 × 700\x1b[0m']
Q-38 KILLED ['Tests  1 failed | 11 skipped (12)', '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯'] ['× refuses a JPEG, an interlaced PNG and an oversized side before uploading anything 1189ms', '\x1b[0mundefined × undefined\x1b[0m']
Q-39 KILLED ['Tests  1 failed | 11 skipped (12)', '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯'] ['× reverts to the default: the template cleared, then the background removed 1508ms', '\x1b[0m800 × 700\x1b[0m']
Q-40 KILLED ['Tests  1 failed | 45 skipped (46)', '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯'] ['× refuses a composite over 1.5 MiB, and keeps a photo-like one under it 26ms']
Q-41 KILLED ['Tests  1 failed | 45 skipped (46)', '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯'] ['× measures the module after Telegram’s downscale: 4 px on 2048 px falls back 357ms']
Q-42 KILLED ['Tests  1 failed | 11 skipped (12)', '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯'] ['× measures a module as the customer receives it, not as it was uploaded 8ms']
Q-43 KILLED ['Tests  2 failed | 17 skipped (19)', '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯'] ['× refuses at save a region whose modules Telegram would shrink under 4 px 2187ms', '× refuses at save a background that composes too large to send in time 1738ms']
Q-44 KILLED ['Tests  1 failed | 45 skipped (46)', '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯'] ['× reads and decodes a background once, and composes a given link once 147ms']
Q-45 KILLED ['Tests  1 failed | 45 skipped (46)', '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯'] ['× reads and decodes a background once, and composes a given link once 436ms']
Q-46 KILLED ['Tests  1 failed | 45 skipped (46)', '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯'] ['× refuses a second IHDR 21ms']
Q-47 KILLED ['Tests  1 failed | 45 skipped (46)', '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯'] ['× refuses a chunk whose length runs past the end of the file 22ms']
Q-48 KILLED ['Tests  1 failed | 45 skipped (46)', '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯'] ['× refuses a pixel that names a palette entry past the end 40ms']
Q-49 KILLED ['Tests  1 failed | 45 skipped (46)', '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯'] ['× applies a palette tRNS: a half-transparent entry over white, an absent one opaque 45ms']
Q-50 KILLED ['Tests  1 failed | 45 skipped (46)', '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯'] ['× the preview is charged settings.view before anything is rendered 19ms']
Q-51 KILLED ['Tests  1 failed | 45 skipped (46)', '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯'] ['× falls back when reading the configuration throws, and never fails the delivery 133ms']
Q-52 KILLED ['Tests  1 failed | 11 skipped (12)', '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯'] ['× refuses a region whose modules Telegram would shrink under 4 px, before saving 1128ms', '\x1b[0m2048 × 2048\x1b[0m']
Q-53 KILLED ['Tests  1 failed | 18 skipped (19)', '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯'] ['× previews a draft without storing it, under settings.view 7061ms']
Q-54 KILLED ['Tests  1 failed | 18 skipped (19)', '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯'] ['× stores a background, places the code on it, and the QR decodes to exactly the link 4149ms']
F06-01 KILLED ['Tests  1 failed | 11 skipped (12)', '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯'] ['× accepts a quiet zone of 0..16 whole modules and refuses -1, 17 and 1.5 15ms']
F06-02 KILLED ['Tests  1 failed | 18 skipped (19)', '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯'] ['× refuses a quiet zone outside 0..16 or not whole, and a fractional size, at the schema 4265ms']
F06-03 KILLED ['Tests  1 failed | 11 skipped (12)', '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯'] ['× shows a stored 0 as 0, and «وسط تصویر» proposes the recommended 4 104ms']
F06-04 KILLED ['Tests  1 failed | 9 skipped (10)', '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯'] ['× draws margin 0 with no white border: the first pixel row and column are the code 59ms']
F06-05 KILLED ['Tests  1 failed | 9 skipped (10)', '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯'] ['× draws margin 16, and refuses 17, -1 and 1.5 186ms']
F06-06 KILLED ['Tests  1 failed | 45 skipped (46)', '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯'] ['× at 0, a region larger than the code leaves its remainder as background, not white 173ms']
F06-07 KILLED ['Tests  1 failed | 45 skipped (46)', '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯'] ['× draws every value an operator could store before byte for byte as it did 134ms']
F06-08 KILLED ['Tests  1 failed | 45 skipped (46)', '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯'] ['× at 0, the code fills a region of exactly its size: the first row and column are the code 196ms']
F06-09 KILLED ['Tests  1 failed | 45 skipped (46)', '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯'] ['× at 0, the code fills a region of exactly its size: the first row and column are the code 217ms']
F06-10 KILLED ['Tests  1 failed | 45 skipped (46)', '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯'] ['× with nothing configured, is byte for byte the plain QR every tenant received before 72ms']
F06-11 KILLED ['Tests  1 failed | 11 skipped (12)', '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯'] ['× shows a stored 0 as 0, and «وسط تصویر» proposes the recommended 4 418ms']
F06-12 KILLED ['Tests  1 failed | 11 skipped (12)', '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯'] ['× accepts a white margin of 0: warns, previews and saves 0, never the default 172ms', '\x1b[0m800 × 700\x1b[0m']
F06-13 KILLED ['Tests  1 failed | 11 skipped (12)', '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯'] ['× accepts a white margin of 0: warns, previews and saves 0, never the default 152ms', '\x1b[0m800 × 700\x1b[0m']
F06-14 KILLED ['Tests  1 failed | 11 skipped (12)', '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯'] ['× shows a stored 0 as 0, and «وسط تصویر» proposes the recommended 4 1111ms', '\x1b[0m800 × 700\x1b[0m']
F06-15 KILLED ['Tests  1 failed | 18 skipped (19)', '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯'] ['× migration 0239: the database refuses a stored quiet zone outside 0..16 or not whole 4878ms']
F06-16 KILLED ['Tests  1 failed | 18 skipped (19)', '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯'] ['× migration 0239: the database refuses a stored quiet zone outside 0..16 or not whole 4647ms']
F06-17 KILLED ['Tests  1 failed | 18 skipped (19)', '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯'] ['× migration 0239: the database refuses a stored quiet zone outside 0..16 or not whole 5248ms']
F06-18 KILLED ['Tests  1 failed | 18 skipped (19)', '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯'] ['× migration 0239: the database refuses a stored quiet zone outside 0..16 or not whole 5009ms']
71 of 71 killed
```

## History

Second round (review of PR #218: caches, a 1.5 MiB cap, the downscale rule, the decoder's
bounds, the preview's permission). Fifteen mutants added (Q-40 to Q-54). The first run killed
50 of 51 and could not apply Q-33 and Q-37 (their anchors had moved with the fix):

- **Q-31 survived.** With the save guard now composing a typical link, a region outside the
  background is refused by the probe even when the placement check is removed. The refusal
  differed only in its words. The integration case now asserts that the refusal names the
  background's size (`500×500`), which only the placement check states.

First round:

The first run killed 35 of 37 and could not apply Q-14 (an anchor prettier had reformatted):

- **Q-01 survived.** For the test link (37 modules) in a 420 px region the exact scale is 9.33,
  where rounding and the floor agree. Added _never rounds the module up into the quiet zone_,
  a 440 px region (9.78: the floor is 9, rounding 10, which would eat the quiet zone).
- **Q-22 survived.** The integration case moved the region past BOTH the right and the bottom
  edge, so dropping the right-edge test still refused it. Split into one case per edge.
- **Q-11** (the renderer refuses unencodable text before reading configuration) was dropped as
  an equivalent mutant: every path still reaches `qrModules`, which refuses the same text.
