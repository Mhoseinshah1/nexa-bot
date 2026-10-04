/**
 * Item 1 — the legacy SQL evidence queries, as the runner executes them
 * (`docs/legacy-migration/sql-evidence.md` is the runbook; `importer.md` §Evidence).
 *
 * VERBATIM copies of the runbook's queries. `tests/unit/legacy-importer-evidence.test.ts`
 * reads the runbook and fails if any statement here differs from it, so the runner and
 * the page a person would run by hand cannot drift.
 *
 * Every query is an aggregate by construction: counts, grouped shapes and sums. None
 * returns an id, a username, a phone or one person's balance. The runner adds nothing to
 * them and runs them inside the source session's READ ONLY transaction.
 *
 * Results from the SYNTHETIC fixture prove the runner works; they are NEVER evidence, and
 * the report says so in its header.
 */

export interface LegacyEvidenceQuery {
  readonly id: string;
  readonly title: string;
  readonly sql: string;
}

export const LEGACY_EVIDENCE_QUERIES: readonly LegacyEvidenceQuery[] = [
  {
    id: 'Q1',
    title: 'Distinct missing-product shapes (comparability with the earlier audit)',
    sql: `SELECT
  is_custom,
  COUNT(*) n,
  COUNT(DISTINCT code_panel, Volume, Service_time, time_unit, price_product) shapes
FROM invoice
WHERE Status IN ('active','disabled','disabledn','disablebyadmin','end_of_volume')
  AND is_test = 0
  AND (code_product IS NULL OR code_product = '')
GROUP BY 1;
`,
  },
  {
    id: 'Q1b',
    title:
      'The distinct-shape table for Hidden Legacy Products, reduced as legacyShapeKey v1 reduces it',
    sql: `SELECT
  outcome,
  IF(outcome = 'MAPPABLE', ic, NULL)                         AS is_custom,
  IF(outcome = 'MAPPABLE', BINARY NULLIF(cp, ''), NULL)      AS code_panel,  -- BINARY: case is kept, as the key keeps it
  IF(outcome = 'MAPPABLE', CAST(vol AS DECIMAL(13,2)), NULL) AS volume_gb,   -- 10, 10.0 and 10.00 are one value
  IF(outcome = 'MAPPABLE', CAST(st AS UNSIGNED), NULL)       AS duration_days,
  COUNT(*)                                                   AS n,
  COUNT(DISTINCT price_product)                              AS distinct_historical_prices,
  MIN(CAST(price_product AS SIGNED))                         AS min_historical_price,
  MAX(CAST(price_product AS SIGNED))                         AS max_historical_price
FROM (
  SELECT t.*,
    -- The refusals of legacyShapeKey, in its order; the first that applies wins.
    CASE
      WHEN CHAR_LENGTH(cp) > 200 OR cp REGEXP '[[:cntrl:]]'                       THEN 'CODE_PANEL_INVALID'
      WHEN vol IS NULL
        OR NOT vol REGEXP '^(0|[1-9][0-9]{0,8})([.][0-9]{1,2})?$'
        OR CAST(vol AS DECIMAL(13,2)) > 1024000                                   THEN 'VOLUME_INVALID'
      WHEN CAST(vol AS DECIMAL(13,2)) = 0                                         THEN 'VOLUME_ZERO'
      WHEN LOWER(tu) NOT IN ('', 'd', 'day', 'days')                              THEN 'TIME_UNIT_UNKNOWN'
      WHEN st IS NULL OR NOT st REGEXP '^[0-9]{1,6}$'                             THEN 'DURATION_INVALID'
      WHEN CAST(st AS UNSIGNED) = 0                                               THEN 'DURATION_ZERO'
      WHEN CAST(st AS UNSIGNED) > 3650                                            THEN 'DURATION_INVALID'
      WHEN ic IS NULL OR ic NOT IN ('0', '1')                                     THEN 'IS_CUSTOM_INVALID'
      ELSE 'MAPPABLE'
    END AS outcome
  FROM (
    SELECT
      REGEXP_REPLACE(COALESCE(code_panel, ''),        '^[[:space:]]+|[[:space:]]+$', '') AS cp,
      REGEXP_REPLACE(CAST(Volume AS CHAR),            '^[[:space:]]+|[[:space:]]+$', '') AS vol,
      REGEXP_REPLACE(COALESCE(time_unit, ''),         '^[[:space:]]+|[[:space:]]+$', '') AS tu,
      REGEXP_REPLACE(CAST(Service_time AS CHAR),      '^[[:space:]]+|[[:space:]]+$', '') AS st,
      CAST(is_custom AS CHAR)                                                            AS ic,
      price_product
    FROM invoice
    WHERE Status IN ('active','disabled','disabledn','disablebyadmin','end_of_volume')
      AND is_test = 0
      AND (code_product IS NULL OR code_product = '')
  ) t
) c
GROUP BY 1, 2, 3, 4, 5
ORDER BY outcome, n DESC;
`,
  },
  {
    id: 'Q1c_time_unit',
    title: 'Unit spellings among productless live real invoices',
    sql: `SELECT
  CASE WHEN LOWER(tu) IN ('', 'd', 'day', 'days') THEN 'ACCEPTED' ELSE 'TIME_UNIT_UNKNOWN' END AS category,
  tu AS trimmed_time_unit,
  COUNT(*) AS n,
  MIN(CAST(Service_time AS SIGNED)) AS min_time, MAX(CAST(Service_time AS SIGNED)) AS max_time
FROM (
  SELECT REGEXP_REPLACE(COALESCE(time_unit, ''), '^[[:space:]]+|[[:space:]]+$', '') AS tu, Service_time
  FROM invoice
  WHERE Status IN ('active','disabled','disabledn','disablebyadmin','end_of_volume')
    AND is_test = 0
    AND (code_product IS NULL OR code_product = '')
) t
GROUP BY 1, 2 ORDER BY n DESC;
`,
  },
  {
    id: 'Q1c_volume',
    title: 'Volume spellings among productless live real invoices',
    sql: `SELECT
  category,
  IF(category = 'VALID', NULL, vol) AS trimmed_volume,  -- accepted values are counted, not listed
  COUNT(*) AS n
FROM (
  SELECT vol,
    CASE
      WHEN vol IS NULL                                                       THEN 'NULL'
      WHEN NOT vol REGEXP '^(0|[1-9][0-9]{0,8})([.][0-9]{1,2})?$'            THEN 'INVALID_PATTERN'  -- sign, exponent, 3+ decimals, leading zero, text
      WHEN CAST(vol AS DECIMAL(13,2)) > 1024000                              THEN 'OVER_MAX'
      WHEN CAST(vol AS DECIMAL(13,2)) = 0                                    THEN 'ZERO'
      ELSE 'VALID'
    END AS category
  FROM (
    SELECT REGEXP_REPLACE(CAST(Volume AS CHAR), '^[[:space:]]+|[[:space:]]+$', '') AS vol
    FROM invoice
    WHERE Status IN ('active','disabled','disabledn','disablebyadmin','end_of_volume')
      AND is_test = 0
      AND (code_product IS NULL OR code_product = '')
  ) t
) c
GROUP BY 1, 2 ORDER BY n DESC;
`,
  },
  {
    id: 'Q2',
    title: 'Trial eligibility x actual trial history',
    sql: `SELECT
  u.limit_usertest,
  (EXISTS (
    SELECT 1 FROM invoice i
    WHERE i.id_user = u.id AND i.is_test = 1
  )) had_trial,
  COUNT(*)
FROM user u
GROUP BY 1,2;
`,
  },
  {
    id: 'Q2b',
    title: "Q2 as decideLegacyTrial's four branches",
    sql: `SELECT decision, COUNT(*) AS n
FROM (
  SELECT CASE
      WHEN lim IS NULL OR NOT lim REGEXP '^-?[0-9]{1,10}$'
        OR ABS(CAST(lim AS SIGNED)) > 2147483647           THEN 'LEGACY_LIMIT_UNREADABLE'
      WHEN CAST(lim AS SIGNED) <= 0                         THEN 'LEGACY_NO_TRIALS'
      WHEN had_trial = 1                                    THEN 'LEGACY_TRIAL_CONSUMED'
      ELSE 'INHERIT_NEXA_POLICY'
    END AS decision
  FROM (
    SELECT
      REGEXP_REPLACE(CAST(u.limit_usertest AS CHAR), '^[[:space:]]+|[[:space:]]+$', '') AS lim,
      EXISTS (SELECT 1 FROM invoice i WHERE i.id_user = u.id AND i.is_test = 1) AS had_trial
    FROM user u
  ) x
) d
GROUP BY decision ORDER BY decision;
`,
  },
  {
    id: 'Q3',
    title: 'Is user.affiliates a user id (evidence only)',
    sql: `SELECT
  (a.id IS NOT NULL) is_user_id,
  COUNT(*),
  COUNT(DISTINCT u.affiliates)
FROM user u
LEFT JOIN user a ON a.id = u.affiliates
GROUP BY 1;
`,
  },
  {
    id: 'Q4',
    title: 'Agent distribution and negative balances',
    sql: `SELECT
  agent,
  COUNT(*),
  SUM(CAST(Balance AS SIGNED) < 0) negatives,
  SUM(CAST(Balance AS SIGNED))
FROM user
GROUP BY 1;
`,
  },
  {
    id: 'Q5',
    title: 'Product agent groups',
    sql: `SELECT agent, COUNT(*)
FROM product
GROUP BY 1;
`,
  },
  {
    id: 'Q6',
    title: 'Missing-panel live invoices, test vs real',
    sql: `SELECT is_test, COUNT(*)
FROM invoice
WHERE Status IN ('active','disabled','disabledn','disablebyadmin','end_of_volume')
  AND (code_panel IS NULL OR code_panel = '')
GROUP BY 1;
`,
  },
  {
    id: 'Q7',
    title: 'Orphan real live invoices',
    sql: `SELECT COUNT(*)
FROM invoice i
LEFT JOIN user u ON u.id = i.id_user
WHERE i.Status IN ('active','disabled','disabledn','disablebyadmin','end_of_volume')
  AND i.is_test = 0
  AND u.id IS NULL;
`,
  },
];
