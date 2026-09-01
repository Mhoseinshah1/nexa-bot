# ADR-0005 — Money representation, and when a rate snapshot is required

**Status:** Accepted.

## Decision

`Money` is `{ amountMinor: bigint; currency: CurrencyCode }`. Database columns
are `bigint` minor units plus a `currency` column. Never a float, never a bare
number, never an amount without a currency. Arithmetic across currencies throws
rather than coercing.

A **native-currency amount carries no rate snapshot**. A rate snapshot is
mandatory **only** for an amount derived through FX or crypto conversion —
above all a payment or gateway quote. Such an amount is
`ConvertedMoney { quoted, source, rateSnapshotId }`, and the snapshot it points
at is immutable and retained for the life of the record.

## Why the narrow snapshot rule

An earlier draft required a snapshot on every stored price. That is wrong: most
prices are quoted natively and never went through a conversion, so a snapshot
reference on them would be a null column pretending to be a fact. The property
that actually matters is that **a converted quote can always show the rate it
was quoted at** — which is a statement about conversion, not about price.

## Why it is worth this much care

The legacy system has no currency selector on any of its eleven gateways, no
exchange-rate field anywhere — including the FX-to-Rial and offline-crypto
gateways — and no conversion rate for Telegram Stars, which it nonetheless
reports as its own financial line. Toman is implicit everywhere. One
card-to-card template says تومان where its twin says ریال for the same `{price}`
token, because the unit was typed into the copy rather than derived from a type.

## Implementation notes

- `node-postgres` returns `int8` and `numeric` as strings. `int8` is parsed to
  `bigint` deliberately in `pg-type-parsers.ts`; `numeric` stays a string,
  because any JS numeric type would narrow it. An integration test round-trips
  `9007199254740993` to prove it.
- Money travels the wire as a decimal **string**: JSON has no bigint.
- `formatMoney` in `@nexa/i18n` is the single renderer, so a currency unit
  cannot be hand-typed into a template.
- `check-boundaries.sh` rejects a monetary field typed as `number`.
