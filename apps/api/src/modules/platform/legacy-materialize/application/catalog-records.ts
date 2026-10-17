import { createHash } from 'node:crypto';

/**
 * The one-time Mirza import — products, resellers and discount codes: how one archived
 * package record becomes one NEXA row, or a counted gap. Pure: no clock, no database, no I/O.
 *
 * Every reader here fails SOFT, never open: a field it cannot read is `null` and the row is
 * either carried without it (when NEXA has a safe default) or reported as a gap with a closed
 * reason. Nothing is guessed, and nothing here can produce an amount from a value the package
 * did not state as one.
 */

export type Rec = Readonly<Record<string, unknown>>;

/** One archived package record (`legacy_history_records`), as a step reads it. */
export interface HistoryRow {
  readonly idempotencyKey: string;
  readonly legacyUserId: string | null;
  /** The customer the ingest resolved at write time, when it could. */
  readonly customerId: string | null;
  readonly payload: Rec;
}

const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
export const recOf = (v: unknown): Rec => (isRec(v) ? v : {});
export const textOf = (v: unknown): string | null =>
  typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : null;

/** A whole, non-negative number of Toman in ASCII digits, as IRT minor units (exponent 0). */
export function tomanMinor(v: unknown): bigint | null {
  const t = textOf(v)?.trim();
  if (t === undefined || !/^[0-9]{1,19}$/u.test(t)) return null;
  const n = BigInt(t);
  return n <= 9_007_199_254_740_991_000n ? n : null;
}

/** A positive whole number that fits `integer`, or null. */
export function positiveInt(v: unknown): number | null {
  const t = textOf(v)?.trim();
  if (t === undefined || !/^[0-9]{1,9}$/u.test(t)) return null;
  const n = Number(t);
  return n >= 1 && n <= 2_147_483_647 ? n : null;
}

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
const clip = (s: string, max: number): string => [...s].slice(0, max).join('');
const clean = (s: string): string =>
  s
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();

// --- products -------------------------------------------------------------------------------

export const PRODUCT_TITLE_MAX = 120;
export const CATEGORY_NAME_MAX = 120;
/** A Mirza product with `Volume_constraint`/`Service_time` of zero means "unlimited" in Mirza. */
export const PRODUCT_GAP_REASONS = [
  'NO_PRODUCT_ID',
  'VOLUME_UNREADABLE',
  'DURATION_UNREADABLE',
] as const;
export type ProductGapReason = (typeof PRODUCT_GAP_REASONS)[number];

/** Why a carried product is INACTIVE. First match wins, in this order. */
export const PRODUCT_INACTIVE_REASONS = [
  'SOLD_OUT_IN_MIRZA',
  'PANEL_NOT_MAPPED',
  'PANEL_SCOPE_ALL_PANELS',
  'NO_PRICE',
  'NO_CATEGORY',
  'UNLIMITED_NEEDS_REVIEW',
  'AUDIENCE_UNKNOWN',
] as const;
export type ProductInactiveReason = (typeof PRODUCT_INACTIVE_REASONS)[number];

export interface PlannedProduct {
  readonly kind: 'create';
  readonly sourceRef: string;
  readonly title: string;
  readonly status: 'ACTIVE' | 'INACTIVE';
  readonly inactiveReason: ProductInactiveReason | null;
  readonly audience: 'EVERYONE' | 'RESELLERS_ONLY' | 'HIDDEN';
  readonly trafficBytes: bigint;
  readonly durationDays: number;
  readonly priceMinor: bigint | null;
  readonly panelId: string | null;
  /** The Mirza category label, trimmed; null when the product has none. */
  readonly categoryName: string | null;
  /** What Mirza stated as the price, for the exact-match sum (null when unreadable). */
  readonly mirzaPriceMinor: bigint | null;
}
export interface ProductGap {
  readonly kind: 'gap';
  readonly reason: ProductGapReason;
  readonly mirzaPriceMinor: bigint | null;
}

