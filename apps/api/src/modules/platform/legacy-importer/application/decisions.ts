import {
  LEGACY_ID_PATTERNS,
  isLegacyImportKey,
  PAYMENT_AMOUNT_MAX_MINOR,
  telegramUserIdSchema,
  type LegacyImportReasonCode,
} from '@nexa/contracts';
import {
  legacyShapeKey,
  type LegacyShapeUnmappableReason,
} from '../../../commerce/catalog/application/legacy-shape.js';
import {
  matchLegacyService,
  type LegacyPanelPolicy,
  type PanelInventoryIndex,
} from '../../legacy-import/application/legacy-service-matching.js';

/**
 * Migration P7 — every per-row decision the importer makes, pure
 * (`docs/legacy-migration/importer.md` §Decisions).
 *
 * The rule throughout is the program's: never guess identity, balance, panel, product or
 * trial state. A value that does not read exactly as the evidence says it should is a
 * manual-review row with a closed reason, never a normalised guess.
 */

// --- phone --------------------------------------------------------------------------------

/**
 * What the legacy `user.number` is. The value is never written anywhere: NEXA's
 * `customers.phone_number` means "a phone an OPERATOR verified out of band, and when"
 * (`customers_phone_check`), which a legacy column is not. So the phone decides nothing
 * about the customer; it is classified so the report can say how many are unusable, and
 * an INVALID one is a manual-review signal, never a corrected guess.
 */
export type LegacyPhoneClass = 'ABSENT' | 'VALID' | 'INVALID';

/** MirzaBot writes `none` (and older rows `0`) when no phone was shared. */
const PHONE_ABSENT_SPELLINGS: ReadonlySet<string> = new Set(['', 'none', '0']);

export function classifyLegacyPhone(raw: string | null): LegacyPhoneClass {
  if (raw === null) return 'ABSENT';
  const trimmed = raw.trim();
  if (PHONE_ABSENT_SPELLINGS.has(trimmed.toLowerCase())) return 'ABSENT';
  // E.164 (optionally without its +), or an Iranian national mobile (09xxxxxxxxx).
  if (/^\+?[1-9][0-9]{7,14}$/u.test(trimmed) || /^09[0-9]{9}$/u.test(trimmed)) return 'VALID';
  return 'INVALID';
}

// --- customers and opening balances -------------------------------------------------------

export type LegacyOpeningKind = 'POSITIVE' | 'ZERO' | 'NEGATIVE';

export type LegacyUserDecision =
  /** `user.id` is not a Telegram id: there is no customer to make and no key to record. */
  | { readonly kind: 'INVALID_IDENTITY' }
  /** The identity is fine; a money fact is not readable. Nothing is written for the user. */
  | {
      readonly kind: 'MANUAL_REVIEW';
      readonly reason: 'BALANCE_UNREADABLE' | 'BALANCE_OUT_OF_RANGE';
      readonly mapReason: LegacyImportReasonCode;
    }
  | {
      readonly kind: 'IMPORT';
      readonly telegramUserId: string;
      readonly customer: 'NEW' | 'EXISTING';
      readonly openingKind: LegacyOpeningKind;
      /** Signed legacy `Balance`, Toman = IRT minor units. */
      readonly balanceMinor: bigint;
      /** The map row's warning, if any: `EXISTING_CUSTOMER`, else `NEGATIVE_BALANCE`. */
      readonly mapReason: LegacyImportReasonCode | null;
    };

/** A whole number of Toman, signed, or null. `10.5`, `1e3`, `` and text are not balances. */
export function parseLegacyBalance(raw: string | null): bigint | null {
  if (raw === null) return null;
  const text = raw.trim();
  if (!/^-?[0-9]{1,19}$/u.test(text)) return null;
  return BigInt(text);
}

/** `user.id` as a customer identity: a Telegram id AND a key the import map accepts. */
export function legacyTelegramId(raw: string): string | null {
  return telegramUserIdSchema.safeParse(raw).success && LEGACY_ID_PATTERNS.user.test(raw)
    ? raw
    : null;
}

