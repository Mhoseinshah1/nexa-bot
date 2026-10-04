# Legacy migration — manual acceptance (Item 13)

**Status: procedure written, NOT RUN.** It needs the real legacy dump, a NEXA copy with the
import applied (staging rehearsal, then production at cutover step 16), the Web Admin, the
Telegram bot and read access to RickPanel — none of which exist where this was written.
Running it against the synthetic fixture exercises the selectors only; it is never
acceptance.

Each sample is one legacy record followed through six places:

```
Legacy row  →  importer decision  →  NEXA database  →  Web Admin  →  Telegram  →  RickPanel (read)
```

## Safety rules for every sample

1. **One record at a time.** A sample is chosen by an aggregate selector (below), which
   returns ONE key into a shell variable. The variable is never echoed, pasted or logged.
2. **Deterministic, not hand-picked.** Selectors order by `md5(key || :'seed')` with a seed
   you write in the report, so a reviewer can re-select the same record and nobody chooses
   a convenient one.
3. **Read-only everywhere.** Legacy: the SELECT-only account inside `START TRANSACTION READ
ONLY`. NEXA: `BEGIN READ ONLY`. RickPanel: the panel UI's view page or the read-only
   inventory; never an edit form, never "reset", "renew", "revoke".
4. **Redacted record.** The report gets the sample's category, the six PASS/FAIL marks and
   NEXA row ids (uuids). Never a Telegram id, username, phone, link, config or balance tied to
   a person. A field value needed to show a mismatch is described ("expiry differs by one
   day"), not copied.
5. **Telegram only where the account is controlled.** The Telegram check is done only for
   samples whose Telegram account belongs to the owner or a consenting staff member. Seed such
   accounts in MirzaBot BEFORE the freeze where you can (one with a positive balance, one
   with a near-expiry service, one with a used trial, …). For any other sample mark the
   Telegram column `N/A — not a controlled account`. **Never message a customer to test.**

## Common setup

```bash
set -o nounset
export NEXA_TENANT=<tenant-slug>
export SEED=<a-word-recorded-in-the-report>
export IMPORT_START=<UTC-time-from-import-start.txt>
export DC="docker compose --env-file /etc/nexa/deploy.env -f /opt/nexa/deploy/compose.yml"
nexa() { sudo $DC exec -T postgres psql -U nexa -d nexa -X -q -At -v tenant="$NEXA_TENANT" -v seed="$SEED" -v since="$IMPORT_START" "$@"; }
legacy() { sudo docker exec -i -e MYSQL_PWD="$LEGACY_RO_PW" nexa-legacy-src mariadb -uoldbot_ro oldbot --batch --skip-column-names "$@"; }
```

`nexa` reads its SQL from standard input (`nexa <<<"…"`) because psql substitutes
`:'tenant'`-style variables only there, never in a `-c` string. The two variable names are
not `UID`/`INV` because bash's `UID` is read-only.

(On the staging rehearsal, point `nexa` at the rehearsal database with a local `psql`, and
`legacy` at a MariaDB started on the harness's data directory — run the harness with
`--keep-legacy-copy`, which keeps the directory, not the process; start `mariadbd
--datadir=<kept dir>` yourself and remove the directory when done.)

### The per-sample checks (the six columns)

Once a selector has put `LEGACY_USER` (a legacy `user.id`, which is the Telegram id) and/or `LEGACY_INVOICE`
(an `invoice.id_invoice`) into the shell, every sample uses the same reads.

**Legacy** (non-identifying columns only):

```bash
legacy -e "START TRANSACTION READ ONLY;
  SELECT Balance, limit_usertest, agent FROM user WHERE id = '$LEGACY_USER';
  SELECT Status, is_test, code_panel, code_product, is_custom, Volume, Service_time, time_unit
    FROM invoice WHERE id_invoice = '$LEGACY_INVOICE';
  ROLLBACK;"
```

**Decision** (the map rows — status and closed reason):

```bash
nexa <<<"SELECT m.legacy_table, m.status, m.reason_code, m.entity_type, m.entity_id
           FROM legacy_import_map m JOIN tenants t ON t.id = m.tenant_id
          WHERE t.slug = :'tenant' AND ((m.legacy_table = 'user' AND m.legacy_id = '$LEGACY_USER')
                                     OR (m.legacy_table = 'invoice' AND m.legacy_id = '$LEGACY_INVOICE'))"
```

**NEXA database** (the entities the decision names):

```bash
nexa <<<"SELECT c.id, c.created_at < :'since'::timestamptz AS existed_before_import
           FROM customers c JOIN tenants t ON t.id = c.tenant_id
          WHERE t.slug = :'tenant' AND c.telegram_user_id = '$LEGACY_USER'"
nexa <<<"SELECT w.direction, w.amount, w.reference = 'legacy:opening:' || '$LEGACY_USER' AS ref_ok, w.order_id IS NULL AND w.payment_id IS NULL AS no_money
           FROM wallet_entries w JOIN customers c ON c.id = w.customer_id AND c.tenant_id = w.tenant_id
           JOIN tenants t ON t.id = w.tenant_id
          WHERE t.slug = :'tenant' AND c.telegram_user_id = '$LEGACY_USER' AND w.reason = 'MIGRATION_OPENING_BALANCE'"
nexa <<<"SELECT s.id, s.state, s.panel_id, o.origin, o.purpose, o.total_amount, p.audience,
                l.is_custom, l.tariff_status, s.expires_at, s.traffic_used_bytes, s.traffic_limit_bytes,
                (SELECT count(*) FROM provisioning_operations po WHERE po.service_id = s.id) AS provider_ops,
                (SELECT string_agg(r.kind, ',' ORDER BY r.kind) FROM service_reminders r WHERE r.service_id = s.id) AS seeded_reminders
           FROM legacy_import_map m JOIN tenants t ON t.id = m.tenant_id
           JOIN services s ON s.tenant_id = m.tenant_id AND s.id = m.entity_id
           JOIN orders o ON o.tenant_id = s.tenant_id AND o.id = s.order_id
           LEFT JOIN products p ON p.tenant_id = s.tenant_id AND p.id = s.product_id
           LEFT JOIN legacy_product_shapes l ON l.tenant_id = p.tenant_id AND l.product_id = p.id
          WHERE t.slug = :'tenant' AND m.legacy_table = 'invoice' AND m.legacy_id = '$LEGACY_INVOICE' AND m.entity_type = 'SERVICE'"
nexa <<<"SELECT e.decision, e.override_before, e.override_after
           FROM legacy_trial_eligibility e JOIN customers c ON c.id = e.customer_id AND c.tenant_id = e.tenant_id
           JOIN tenants t ON t.id = e.tenant_id
          WHERE t.slug = :'tenant' AND c.telegram_user_id = '$LEGACY_USER'"
```

Always true for an adopted service: `origin = LEGACY_ADOPTION`, `purpose = NEW_SERVICE`,
`total_amount = 0`, `provider_ops = 0`.

**Web Admin**: open the customer by the NEXA customer **uuid** (Customer 360). Check the
wallet shows the opening as «موجودی افتتاحیه (انتقال از ربات قبلی)», the service list shows
the adopted service with its panel and state, the order shows as a legacy adoption with a
zero total, the trial section shows the override (or none). The financial report does not
count the adoption as a sale.

**Telegram** (controlled accounts only): open the bot as that account. Wallet balance equals
the legacy balance (plus any pre-import NEXA balance); «سرویس‌های من» lists the service with
the panel's current expiry and usage; its link opens (do not copy it anywhere); the renewal
quote is the CURRENT NEXA tariff for that shape, never the legacy `price_product`; a trial
button is offered only if the trial decision allows it; an old MirzaBot button gets the
graceful stale answer (#174), not an error.

**RickPanel (read)**: find the account by `services.provider_username` (read it into a
variable, never print it) on the panel the service names, in the panel UI's view page.
Check it exists, its status matches the NEXA state, and expiry, limit and usage match what
NEXA synced (P1 usage sync) within one sync interval. Then check nothing on the account
changed because of the import: its last-modified/subscription-updated fields predate the
import window.

## The sample matrix

| #   | Sample                      | Selector (below)  | What specifically must hold                                                                                                                                            |
| --- | --------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | new customer                | `A1`              | map `user` IMPORTED; the customer row was created by the import (`existed_before_import = f`); trial decision recorded; one opening iff `Balance ≠ 0`                  |
| A2  | existing NEXA customer      | `A2`              | map `user` IMPORTED onto the EXISTING row (`existed_before_import = t`), no second customer for that Telegram id; balance = pre-import NEXA balance + legacy `Balance` |
| B1  | positive wallet             | `B1`              | exactly one `CREDIT` opening of `Balance`; `ref_ok`, `no_money`; Web Admin + Telegram show it; not in sales/revenue                                                    |
| B2  | zero wallet                 | `B2`              | NO opening entry (zero writes none); balance unchanged                                                                                                                 |
| B3  | negative wallet             | `B3`              | exactly one `DEBIT` opening of the magnitude of `Balance`; balance negative; an ordinary purchase from the wallet is refused (no credit)                               |
| C1  | normal product              | `C1`              | service's product is a normal (non-HIDDEN) catalogue product; renewal quotes its current price                                                                         |
| C2  | hidden product              | `C2`              | product `audience = HIDDEN`, shape `is_custom = f`, `tariff_status = RESOLVED`; absent from the customer catalogue; renewal quotes the current tariff                  |
| C3  | custom product              | `C3`              | shape `is_custom = t`, resolved (matched or operator-stated); renewable; never orderable new                                                                           |
| D1  | disabled service            | `D1`              | legacy status `disabled*`; NEXA state reflects RickPanel's runtime state (not the invoice snapshot); NO enable/disable was sent (`provider_ops = 0`)                   |
| D2  | near-expiry                 | `D2`              | expiry within the first reminder rung; `seeded_reminders` holds the rungs already passed; no historical reminder was sent; the NEXT genuine reminder still arrives     |
| D3  | near-volume                 | `D3`              | usage ≥ 80 %; passed usage rungs seeded, none sent; the next rung still fires                                                                                          |
| E1  | known panel                 | `E1`              | legacy `code_panel` is in the explicit map; the service's `panel_id` is exactly the mapped panel; account found on that panel only                                     |
| E2  | missing panel, unique match | `E2`              | legacy `code_panel` empty; the account exists on exactly one production RickPanel (exact lowercase username); the service names that panel                             |
| F1  | manual-review row           | `F1` (per reason) | map `MANUAL_REVIEW` with a closed reason; NO customer/service/order/opening created from that row beyond what the reason allows; listed in the Web Admin review queue  |
| G1  | prior trial                 | `G1`              | legacy had a test invoice; decision `LEGACY_TRIAL_CONSUMED`; override 0; Telegram offers no trial                                                                      |
| G2  | no trial                    | `G2`              | `limit_usertest ≤ 0` (or unreadable); decision `LEGACY_NO_TRIALS` / `LEGACY_LIMIT_UNREADABLE`; override 0; no trial offered                                            |

Do at least one sample per row; F1 once per manual-review reason that has any rows (the
dry-run's reason counts say which). Where a row's population is zero (for example no
negative balances), record `population 0` from the reconciliation snapshot instead of a sample.

## Selectors

Each puts ONE key into a variable and prints nothing. `IMPORT_START` and the seed make them
repeatable. Run the per-sample checks above after each.

```bash
# A1 new customer / A2 existing customer
LEGACY_USER="$(nexa <<<"SELECT m.legacy_id FROM legacy_import_map m JOIN tenants t ON t.id = m.tenant_id
                  JOIN customers c ON c.tenant_id = m.tenant_id AND c.id = m.entity_id
                 WHERE t.slug = :'tenant' AND m.legacy_table = 'user' AND m.status = 'IMPORTED'
                   AND c.created_at >= :'since'::timestamptz           -- A2: use  <
                 ORDER BY md5(m.legacy_id || :'seed') LIMIT 1")"; LEGACY_INVOICE=''

# B1 positive / B3 negative opening
LEGACY_USER="$(nexa <<<"SELECT c.telegram_user_id FROM wallet_entries w JOIN tenants t ON t.id = w.tenant_id
                  JOIN customers c ON c.tenant_id = w.tenant_id AND c.id = w.customer_id
                 WHERE t.slug = :'tenant' AND w.reason = 'MIGRATION_OPENING_BALANCE'
                   AND w.direction = 'CREDIT'                          -- B3: 'DEBIT'
                 ORDER BY md5(c.telegram_user_id::text || :'seed') LIMIT 1")"; LEGACY_INVOICE=''

# B2 zero: imported, no opening
LEGACY_USER="$(nexa <<<"SELECT m.legacy_id FROM legacy_import_map m JOIN tenants t ON t.id = m.tenant_id
                 WHERE t.slug = :'tenant' AND m.legacy_table = 'user' AND m.status = 'IMPORTED'
                   AND NOT EXISTS (SELECT 1 FROM wallet_entries w WHERE w.tenant_id = m.tenant_id
                                     AND w.reference = 'legacy:opening:' || m.legacy_id)
                 ORDER BY md5(m.legacy_id || :'seed') LIMIT 1")"; LEGACY_INVOICE=''

# C1 normal / C2 hidden / C3 custom, D1 disabled, D2 near-expiry, D3 near-volume:
# one adopted service by predicate. Replace <PREDICATE> with exactly one of:
#   C1: (p.audience <> 'HIDDEN')
#   C2: (p.audience = 'HIDDEN' AND l.is_custom = false)
#   C3: (l.is_custom = true)
#   D1: (s.state = 'SUSPENDED')
#   D2: (s.expires_at BETWEEN now() AND now() + interval '3 days')
#   D3: (s.traffic_limit_bytes > 0 AND s.traffic_used_bytes * 100 >= s.traffic_limit_bytes * 80)
LEGACY_INVOICE="$(nexa <<<"SELECT m.legacy_id FROM legacy_import_map m JOIN tenants t ON t.id = m.tenant_id
                  JOIN services s ON s.tenant_id = m.tenant_id AND s.id = m.entity_id
                  LEFT JOIN products p ON p.tenant_id = s.tenant_id AND p.id = s.product_id
                  LEFT JOIN legacy_product_shapes l ON l.tenant_id = p.tenant_id AND l.product_id = p.id
                 WHERE t.slug = :'tenant' AND m.legacy_table = 'invoice' AND m.entity_type = 'SERVICE'
                   AND <PREDICATE>
                 ORDER BY md5(m.legacy_id || :'seed') LIMIT 1")"
LEGACY_USER="$(nexa <<<"SELECT c.telegram_user_id FROM legacy_import_map m JOIN tenants t ON t.id = m.tenant_id
                  JOIN services s ON s.tenant_id = m.tenant_id AND s.id = m.entity_id
                  JOIN customers c ON c.tenant_id = s.tenant_id AND c.id = s.customer_id
                 WHERE t.slug = :'tenant' AND m.legacy_table = 'invoice' AND m.legacy_id = '$LEGACY_INVOICE'")"

# E1 known panel / E2 missing panel: chosen on the LEGACY side by panel code, then followed
# into NEXA. E1 needs a code that IS in the reviewed panel map.
LEGACY_INVOICE="$(legacy -e "START TRANSACTION READ ONLY;
  SELECT id_invoice FROM invoice
   WHERE Status IN ('active','disabled','disabledn','disablebyadmin','end_of_volume') AND is_test = 0
     AND code_panel = '<mapped-code>'                       -- E2: (code_panel IS NULL OR code_panel = '')
   ORDER BY MD5(CONCAT(id_invoice, '$SEED')) LIMIT 1; ROLLBACK;")"
LEGACY_USER="$(legacy -e "START TRANSACTION READ ONLY; SELECT id_user FROM invoice WHERE id_invoice = '$LEGACY_INVOICE'; ROLLBACK;")"
# E2 passes only if its map row is IMPORTED; an E2 candidate in MANUAL_REVIEW
# (PROVIDER_MISSING / AMBIGUOUS_PANEL) is an F1 sample instead — reselect with the next seed.

# F1 manual review, once per reason with rows (invoice or user table)
LEGACY_INVOICE="$(nexa <<<"SELECT m.legacy_id FROM legacy_import_map m JOIN tenants t ON t.id = m.tenant_id
                 WHERE t.slug = :'tenant' AND m.legacy_table = 'invoice' AND m.status = 'MANUAL_REVIEW'
                   AND m.reason_code = '<REASON>'
                 ORDER BY md5(m.legacy_id || :'seed') LIMIT 1")"
LEGACY_USER="$(legacy -e "START TRANSACTION READ ONLY; SELECT id_user FROM invoice WHERE id_invoice = '$LEGACY_INVOICE'; ROLLBACK;")"

# G1 prior trial / G2 no trial
LEGACY_USER="$(nexa <<<"SELECT c.telegram_user_id FROM legacy_trial_eligibility e JOIN tenants t ON t.id = e.tenant_id
                  JOIN customers c ON c.tenant_id = e.tenant_id AND c.id = e.customer_id
                 WHERE t.slug = :'tenant' AND e.decision = 'LEGACY_TRIAL_CONSUMED'   -- G2: 'LEGACY_NO_TRIALS'
                 ORDER BY md5(c.telegram_user_id::text || :'seed') LIMIT 1")"; LEGACY_INVOICE=''
```

An empty selector result is information, not an error: that population is empty (confirm it
against the reconciliation snapshot) or the import put it somewhere else (a failure to
explain).

## Recording

One row per sample in the final report (`final-report-template.md` § Manual acceptance):

| sample | seed | NEXA customer uuid | NEXA service uuid | Legacy | Decision | NEXA DB | Web Admin | Telegram | RickPanel | notes (no PII) |
| ------ | ---- | ------------------ | ----------------- | ------ | -------- | ------- | --------- | -------- | --------- | -------------- |

A FAIL that is not a documented manual-review outcome is a rollback trigger (T4) at
cutover; on staging it blocks the production gate (G14).