export function productSourceRef(legacyProductId: string): string {
  return `product:${legacyProductId}`;
}

/** The category name a Mirza label becomes, or null. Matching is by `categoryKey`. */
export function categoryNameOf(raw: unknown): string | null {
  const t = textOf(raw);
  if (t === null) return null;
  const name = clip(clean(t), CATEGORY_NAME_MAX);
  return name === '' ? null : name;
}
export const categoryKey = (name: string): string => name.trim().toLowerCase();

export function planProduct(
  record: Rec,
  panelBindings: ReadonlyMap<string, string>,
  tenantPanels: ReadonlySet<string>,
): PlannedProduct | ProductGap {
  const conv = recOf(record['conversions']);
  const price = recOf(conv['price']);
  const mirzaPriceMinor = price['parse_note'] === 'OK' ? tomanMinor(price['amount_minor']) : null;
  const legacyId = textOf(record['legacy_product_id'])?.trim() ?? '';
  if (legacyId === '' || legacyId.length > 100) {
    return { kind: 'gap', reason: 'NO_PRODUCT_ID', mirzaPriceMinor };
  }
  const traffic = recOf(conv['traffic']);
  const trafficText = textOf(traffic['proposed_traffic_bytes']);
  if (trafficText === null || !/^[0-9]{1,19}$/u.test(trafficText)) {
    return { kind: 'gap', reason: 'VOLUME_UNREADABLE', mirzaPriceMinor };
  }
  const duration = recOf(conv['duration']);
  const days = duration['proposed_duration_days'];
  if (typeof days !== 'number' || !Number.isInteger(days) || days < 0 || days > 3650) {
    return { kind: 'gap', reason: 'DURATION_UNREADABLE', mirzaPriceMinor };
  }
  const trafficBytes = BigInt(trafficText);

  const tier = recOf(conv['agent_tier']);
  const proposed = tier['proposed_audience'];
  const audienceKnown = proposed === 'EVERYONE' || proposed === 'RESELLERS_ONLY';
  // An agent tier the package could not read hides the product: never offered to everyone.
  const audience = audienceKnown ? proposed : 'HIDDEN';

  const scope = recOf(conv['panel_scope']);
  const codes = Array.isArray(scope['resolved_code_panels'])
    ? scope['resolved_code_panels'].filter((c): c is string => typeof c === 'string')
    : [];
  let panelId: string | null = null;
  if (scope['kind'] === 'PANEL_NAME' && scope['state'] === 'RESOLVED' && codes.length === 1) {
    const bound = panelBindings.get(codes[0] as string);
    if (bound !== undefined && tenantPanels.has(bound)) panelId = bound;
  }

  const category = categoryNameOf(recOf(conv['category'])['raw']);
  const sale = recOf(conv['sale_status']);
  const soldOut = sale['read'] === true && textOf(sale['raw'])?.trim().toLowerCase() === 'disable';
  const priceMinor = mirzaPriceMinor !== null && mirzaPriceMinor > 0n ? mirzaPriceMinor : null;
  const unlimited = trafficBytes === 0n || days === 0;

  const inactiveReason: ProductInactiveReason | null = soldOut
    ? 'SOLD_OUT_IN_MIRZA'
    : panelId === null
      ? scope['kind'] === 'ALL_PANELS'
        ? 'PANEL_SCOPE_ALL_PANELS'
        : 'PANEL_NOT_MAPPED'
      : priceMinor === null
        ? 'NO_PRICE'
        : category === null
          ? 'NO_CATEGORY'
          : unlimited
            ? 'UNLIMITED_NEEDS_REVIEW'
            : !audienceKnown
              ? 'AUDIENCE_UNKNOWN'
              : null;

  const code = textOf(record['code_product'])?.trim() ?? '';
  const title = clip(clean(textOf(record['title_proposal']) ?? ''), PRODUCT_TITLE_MAX);
  return {
    kind: 'create',
    sourceRef: productSourceRef(legacyId),
    title:
      title !== ''
        ? title
        : code !== ''
          ? clip(clean(code), PRODUCT_TITLE_MAX)
          : `Mirza ${legacyId}`,
    status: inactiveReason === null ? 'ACTIVE' : 'INACTIVE',
    inactiveReason,
    audience,
    trafficBytes,
    durationDays: days,
    priceMinor,
    panelId,
    categoryName: category,
    mirzaPriceMinor,
  };
}