export function decideLegacyUser(
  row: { readonly id: string; readonly balance: string | null },
  existingCustomer: boolean,
): LegacyUserDecision {
  const telegramUserId = legacyTelegramId(row.id);
  if (telegramUserId === null) return { kind: 'INVALID_IDENTITY' };
  const balanceMinor = parseLegacyBalance(row.balance);
  if (balanceMinor === null) {
    return { kind: 'MANUAL_REVIEW', reason: 'BALANCE_UNREADABLE', mapReason: 'INVALID_SOURCE_ROW' };
  }
  const magnitude = balanceMinor < 0n ? -balanceMinor : balanceMinor;
  if (magnitude > PAYMENT_AMOUNT_MAX_MINOR) {
    return {
      kind: 'MANUAL_REVIEW',
      reason: 'BALANCE_OUT_OF_RANGE',
      mapReason: 'INVALID_SOURCE_ROW',
    };
  }
  const openingKind: LegacyOpeningKind =
    balanceMinor > 0n ? 'POSITIVE' : balanceMinor < 0n ? 'NEGATIVE' : 'ZERO';
  return {
    kind: 'IMPORT',
    telegramUserId,
    customer: existingCustomer ? 'EXISTING' : 'NEW',
    openingKind,
    balanceMinor,
    mapReason: existingCustomer
      ? 'EXISTING_CUSTOMER'
      : openingKind === 'NEGATIVE'
        ? 'NEGATIVE_BALANCE'
        : null,
  };
}

/** A Telegram username, kept as profile metadata only when it is one. */
export function legacyProfileUsername(raw: string | null): string | null {
  if (raw === null) return null;
  const text = raw.trim().replace(/^@/u, '');
  return /^[A-Za-z][A-Za-z0-9_]{4,31}$/u.test(text) ? text : null;
}

/** Whether the legacy user was an agent (reseller). Reported only: resellers are out of Phase 1. */
export function legacyIsAgent(raw: string | null): boolean {
  if (raw === null) return false;
  const text = raw.trim().toLowerCase();
  return text !== '' && text !== 'f' && text !== '0' && text !== 'false';
}

// --- service candidates -------------------------------------------------------------------

/**
 * Where every live legacy invoice ends up. A closed set: the reconcile requires the
 * categories to add up to the candidates, so an invoice can never fall out of the report.
 */
export const SERVICE_CANDIDATE_CATEGORIES = [
  /** `id_invoice` is outside the evidenced key shape: no map row can name it. */
  'INVOICE_KEY_INVALID',
  /** `is_test = 1`: a legacy trial. Not adopted (registered decision); expires on the panel. */
  'TEST_INVOICE_SKIPPED',
  /** On a panel the operator declared a test panel. */
  'TEST_PANEL_SKIPPED',
  /** `is_test` is neither 0 nor 1. */
  'INVALID_SOURCE_ROW',
  /** No legacy user owns it (Q7). */
  'ORPHAN',
  /** Its user was not imported (invalid identity or manual review). */
  'CUSTOMER_NOT_IMPORTED',
  /** The legacy username is not one the matcher compares. */
  'INVALID_USERNAME',
  /** A panel the decision depends on has no complete inventory. */
  'INVENTORY_INCOMPLETE',
  'PROVIDER_MISSING',
  'AMBIGUOUS_PANEL',
  'PANEL_UNMAPPED',
  'USERNAME_CASE_COLLISION',
  /** Productless/custom, and the shape key refuses it (Q1b's non-MAPPABLE rows). */
  'UNSUPPORTED_SHAPE',
  /** Productless/custom, the shape is mappable, and it has no current tariff. */
  'PRODUCT_UNRESOLVED',
  /** Everything holds; P6 adoption decides from here. */
  'ADOPTION_ELIGIBLE',
] as const;
export type ServiceCandidateCategory = (typeof SERVICE_CANDIDATE_CATEGORIES)[number];

/** How a candidate's product would be resolved. */
export type ServiceProductPath =
  /** `code_product` names a product the legacy `product` table has: P6 resolves it. */
  | { readonly kind: 'NAMED_PRODUCT'; readonly codeProduct: string }
  /** No product, a missing product, or a custom service: the hidden legacy product. */
  | { readonly kind: 'HIDDEN_SHAPE'; readonly shapeKey: string; readonly custom: boolean };

export type ServiceCandidateDecision =
  | {
      readonly category: Exclude<ServiceCandidateCategory, 'ADOPTION_ELIGIBLE'>;
      readonly shapeReason?: LegacyShapeUnmappableReason;
    }
  | {
      readonly category: 'ADOPTION_ELIGIBLE';
      readonly panelId: string;
      readonly providerUsername: string;
      readonly product: ServiceProductPath;
      readonly telegramUserId: string;
    };

