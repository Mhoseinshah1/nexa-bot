import {
  LEGACY_ID_PATTERNS,
  isLegacyImportKey,
  PAYMENT_AMOUNT_MAX_MINOR,
  telegramUserIdSchema,
  type LegacyImportReasonCode,
} from '@nexa/contracts';
import {
  legacyCustomFlag,
  legacyShapeKey,
  type LegacyShapeUnmappableReason,
} from '../../../commerce/catalog/application/legacy-shape.js';
import type { LegacyImportDecision } from '../../legacy-import/application/legacy-import-ports.js';
import { decisionForLegacyMatch } from '../../legacy-import/application/legacy-review-routing.js';
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
      /**
       * `DUPLICATE_SOURCE_ID` (Mirza PR4): the id is on more than one source row. Which
       * row's balance is the customer's is unknowable, so none is imported: one review row
       * (`INVALID_SOURCE_ROW`) stands for all of them, decided by the plan.
       */
      readonly reason: 'BALANCE_UNREADABLE' | 'BALANCE_OUT_OF_RANGE' | 'DUPLICATE_SOURCE_ID';
      readonly mapReason: LegacyImportReasonCode;
    }
  | {
      readonly kind: 'IMPORT';
      readonly telegramUserId: string;
      readonly customer: 'NEW' | 'EXISTING';
      readonly openingKind: LegacyOpeningKind;
      /** Signed legacy `Balance`, Toman = IRT minor units. */
      readonly balanceMinor: bigint;
      /**
       * The map row's warning, if any: `EXISTING_CUSTOMER`, else `NEGATIVE_BALANCE` (the
       * balance is held as a legacy debt, never a ledger entry — owner decision 6).
       */
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

/**
 * Whether the legacy user was an agent (reseller). Reported only, never granted: an agent is
 * imported as an ordinary customer — no reseller row, no tier, and never credit (there is
 * no reseller credit in NEXA). Making a legacy agent a NEXA reseller is the owner's
 * decision (`OQ-LWD-03`).
 */
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
  | { readonly kind: 'NAMED_PRODUCT'; readonly codeProduct: string; readonly productId: string }
  /** No product, a missing product, or a custom service: the hidden legacy product. */
  | { readonly kind: 'HIDDEN_SHAPE'; readonly shapeKey: string; readonly custom: boolean };

export type ServiceCandidateDecision =
  | {
      readonly category: Exclude<ServiceCandidateCategory, 'ADOPTION_ELIGIBLE'>;
      readonly shapeReason?: LegacyShapeUnmappableReason;
      /**
       * What the invoice's map row records. Null only for `INVOICE_KEY_INVALID`, whose key
       * the map cannot hold (`legacy_import_map_legacy_key_check`): it stays a counted
       * category and is in the report's manual-review total, never a row.
       */
      readonly map: LegacyImportDecision | null;
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
  /** The owner's explicit `code_product` → NEXA product map (the mapping file). */
  readonly productMap: ReadonlyMap<string, string>;
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
  if (!isLegacyImportKey('invoice', invoice.idInvoice)) {
    return { category: 'INVOICE_KEY_INVALID', map: null };
  }
  const isTest = invoice.isTest?.trim() ?? null;
  if (isTest === '1') return held('TEST_INVOICE_SKIPPED');
  if (isTest !== '0') return held('INVALID_SOURCE_ROW');

  if (invoice.idUser === null || !ctx.userIds.has(invoice.idUser)) return held('ORPHAN');
  const telegramUserId = ctx.importedUsers.get(invoice.idUser);
  if (telegramUserId === undefined) return held('CUSTOMER_NOT_IMPORTED');

  const match = matchLegacyService(
    { codePanel: legacyCodePanel(invoice.codePanel), username: invoice.username ?? '' },
    ctx.policy,
    ctx.inventories,
  );
  // The matcher's outcome is recorded exactly as the review queue's one translation says
  // (`decisionForLegacyMatch`); the category is only its name in the report.
  if (match.kind !== 'ELIGIBLE') {
    const map = decisionForLegacyMatch(match);
    const category: Exclude<ServiceCandidateCategory, 'ADOPTION_ELIGIBLE'> =
      match.kind === 'SKIPPED'
        ? 'TEST_PANEL_SKIPPED'
        : match.kind === 'INVALID'
          ? 'INVALID_USERNAME'
          : match.kind === 'UNDECIDABLE'
            ? 'INVENTORY_INCOMPLETE'
            : match.reason;
    return { category, map };
  }

  // The flag first, read exactly as the shape key reads it: a value outside 0/1 is the
  // shape path's IS_CUSTOM_INVALID, never a named product decided on a flag nobody read.
  const customFlag = legacyCustomFlag(invoice.isCustom);
  if (customFlag === null) {
    return {
      category: 'UNSUPPORTED_SHAPE',
      map: INVOICE_MAP_DECISIONS.UNSUPPORTED_SHAPE,
      shapeReason: 'IS_CUSTOM_INVALID',
    };
  }
  const codeProduct = invoice.codeProduct?.trim() ?? '';
  const custom = customFlag;
  let product: ServiceProductPath;
  if (codeProduct !== '' && !custom && ctx.productCodes.has(codeProduct)) {
    // A named legacy product renews as the NEXA product the owner mapped it to, and only
    // that: no mapping is PRODUCT_MAPPING_UNRESOLVED, never a product picked by shape.
    const productId = ctx.productMap.get(codeProduct);
    if (productId === undefined) return held('PRODUCT_UNRESOLVED');
    product = { kind: 'NAMED_PRODUCT', codeProduct, productId };
  } else {
    const keyed = legacyShapeKey({
      codePanel: invoice.codePanel,
      volume: invoice.volume,
      serviceTime: invoice.serviceTime,
      timeUnit: invoice.timeUnit,
      isCustom: invoice.isCustom,
    });
    if (!keyed.ok) {
      return {
        category: 'UNSUPPORTED_SHAPE',
        map: INVOICE_MAP_DECISIONS.UNSUPPORTED_SHAPE,
        shapeReason: keyed.reason,
      };
    }
    if (ctx.tariffOf(keyed.key) !== 'RESOLVED') return held('PRODUCT_UNRESOLVED');
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
 * The map decision of each category the importer decides WITHOUT the matcher
 * (`legacy_table = 'invoice'`). The matcher's own outcomes go through the review queue's
 * `decisionForLegacyMatch`; an eligible row's decision is P6's, written with the adoption.
 */
export const INVOICE_MAP_DECISIONS = {
  // A live legacy trial: not adopted by registered decision — history, not import.
  TEST_INVOICE_SKIPPED: { status: 'SKIPPED', reasonCode: 'HISTORY_NOT_IMPORTED' },
  INVALID_SOURCE_ROW: { status: 'MANUAL_REVIEW', reasonCode: 'INVALID_SOURCE_ROW' },
  ORPHAN: { status: 'MANUAL_REVIEW', reasonCode: 'CUSTOMER_MISSING' },
  CUSTOMER_NOT_IMPORTED: { status: 'MANUAL_REVIEW', reasonCode: 'CUSTOMER_MISSING' },
  UNSUPPORTED_SHAPE: { status: 'MANUAL_REVIEW', reasonCode: 'UNSUPPORTED_SHAPE' },
  PRODUCT_UNRESOLVED: { status: 'MANUAL_REVIEW', reasonCode: 'PRODUCT_MAPPING_UNRESOLVED' },
} as const satisfies Readonly<Record<string, LegacyImportDecision>>;

type HeldCategory = keyof typeof INVOICE_MAP_DECISIONS;

function held(category: HeldCategory): ServiceCandidateDecision {
  return { category, map: INVOICE_MAP_DECISIONS[category] };
}