// --- resellers ------------------------------------------------------------------------------

export const RESELLER_GAP_REASONS = [
  'NO_OWNER',
  'NOT_AN_AGENT_TIER',
  'CUSTOMER_NOT_IMPORTED',
  'CUSTOMER_ALREADY_RESELLER',
] as const;
export type ResellerGapReason = (typeof RESELLER_GAP_REASONS)[number];

/** The two Mirza agent tiers, each becoming one NEXA tier. */
export const MIRZA_AGENT_TIERS = {
  n: 'Mirza agent (n)',
  n2: 'Mirza agent (n2)',
} as const;
export type MirzaAgentTier = keyof typeof MIRZA_AGENT_TIERS;

export interface ResellerFacts {
  /** The Mirza `user.id`, which is the agent's Telegram id. */
  readonly agentId: string;
  readonly sourceRef: string;
  readonly tier: MirzaAgentTier | null;
  readonly telegramUserId: string | null;
  readonly customerId: string | null;
  readonly customerValid: boolean;
  /** `user.maxbuyagent`, parsed; null when absent or unreadable. */
  readonly capMinor: bigint | null;
  readonly capRaw: string | null;
  /** `user.pricediscount` applied as a per-reseller percentage (1..99), else null. */
  readonly appliedPercent: number | null;
  readonly percentRaw: string | null;
  readonly expiry: string | null;
  readonly expiryRaw: string | null;
  /** The custom price levels as the package kept them. NEVER applied. */
  readonly priceLevels: readonly Rec[];
}

export const resellerSourceRef = (agentId: string): string => `agent:${agentId}`;

/** The agent id a profile / state key names, or null. */
export function agentIdOfKey(key: string): string | null {
  const m = /^legacy:agents:(?:profile|state):(.+)$/u.exec(key);
  return m === null || (m[1] as string).startsWith('unowned:') ? null : (m[1] as string);
}

export function resellerFacts(
  profile: HistoryRow,
  state: HistoryRow | null,
  levels: readonly Rec[],
): ResellerFacts | null {
  const agentId = agentIdOfKey(profile.idempotencyKey);
  if (agentId === null) return null;
  const customer = recOf(profile.payload['customer']);
  const tierRaw = textOf(profile.payload['tier']);
  const tier: MirzaAgentTier | null = tierRaw === 'n' || tierRaw === 'n2' ? tierRaw : null;
  const s = state?.payload ?? {};
  const capRaw = textOf(recOf(s['credit_debt'])['overdraft_limit_raw']);
  const percentRaw = textOf(recOf(s['pricing'])['percent_discount_raw']);
  const percentStaged = recOf(s['pricing'])['percent_discount_staged'] === true;
  const percent = percentStaged ? positiveInt(percentRaw) : null;
  const status = recOf(s['current_status']);
  const telegramUserId = textOf(customer['telegram_user_id']);
  return {
    agentId,
    sourceRef: resellerSourceRef(agentId),
    tier,
    telegramUserId,
    customerId: profile.customerId,
    customerValid: customer['valid'] === true,
    capMinor: capRaw === null ? null : tomanMinor(capRaw),
    capRaw,
    // 100 % would be a free product: not proven, not applied. 1..99 only.
    appliedPercent: percent !== null && percent <= 99 ? percent : null,
    percentRaw,
    expiry: textOf(status['agent_expiry']),
    expiryRaw: textOf(status['agent_expiry_raw']),
    priceLevels: levels,
  };
}