/** What a productless shape's current tariff is, as the run knows it. */
export type ShapeTariffKnowledge = 'RESOLVED' | 'UNRESOLVED';

export interface ServiceDecisionContext {
  /** Every legacy user id, imported or not (orphan detection). */
  readonly userIds: ReadonlySet<string>;
  /** Legacy user id → Telegram id, for users whose decision is IMPORT. */
  readonly importedUsers: ReadonlyMap<string, string>;
  readonly policy: LegacyPanelPolicy;
  readonly inventories: ReadonlyMap<string, PanelInventoryIndex>;
  readonly productCodes: ReadonlySet<string>;
  readonly tariffOf: (shapeKey: string) => ShapeTariffKnowledge;
}

export function legacyCodePanel(raw: string | null): string | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

export function decideServiceCandidate(
  invoice: {
    readonly idInvoice: string;
    readonly idUser: string | null;
    readonly username: string | null;
    readonly isTest: string | null;
    readonly codePanel: string | null;
    readonly codeProduct: string | null;
    readonly volume: string | null;
    readonly serviceTime: string | null;
    readonly timeUnit: string | null;
    readonly isCustom: string | null;
  },
  ctx: ServiceDecisionContext,
): ServiceCandidateDecision {
  // The row identity first, as a user's Telegram id is: a key the import map refuses
  // (`LEGACY_ID_PATTERNS.invoice`) cannot carry a decision, so a person looks at it.
  if (!isLegacyImportKey('invoice', invoice.idInvoice)) return { category: 'INVOICE_KEY_INVALID' };
  const isTest = invoice.isTest?.trim() ?? null;
  if (isTest === '1') return { category: 'TEST_INVOICE_SKIPPED' };
  if (isTest !== '0') return { category: 'INVALID_SOURCE_ROW' };

  if (invoice.idUser === null || !ctx.userIds.has(invoice.idUser)) return { category: 'ORPHAN' };
  const telegramUserId = ctx.importedUsers.get(invoice.idUser);
  if (telegramUserId === undefined) return { category: 'CUSTOMER_NOT_IMPORTED' };

  const match = matchLegacyService(
    { codePanel: legacyCodePanel(invoice.codePanel), username: invoice.username ?? '' },
    ctx.policy,
    ctx.inventories,
  );
  switch (match.kind) {
    case 'SKIPPED':
      return { category: 'TEST_PANEL_SKIPPED' };
    case 'INVALID':
      return { category: 'INVALID_USERNAME' };
    case 'UNDECIDABLE':
      return { category: 'INVENTORY_INCOMPLETE' };
    case 'MANUAL_REVIEW':
      return { category: match.reason };
    case 'ELIGIBLE':
      break;
  }

  const codeProduct = invoice.codeProduct?.trim() ?? '';
  const custom = invoice.isCustom?.trim() === '1';
  let product: ServiceProductPath;
  if (codeProduct !== '' && !custom && ctx.productCodes.has(codeProduct)) {
    product = { kind: 'NAMED_PRODUCT', codeProduct };
  } else {
    const keyed = legacyShapeKey({
      codePanel: invoice.codePanel,
      volume: invoice.volume,
      serviceTime: invoice.serviceTime,
      timeUnit: invoice.timeUnit,
      isCustom: invoice.isCustom,
    });
    if (!keyed.ok) return { category: 'UNSUPPORTED_SHAPE', shapeReason: keyed.reason };
    if (ctx.tariffOf(keyed.key) !== 'RESOLVED') return { category: 'PRODUCT_UNRESOLVED' };
    product = { kind: 'HIDDEN_SHAPE', shapeKey: keyed.key, custom: keyed.shape.isCustom };
  }
  return {
    category: 'ADOPTION_ELIGIBLE',
    panelId: match.panelId,
    providerUsername: match.providerUsername,
    product,
    telegramUserId,
  };
}

/**
 * Whether a live invoice's product is the hidden legacy product of its shape: real
 * (`is_test = 0`), and productless, naming a product the legacy table does not have, or
 * custom — exactly the `HIDDEN_SHAPE` path of `decideServiceCandidate`. The products
 * phase ensures one shape per distinct key in this population.
 *
 * Q1b counts a narrower set — productless only — so the report carries both: the
 * productless subset (`isQ1bPopulation`) is the figure to compare with Q1b.
 */
