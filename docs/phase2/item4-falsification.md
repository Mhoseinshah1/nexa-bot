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

| ID   | Rule reverted                                                           | Test that failed                                                                       | Result |
| ---- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------ |
| Q-01 | The module scale is the floor (made `Math.round`)                       | never rounds the module up into the quiet zone: the scale is the floor (U)             | KILLED |
| Q-02 | The region is painted white (fill removed)                              | draws every module as an exact scale × scale block, centred, … quiet zone white (U)    | KILLED |
| Q-03 | The code is centred in the region (left edge pinned)                    | draws every module as an exact scale × scale block, … (U)                              | KILLED |
| Q-04 | A module under 4 px falls back (minimum made 1)                         | refuses a region too small for this link at the minimum module size (U)                | KILLED |
| Q-05 | The region must lie inside the background (check removed)               | refuses a region that does not lie inside the background (U)                           | KILLED |
| Q-06 | Every module is a full scale × scale block (one pixel short)            | draws every module as an exact scale × scale block, … (U)                              | KILLED |
| Q-07 | The default is byte for byte the plain QR (scale 9)                     | with nothing configured, is byte for byte the plain QR … (U)                           | KILLED |
| Q-08 | A provider image passes through untouched (re-encoded)                  | passes a provider-originated image through untouched … (U)                             | KILLED |
| Q-09 | An undecodable background falls back (error rethrown)                   | falls back to the plain QR, and reports why, for every template it cannot use (U)      | KILLED |
| Q-10 | An unreadable configuration falls back (error rethrown)                 | falls back when reading the configuration throws, and never fails the delivery (U)     | KILLED |
| Q-12 | The preview renders the DRAFT, not the stored template                  | previews a draft template without storing it, and reports the plain fallback (U)       | KILLED |
| Q-13 | Inflate is held to the header-declared size (`maxOutputLength` removed) | refuses a decompression bomb by the header-declared size … (U)                         | KILLED |
| Q-14 | Every chunk's CRC is checked (check removed)                            | checks every chunk’s CRC, an ancillary chunk the image does not need included (U)      | KILLED |
| Q-15 | Alpha is flattened onto white (raw value used)                          | reads greyscale, palette, grey+alpha and RGBA, alpha flattened onto white (U)          | KILLED |
| Q-16 | An unknown critical chunk is refused (accepted)                         | refuses 16-bit, sub-byte and interlaced images, and an unknown critical chunk (U)      | KILLED |
| Q-17 | A file with no IEND is refused (check removed)                          | refuses damage as CORRUPT: a bad checksum, a short stream, a bad filter, no IEND (U)   | KILLED |
| Q-18 | The Paeth filter is decoded as Paeth (made Up)                          | reads RGB in all five scanline filters exactly (U)                                     | KILLED |
| Q-19 | An interlaced header is refused (contract)                              | refuses 16-bit, sub-byte and interlaced images (C)                                     | KILLED |
| Q-20 | A width over 2048 is refused (contract)                                 | refuses a side under the minimum or over the maximum (C)                               | KILLED |
| Q-21 | The quiet zone is at least 4 modules (contract schema min 0)            | refuses a quiet zone under four modules and a fractional size at the schema (I)        | KILLED |
| Q-22 | The region's right edge is inside the background (contract)             | refuses a template with no background, or one whose region is outside it (I)           | KILLED |
| Q-23 | The delivery card goes through the port (plain encoder called)          | the delivery card — a purchase and a trial alike — sends the templated QR (U)          | KILLED |
| Q-24 | A changed link goes through the port (plain encoder called)             | a changed link (sendRotated) sends the templated QR (U)                                | KILLED |
| Q-25 | The link view's QR goes through the port (plain encoder called)         | the QR under the link view sends the templated QR (U)                                  | KILLED |
| Q-26 | The code is of the EXACT link (a character appended)                    | the delivery card — a purchase and a trial alike — sends the templated QR (U)          | KILLED |
| Q-27 | The QR background slot is PNG only (per-slot type check removed)        | refuses a JPEG, a damaged PNG, a decompression bomb and an oversized image … (I)       | KILLED |
| Q-28 | The slot's content check refuses (refusal ignored)                      | refuses a JPEG, a damaged PNG, a decompression bomb and an oversized image … (I)       | KILLED |
| Q-29 | The content check applies to QR_BACKGROUND (aimed at the banner)        | refuses what cannot be drawn on, with the reason (U)                                   | KILLED |
| Q-30 | A template needs a stored background (check removed)                    | refuses a template with no background, or one whose region is outside it (I)           | KILLED |
| Q-31 | A template's region lies inside the background (check removed)          | refuses a template with no background, or one whose region is outside it (I)           | KILLED |
| Q-32 | The guard reads the QR_BACKGROUND slot (reads the banner)               | refuses a template with no background, or one whose region is outside it (I)           | KILLED |
| Q-33 | The guard is registered with the settings service (removed)             | refuses a template with no background, or one whose region is outside it (I)           | KILLED |
| Q-34 | The delivery lane uses the configured renderer (a bare one)             | is wired into the delivery lane: the service sends through this same renderer (I)      | KILLED |
| Q-35 | The renderer reads the QR_BACKGROUND slot (reads the banner)            | stores a background, places the code on it, and the QR decodes to exactly the link (I) | KILLED |
| Q-36 | The media service is given the decoding content check (a no-op)         | refuses a JPEG, a damaged PNG, a decompression bomb and an oversized image … (I)       | KILLED |
| Q-37 | The form refuses a region outside the background before saving          | validates the region against the background before saving, then saves it once (W)      | KILLED |
| Q-38 | The form refuses a bad file from its header before uploading            | refuses a JPEG, an interlaced PNG and an oversized side before uploading anything (W)  | KILLED |
| Q-39 | «بازگشت به پیش‌فرض» removes the background too                          | reverts to the default: the template cleared, then the background removed (W)          | KILLED |

38 of 38 killed.

## History

The first run killed 35 of 37 and could not apply Q-14 (an anchor prettier had reformatted):

- **Q-01 survived.** For the test link (37 modules) in a 420 px region the exact scale is 9.33,
  where rounding and the floor agree. Added _never rounds the module up into the quiet zone_,
  a 440 px region (9.78: the floor is 9, rounding 10, which would eat the quiet zone).
- **Q-22 survived.** The integration case moved the region past BOTH the right and the bottom
  edge, so dropping the right-edge test still refused it. Split into one case per edge.
- **Q-11** (the renderer refuses unencodable text before reading configuration) was dropped as
  an equivalent mutant: every path still reaches `qrModules`, which refuses the same text.