/** What the reseller row keeps beside its columns: the evidence, reversible, applied nowhere. */
export function resellerSourceDetail(f: ResellerFacts): Record<string, unknown> {
  return {
    v: 1,
    mirzaTier: f.tier,
    purchaseCap: { raw: f.capRaw, applied: false },
    pricediscount: { raw: f.percentRaw, applied: f.appliedPercent },
    agentExpiry: { value: f.expiry, raw: f.expiryRaw, applied: false },
    tierPriceLevels: {
      applied: false,
      reason: 'PRICE_SEMANTICS_UNKNOWN',
      levels: f.priceLevels.map((l) => ({
        key: textOf(l['idempotency_key']),
        levelIndex: l['level_index'] ?? null,
        ownerValueRaw: l['owner_value_raw'] ?? null,
        fieldsRaw: l['fields_raw'] ?? null,
      })),
    },
  };
}

// --- discounts ------------------------------------------------------------------------------

export const DISCOUNT_GAP_REASONS = [
  'PERCENT_UNREADABLE',
  'GIFT_AMOUNT_UNREADABLE',
  'KIND_UNKNOWN',
  'NO_IDENTITY',
] as const;
export type DiscountGapReason = (typeof DISCOUNT_GAP_REASONS)[number];

export const CODE_PATTERN = /^[A-Z0-9_-]{3,40}$/u;

/**
 * A Mirza code made to fit NEXA's code shape: upper case, `[A-Z0-9_-]` only, 3..40 long. Null
 * when nothing usable is left (the caller then derives one from the record's own reference).
 */
export function normaliseCode(raw: string): string | null {
  const t = raw
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/gu, '')
    .slice(0, 40);
  return CODE_PATTERN.test(t) ? t : null;
}

/** A code derived from the record's reference alone: Mirza's gift/discount code text was absent. */
export function derivedCode(sourceRef: string): string {
  return `MZ-${sha(sourceRef).slice(0, 12).toUpperCase()}`;
}

/**
 * The code a record is stored under, deterministic in `taken`: the normalised text, else — on a
 * collision with an existing or earlier code — the same text with a suffix drawn from the
 * record's own reference (and, if even that is taken, a counter).
 */
export function allocateCode(
  base: string,
  sourceRef: string,
  isTaken: (code: string) => boolean,
): string {
  if (!isTaken(base)) return base;
  const digest = sha(sourceRef).toUpperCase();
  for (let n = 0; n < 1000; n += 1) {
    const suffix = `-${digest.slice(0, 8)}${n === 0 ? '' : String(n)}`;
    const candidate = `${base.slice(0, 40 - suffix.length)}${suffix}`;
    if (!isTaken(candidate)) return candidate;
  }
  // 1000 distinct suffixes of one digest all taken is not a state worth a silent fallback.
  throw new Error(`no free discount code for ${sourceRef}`);
}

export interface PlannedDiscount {
  readonly kind: 'create';
  readonly sourceRef: string;
  readonly mirzaKind: string;
  /** NEXA type: a Mirza percent code is PERCENTAGE; a wallet gift code is a FIXED_AMOUNT shell. */
  readonly type: 'PERCENTAGE' | 'FIXED_AMOUNT';
  readonly value: bigint;
  readonly currency: 'IRT' | null;
  readonly codeText: string | null;
  readonly baseCode: string;
  readonly appliesTo: readonly ('NEW_SERVICE' | 'RENEW')[];
  readonly firstPurchaseOnly: boolean;
  readonly totalLimit: number | null;
  readonly perCustomerLimit: number | null;
  readonly endsAt: Date | null;
  readonly detail: Record<string, unknown>;
}
export interface DiscountGap {
  readonly kind: 'gap';
  readonly reason: DiscountGapReason;
}

