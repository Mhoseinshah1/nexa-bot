# Package C — GB input and display normalization: audit and design

The post-WP20 brief's Package C: a traffic amount is typed and shown in **GB**, with at most
**two decimal places** (`10`, `10.5`, `10.25`). This package absorbs WP21, whose input half
it carries unchanged (`docs/wp21-gb-traffic-inputs-audit.md`), and adds the display half.

## 1. What WP21 already did (C1, C2, C4, C5)

- **C1, the representation.** Traffic stays integer bytes (`bigint`) in every column, domain
  type and provider call. There is no migration.
  - One GB is the binary gigabyte the codebase always showed, 1 GiB = 1,073,741,824 bytes (`BYTES_PER_GB`).
  - A typed figure is split into whole units and hundredths and multiplied as `bigint`, never through a float.
  - The result is rounded to the nearest byte, half up (`parseTrafficGb`).
- **C2, the inputs.** Every human-editable traffic amount is typed in GB. The inventory is in
  WP21 §2:
  - the product form;
  - the product and add-on HTTP writes.

  A customer buys extra volume by choosing an add-on ROW, never by typing, so that row's figure
  is a display (§2 below). The future custom-service input (Package D) will use `parseTrafficGb`
  too.

- **C4, validation.** `TRAFFIC_GB_PATTERN` refuses:
  - a sign;
  - an exponent;
  - a stray point;
  - a comma;
  - inner whitespace;
  - a redundant leading zero;
  - non-ASCII digits;
  - a third decimal.

  A purchase requires a positive figure, and `MAX_TRAFFIC_BYTES` stays the ceiling. The Web
  form and the server share one pattern. No Telegram surface takes a typed traffic figure.

- **C5, compatibility.** Stored rows are valid as stored. An untouched historical figure is
  kept byte-exact through an edit (`trafficBytesAfterEdit`), and round trips are tested at the
  boundaries.

## 2. What this package adds: the display (C3)

Before this package, every traffic display used `splitByteCount`:

- the largest binary unit reached (MiB, GiB, TiB, PiB, or plain bytes below 1 MiB);
- one TRUNCATED decimal.

So a 10.25 GB plan read «10.2 گیگابایت», 1 TiB read «1 ترابایت», and a small usage read in
plain bytes: a raw byte count shown to a customer.

Now **every traffic amount a person is shown** is:

- **GB, always.** A terabyte plan reads «1,024 گیگابایت», not a switched unit.
- **At most two decimals, the nearest hundredth** (`formatTrafficGb`, the inverse of the input
  parser). A figure an operator typed reads back exactly as typed: `10.25` as `10.25`.
- **No noisy zeros.** `10`, not `10.00`; `10.5`, not `10.50`.
- **Grouped in thousands** in the whole part (`groupTrafficFigure`), `bigint` throughout: exact
  past 2^53.
- **Zero** is «0 گیگابایت»; a figure under half a hundredth also reads 0. An ALLOWANCE of zero is
  still «نامحدود» (unlimited), exactly as before.

**One rule, two surfaces.**

- **The bot.** It renders through `formatBytes` / `formatTrafficLimit` in `@nexa/i18n`, which the
  template renderer uses for every `BYTES` and `TRAFFIC_LIMIT` placeholder. That covers every
  traffic placeholder in the catalogue: pre-invoice, service card, delivery, usage reminders, the
  admin service view, the receipt caption and the refund-request card.
- **The Web Admin.** It renders through `formatTrafficGbText`, which is the same
  `groupTrafficFigure(formatTrafficGb(…))`, in:
  - the product list, form and detail;
  - the order detail;
  - the service detail (limit and used);
  - the business report tile and per-panel column.

  A unit test asserts the two surfaces produce the same figure.

**Decisions:**

- **Usage is shown in GB too.** The brief says traffic is displayed in GB. A used figure under
  0.005 GB therefore reads «0 گیگابایت» rather than a count in bytes, which C3 forbids for a
  customer.
- **File sizes keep their unit.** `splitBytes` stays for the two non-traffic byte counts: a
  receipt's file size and a referral banner's size. They are not volumes.
- **The report export keeps raw bytes.** The INFRASTRUCTURE sheet's `trafficSoldBytes` column is
  a machine-readable figure in an operator's export, and its header says «(بایت)». It is not
  shown to a customer, and a spreadsheet should sum exact integers.
- **The word is the existing «گیگابایت».** The catalogue already uses it, and switching to a
  Latin "GB" inside Persian sentences would be a copy change the brief does not ask for.

## 3. Rollback

This is presentation only: there is no migration and no stored value changes. The previous
release renders the same bytes in its old units.

## 4. Tests

- `tests/unit/traffic-format.test.ts` covers:
  - GB with no noisy decimals;
  - large values in GB;
  - nearest-hundredth rounding;
  - zero;
  - exactness past 2^53;
  - the round trip at the boundaries;
  - unlimited;
  - the two surfaces agreeing.
- The service card, receipt caption and template renderer suites were updated to the GB figure.
- `tests/web/products-and-orders.test.tsx` shows 10.25 and 1,024 GB in the product list.
- WP21's suites cover the input half.

Falsification: `docs/package-c-falsification.md`, alongside WP21's `docs/wp21-falsification.md`.