export function needsHiddenShape(
  invoice: {
    readonly isTest: string | null;
    readonly codeProduct: string | null;
    readonly isCustom: string | null;
  },
  productCodes: ReadonlySet<string>,
): boolean {
  if (invoice.isTest?.trim() !== '0') return false;
  const code = invoice.codeProduct?.trim() ?? '';
  return code === '' || invoice.isCustom?.trim() === '1' || !productCodes.has(code);
}

/** Q1b's own population: live, real, `code_product` NULL or empty. */
export function isQ1bPopulation(invoice: {
  readonly isTest: string | null;
  readonly codeProduct: string | null;
}): boolean {
  return invoice.isTest?.trim() === '0' && (invoice.codeProduct ?? '') === '';
}

/**
 * What the import map records for each candidate category (`legacy_table = 'invoice'`).
 *
 * - `RECORD` — the importer decided it, with a closed reason code that exists today.
 * - `PENDING_REASON_CODE` — the importer decided it, but the closed code that says why
 *   arrives with MAP-REVIEW's review queue (Item 9). Writing it under a nearby code would
 *   misfile it, so it is counted in the report and recorded once the code exists: flip the
 *   entry to `RECORD` in the commit that integrates the queue.
 * - `NOT_RECORDED_HERE` — no row by the importer: an invalid key cannot be a row, and an
 *   eligible candidate's row is P6's, written with the adoption it records.
 */
export type InvoiceMapDecision =
  | {
      readonly kind: 'RECORD';
      readonly status: 'SKIPPED' | 'MANUAL_REVIEW' | 'FAILED';
      readonly reasonCode: LegacyImportReasonCode;
    }
  | { readonly kind: 'PENDING_REASON_CODE'; readonly reason: string }
  | { readonly kind: 'NOT_RECORDED_HERE'; readonly why: 'KEY_INVALID' | 'ADOPTION' };

export const INVOICE_MAP_DECISIONS: Readonly<Record<ServiceCandidateCategory, InvoiceMapDecision>> =
  {
    INVOICE_KEY_INVALID: { kind: 'NOT_RECORDED_HERE', why: 'KEY_INVALID' },
    // A live legacy trial: not adopted by registered decision — history, not import.
    TEST_INVOICE_SKIPPED: { kind: 'RECORD', status: 'SKIPPED', reasonCode: 'HISTORY_NOT_IMPORTED' },
    TEST_PANEL_SKIPPED: { kind: 'RECORD', status: 'SKIPPED', reasonCode: 'TEST_PANEL' },
    INVALID_SOURCE_ROW: {
      kind: 'RECORD',
      status: 'MANUAL_REVIEW',
      reasonCode: 'INVALID_SOURCE_ROW',
    },
    INVALID_USERNAME: { kind: 'RECORD', status: 'MANUAL_REVIEW', reasonCode: 'INVALID_SOURCE_ROW' },
    ORPHAN: { kind: 'PENDING_REASON_CODE', reason: 'CUSTOMER_MISSING' },
    CUSTOMER_NOT_IMPORTED: { kind: 'PENDING_REASON_CODE', reason: 'CUSTOMER_MISSING' },
    // Not a decision: the inventory read did not complete. FAILED is "process again".
    INVENTORY_INCOMPLETE: { kind: 'RECORD', status: 'FAILED', reasonCode: 'PROVIDER_READ_FAILED' },
    PROVIDER_MISSING: { kind: 'RECORD', status: 'MANUAL_REVIEW', reasonCode: 'PROVIDER_MISSING' },
    AMBIGUOUS_PANEL: { kind: 'RECORD', status: 'MANUAL_REVIEW', reasonCode: 'AMBIGUOUS_PANEL' },
    PANEL_UNMAPPED: { kind: 'RECORD', status: 'MANUAL_REVIEW', reasonCode: 'PANEL_UNMAPPED' },
    USERNAME_CASE_COLLISION: {
      kind: 'RECORD',
      status: 'MANUAL_REVIEW',
      reasonCode: 'USERNAME_CASE_COLLISION',
    },
    UNSUPPORTED_SHAPE: { kind: 'PENDING_REASON_CODE', reason: 'UNSUPPORTED_SHAPE' },
    PRODUCT_UNRESOLVED: { kind: 'PENDING_REASON_CODE', reason: 'PRODUCT_MAPPING_UNRESOLVED' },
    ADOPTION_ELIGIBLE: { kind: 'NOT_RECORDED_HERE', why: 'ADOPTION' },
  };
