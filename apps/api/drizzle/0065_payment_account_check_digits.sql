-- Check digits, enforced by the TABLE and not only by the schema above it.
--
-- `payment_accounts_card_number_check` and `payment_accounts_iban_check` are shape-only
-- regular expressions, and their own comment says why they exist: "a repair script run
-- at 3am only meets the second". A sixteen-digit string with a wrong Luhn digit and an
-- `IR` string with a wrong mod-97 checksum both satisfy them, so that script could poison
-- the default account — and every payment destination frozen from it afterwards — with a
-- number no bank will accept. The customer is then told to transfer money to nowhere.
--
-- `normalizeCardNumber`/`isValidCardNumber` and `normalizeIban`/`isValidIban` in
-- `packages/contracts/src/payment-accounts.ts` are the same two rules at the HTTP
-- boundary. These are them at the table, which is the only layer a hand-written UPDATE
-- cannot skip. Found by the Codex review of PR #34.
--
-- Written by hand because drizzle-kit models neither functions nor CHECKs that call one,
-- so this file adds only things the schema file does not describe and the drift check is
-- unaffected.

-- Luhn, over a string of digits of any length.
--
-- Doubles every second digit counted FROM THE RIGHT, starting with the second-from-right:
-- `length - i` odd is exactly that, and getting it backwards is the classic way to write a
-- Luhn check that accepts the numbers it should refuse, which is why 0065's test asserts
-- both a valid number and its transposition.
--
-- IMMUTABLE because a CHECK constraint requires it, and true here: same digits, same
-- answer, for ever. STRICT so a NULL argument answers NULL rather than running.
CREATE OR REPLACE FUNCTION nexa_luhn_ok(digits text) RETURNS boolean
  LANGUAGE sql IMMUTABLE STRICT
  AS $$
    SELECT digits ~ '^[0-9]+$'
       AND (
         SELECT sum(
                  CASE
                    WHEN (length(digits) - i) % 2 = 1
                      THEN CASE WHEN substr(digits, i, 1)::int * 2 > 9
                                THEN substr(digits, i, 1)::int * 2 - 9
                                ELSE substr(digits, i, 1)::int * 2
                           END
                    ELSE substr(digits, i, 1)::int
                  END
                )
         FROM generate_series(1, length(digits)) AS i
       ) % 10 = 0;
  $$;
--> statement-breakpoint
-- ISO 13616 mod-97 for an Iranian IBAN.
--
-- The country code moves to the end and becomes digits — I is 18, R is 27, hence the
-- literal `1827` — the two check digits follow it, and the whole 28-digit number modulo 97
-- must be 1. Cast to `numeric` rather than accumulated digit by digit because 28 digits fit
-- a numeric exactly; `bigint` would overflow at 19 and is the other classic way to write
-- this wrong.
CREATE OR REPLACE FUNCTION nexa_iban_ir_ok(iban text) RETURNS boolean
  LANGUAGE sql IMMUTABLE STRICT
  AS $$
    SELECT iban ~ '^IR[0-9]{24}$'
       AND mod((substr(iban, 5) || '1827' || substr(iban, 3, 2))::numeric, 97) = 1;
  $$;
--> statement-breakpoint
ALTER TABLE "payment_accounts"
  ADD CONSTRAINT "payment_accounts_card_luhn_check" CHECK (nexa_luhn_ok(card_number));
--> statement-breakpoint
ALTER TABLE "payment_accounts"
  ADD CONSTRAINT "payment_accounts_iban_mod97_check" CHECK (iban IS NULL OR nexa_iban_ir_ok(iban));
--> statement-breakpoint
-- The snapshot too. It is copied from an account that passed, so in the ordinary course
-- this can never fire — which is the reason it is here rather than the reason to leave it
-- out: the snapshot is what the customer is SHOWN, it is append-only, and a row written
-- around the application is exactly the case these constraints exist for.
ALTER TABLE "payment_destinations"
  ADD CONSTRAINT "payment_destinations_card_luhn_check" CHECK (nexa_luhn_ok(card_number));
--> statement-breakpoint
ALTER TABLE "payment_destinations"
  ADD CONSTRAINT "payment_destinations_iban_mod97_check" CHECK (iban IS NULL OR nexa_iban_ir_ok(iban));
