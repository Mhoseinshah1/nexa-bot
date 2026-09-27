# WP21 — human traffic inputs in GB, with up to two decimals

The owner's brief §4. A person types a traffic amount in GB, with at most two decimal
places. The system stores and sends integer bytes, as it always has.

## 1. Decisions, and where each comes from

**Owner decisions (brief §4):**

- Human-editable traffic amounts are GB, not raw bytes.
- Up to two decimals are accepted: `1`, `1.5`, `1.50`, `10.25`, `0.01`.
- Refused: more than two decimals, a negative figure, scientific notation, malformed or
  ambiguous input, and raw byte-oriented human input.
- The canonical model is unchanged: integer bytes (`bigint`) in every column, domain type
  and provider call. No migration, no floating GB anywhere.
- 1 GB here is the existing 1 GiB, 1,073,741,824 bytes. A hundredth is rounded to the
  nearest byte, half up. Traffic is never parsed through a JavaScript float.
- Machine and provider fields that already use bytes stay in bytes, and stored values are
  not rewritten.
- "0 = unlimited" is kept only where a contract already defines it, and made explicit in
  the form. A quantity of zero is never reinterpreted as unlimited.
- A saved `10.25` reopens as `10.25`. Non-editable usage displays may keep their existing
  binary auto-unit formatting.
- Editable GB values cross HTTP as decimal strings. Locale text stays out of domain logic.

**Existing rules this keeps:**

- A product's traffic allowance is bytes, and `UNLIMITED_TRAFFIC_BYTES` (zero) means no
  limit on a product and on a service (`catalog.ts`, `provisioning.ts`, the `products` and
  `services` CHECKs).
- An add-on of traffic must be positive; zero is not "unlimited" there
  (`serviceAddonSpecificationSchema`, `service_addons` CHECK).
- `MAX_TRAFFIC_BYTES` caps both.

**Technical choices made here:**

- **One conversion, in contracts.** `packages/contracts/src/traffic-input.ts` holds
  `BYTES_PER_GB`, `TRAFFIC_GB_PATTERN`, `parseTrafficGb`, `formatTrafficGb` and
  `trafficBytesAfterEdit`. The HTTP schemas, the two controllers, the two services and the
  Web Admin form all use them.
- **A narrow pattern.** `^(0|[1-9][0-9]{0,8})(\.[0-9]{1,2})?$`, after trimming whitespace.
  It refuses a sign, an exponent, a leading or trailing point, a comma in either role,
  inner whitespace, a redundant leading zero, and digits outside ASCII. Each of those is a
  figure two readers could read two ways.
- **`bigint` arithmetic.** The text is split into its whole part and its hundredths, and
  `(hundredths × 1,073,741,824 + 50) / 100` is taken as `bigint`. 1 GiB ends in …24, so no
  hundredth lands exactly on a half: the half-up rule is stated, but never exercised.
- **Unlimited is `null` on the wire and a checkbox in the form.** A typed `0` is refused
  for a product ("choose unlimited explicitly"), exactly as it already was for an add-on.
  The stored value for unlimited is still zero bytes.
- **An untouched historical figure is kept.** A value stored before WP21 in raw bytes
  (1,000,000,000, say) reopens at its nearest hundredth (`0.93`). Saving the form unchanged
  would otherwise rewrite it to 0.93 GiB, 998,579,896 bytes, during an edit to the title.
  So an update whose figure equals the one the form showed keeps the stored bytes, and any
  other figure is stored as typed. Zero is never kept over a change to or from zero.
- **The field is replaced, not added beside.** `productWriteSchema.trafficBytes` and
  `serviceAddonWriteSchema.trafficBytes` become `trafficGb`. Keeping the byte field would
  keep the raw byte input the owner refused. The API and the Web Admin ship in one image;
  the one client is updated in the same commit. Responses still carry `trafficBytes`: a
  response is not human input, and every reader already formats it.

## 2. Inventory: every human-editable traffic amount

| Surface                                            | Before WP21           | After                              |
| -------------------------------------------------- | --------------------- | ---------------------------------- |
| Web Admin product create/edit                      | whole bytes; `0` = ∞  | GB ≤ 2 decimals; "unlimited" box   |
| HTTP `POST /products`, `/products/:id`             | `trafficBytes` string | `trafficGb` string, or null for ∞  |
| HTTP `POST /service-addons`, `/service-addons/:id` | `trafficBytes` string | `trafficGb` string; never zero     |
| Trial traffic                                      | none                  | none (a trial is a product: above) |
| Admin "set/add traffic" on a service               | none                  | none                               |
| Telegram admin captures                            | none take traffic     | none take traffic                  |
| Telegram customer captures                         | none take traffic     | none take traffic                  |
| Reseller, tier, panel, settings                    | no traffic field      | no traffic field                   |

Notes on the empty rows:

- The trial's traffic comes from the product `trial.product_id` names, so the product
  form is the trial's traffic input.
- A customer adds traffic by choosing an add-on row (`catalog.ts`, OQ-4F-05), never by
  typing an amount.
- The add-on write API has no Web or Telegram form yet. Its schema takes GB now, so the
  form it gets cannot take bytes.

**Telegram and Web share the rule.** No Telegram surface takes a typed traffic amount, so
the conversion has one caller on the Web (the form) and one on the server (the boundary),
and both are `parseTrafficGb`. Both surfaces display a byte count through the same
`splitByteCount`, as before.

## 3. What is not done, and why

- **Non-editable displays keep their binary auto-unit and one truncated decimal.** A
  product list row of 10.25 GB still reads «10.2 گیگابایت». The brief allows it, and
  changing every usage display is outside this package.
- **No stored value is migrated.** A historical byte count that is not a whole number of
  hundredths stays exactly as stored until an operator types a different figure.
- **No new traffic surface is added.** There is no admin "set traffic" action and no
  Telegram traffic capture, and none was invented for this package.

## 4. Tests

- **Unit:** `tests/unit/wp21-traffic-input.test.ts`, covering:
  - the conversion (1, 10.25, 1.5 and 1.50, 0.01 down and 0.03 up);
  - every hundredth from 0.00 to 99.99 against the exact rational answer;
  - the refusals;
  - zero;
  - the round trip;
  - the historical display;
  - the edit rule and its zero guard;
  - both write schemas.
- **Web:**
  - `tests/web/wp21-traffic-rule.test.ts`: the form accepts exactly what the schema
    accepts, and sends null for unlimited;
  - `tests/web/products-and-orders.test.tsx`: GB input with an unlimited box, a saved
    10.25 reopening as 10.25 and sent back as GB, a typed zero named rather than sent, and
    a third decimal refused before sending.
- **Integration:**
  - `tests/integration/products-http.test.ts`: exact bytes stored for 10.25 and 0.01;
    unlimited as zero and a typed zero refused; the malformed figures and raw bytes
    refused; the cap; an untouched historical figure kept and a changed one stored; an
    add-on's GB.
  - `tests/integration/wp21-traffic-to-provider.test.ts`: the panel is asked for exactly
    11,005,853,696 bytes for 10.25 GB, the nearest byte of 0.01 GB, and no limit for an
    unlimited product.

Falsification: `docs/wp21-falsification.md`.