/**
 * `discount:<table>:<pk>` — the package's own key without its `legacy:` prefix; a key too long
 * for `source_ref` is replaced by its digest, which is as stable.
 */
export function discountSourceRef(idempotencyKey: string): string {
  const ref = `discount:${idempotencyKey.replace(/^legacy:/u, '')}`;
  return ref.length <= 128 ? ref : `discount:sha256:${sha(idempotencyKey).slice(0, 48)}`;
}

function expiryOf(v: unknown): Date | null {
  const t = textOf(v);
  if (t === null || !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/u.test(t)) return null;
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function planDiscount(row: HistoryRow): PlannedDiscount | DiscountGap {
  const r = row.payload;
  const key = row.idempotencyKey;
  if (key.length < 1) return { kind: 'gap', reason: 'NO_IDENTITY' };
  const sourceRef = discountSourceRef(key);
  const mirzaKind = textOf(r['kind']) ?? 'UNKNOWN';
  const scope = recOf(r['scope']);
  const codeText = textOf(r['code_text']);
  const normalised = codeText === null ? null : normaliseCode(codeText);
  const baseCode = normalised ?? derivedCode(sourceRef);

  let type: 'PERCENTAGE' | 'FIXED_AMOUNT';
  let value: bigint;
  let currency: 'IRT' | null;
  if (mirzaKind === 'PURCHASE_PERCENT_CODE') {
    const pct = r['percent'];
    if (typeof pct !== 'number' || !Number.isInteger(pct) || pct < 1 || pct > 100) {
      return { kind: 'gap', reason: 'PERCENT_UNREADABLE' };
    }
    type = 'PERCENTAGE';
    value = BigInt(pct);
    currency = null;
  } else if (mirzaKind === 'GIFT_BALANCE_CODE') {
    const credit = recOf(r['credit_amount']);
    const amount = tomanMinor(credit['amount_minor']);
    if (amount === null || amount <= 0n) return { kind: 'gap', reason: 'GIFT_AMOUNT_UNREADABLE' };
    // NEXA has no "credit the wallet" code. The shell is inactive and carries the kind, so
    // nobody mistakes it for a discount; it can never be redeemed as a wallet credit.
    type = 'FIXED_AMOUNT';
    value = amount;
    currency = 'IRT';
  } else {
    return { kind: 'gap', reason: 'KIND_UNKNOWN' };
  }

  const scopeType = textOf(scope['type']);
  const usesFirst = textOf(scope['first_purchase_only_raw'])?.trim() === '1';
  const appliesTo: ('NEW_SERVICE' | 'RENEW')[] = usesFirst
    ? ['NEW_SERVICE']
    : scopeType === 'extend'
      ? ['RENEW']
      : scopeType === 'all'
        ? ['NEW_SERVICE', 'RENEW']
        : ['NEW_SERVICE'];
  const limit = r['limit_total'];
  return {
    kind: 'create',
    sourceRef,
    mirzaKind,
    type,
    value,
    currency,
    codeText,
    baseCode,
    appliesTo,
    firstPurchaseOnly: usesFirst,
    totalLimit:
      typeof limit === 'number' && Number.isInteger(limit) && limit >= 1 && limit <= 2_147_483_647
        ? limit
        : null,
    perCustomerLimit: positiveInt(scope['per_user_limit_raw']),
    endsAt: expiryOf(r['expires_at']),
    detail: {
      v: 1,
      mirzaKind,
      codeOriginal: codeText,
      codeNormalised: codeText !== null && normalised !== codeText,
      codeDerived: normalised === null,
      codeRef: textOf(r['code_ref']),
      usedCount: r['used_count'] ?? null,
      usedCountRaw: r['used_count_raw'] ?? null,
      limitTotalRaw: r['limit_total_raw'] ?? null,
      lifecycleState: textOf(r['lifecycle_state']),
      scopeRaw: scope,
      expiresAtRaw: r['expires_at_raw'] ?? null,
    },
  };
}
