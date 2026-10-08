import { describe, expect, it } from 'vitest';
import { LEGACY_IMPORT_REASON_CODES, isLegacyReviewReasonCode, money } from '@nexa/contracts';
import {
  INVOICE_MAP_DECISIONS,
  classifyLegacyPhone,
  decideLegacyUser,
  decideServiceCandidate,
  isQ1bPopulation,
  legacyIsAgent,
  legacyProfileUsername,
  needsHiddenShape,
  parseLegacyBalance,
  type ServiceDecisionContext,
} from '../../apps/api/src/modules/platform/legacy-importer/application/decisions';
import { classifyLegacyUserStatus } from '../../apps/api/src/modules/platform/legacy-importer/application/source-snapshot';
import {
  openingPlanFor,
  planLegacyImport,
} from '../../apps/api/src/modules/platform/legacy-importer/application/plan';
import { parsePanelMapping } from '../../apps/api/src/modules/platform/legacy-importer/application/panel-mapping';
import { readFromSession } from '../../apps/api/src/modules/platform/legacy-importer/application/source-snapshot';
import { FixtureLegacySourceConnector } from '../../apps/api/src/modules/platform/legacy-importer/infrastructure/fixture-legacy-source';
import {
  SYNTHETIC_EXISTING_CUSTOMER,
  SYNTHETIC_EXPECTED,
  buildSyntheticLegacyDataset,
} from '../fixtures/legacy/synthetic-legacy';
import { syntheticInventories, syntheticMappingFile } from '../fixtures/legacy/synthetic-support';

/**
 * Migration P7 — every per-row decision, pure (`docs/legacy-migration/importer.md`
 * §Decisions). The last block runs the whole plan over the SYNTHETIC dataset and holds it
 * to `SYNTHETIC_EXPECTED`, which names every branch the dataset was built to reach.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const PANEL_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PANEL_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('phone', () => {
  it('classifies and never keeps the value', () => {
    expect(classifyLegacyPhone(null)).toBe('ABSENT');
    expect(classifyLegacyPhone('none')).toBe('ABSENT');
    expect(classifyLegacyPhone(' NONE ')).toBe('ABSENT');
    expect(classifyLegacyPhone('0')).toBe('ABSENT');
    expect(classifyLegacyPhone('989121234567')).toBe('VALID');
    expect(classifyLegacyPhone('+989121234567')).toBe('VALID');
    expect(classifyLegacyPhone('09121234567')).toBe('VALID');
    expect(classifyLegacyPhone('call me')).toBe('INVALID');
    expect(classifyLegacyPhone('12')).toBe('INVALID');
    expect(classifyLegacyPhone('+98 912 123')).toBe('INVALID');
  });
});

describe('customers and balances', () => {
  it('reads a balance only as a whole number of Toman', () => {
    expect(parseLegacyBalance('50000')).toBe(50_000n);
    expect(parseLegacyBalance(' -20000 ')).toBe(-20_000n);
    expect(parseLegacyBalance('0')).toBe(0n);
    for (const bad of [null, '', '12.5', '1e3', 'abc', '--1', '+5']) {
      expect(parseLegacyBalance(bad), String(bad)).toBeNull();
    }
  });

  it('refuses an identity that is not a Telegram id, before anything else', () => {
    expect(
      decideLegacyUser({ id: 'not-a-telegram-id', balance: '100', status: 'ACTIVE' }, false),
    ).toEqual({
      kind: 'INVALID_IDENTITY',
    });
    expect(decideLegacyUser({ id: '0123', balance: '100', status: 'ACTIVE' }, false).kind).toBe(
      'INVALID_IDENTITY',
    );
    expect(
      decideLegacyUser({ id: '12345678901234567890', balance: '1', status: 'ACTIVE' }, false).kind,
    ).toBe('INVALID_IDENTITY');
  });

  it('sends an unreadable or out-of-range balance to manual review, never a guess', () => {
    expect(decideLegacyUser({ id: '100', balance: '12.5', status: 'ACTIVE' }, false)).toMatchObject(
      {
        kind: 'MANUAL_REVIEW',
        reason: 'BALANCE_UNREADABLE',
        mapReason: 'INVALID_SOURCE_ROW',
      },
    );
    expect(decideLegacyUser({ id: '100', balance: null, status: 'ACTIVE' }, true)).toMatchObject({
      kind: 'MANUAL_REVIEW',
      reason: 'BALANCE_UNREADABLE',
    });
    expect(
      decideLegacyUser({ id: '100', balance: '1000000000001', status: 'ACTIVE' }, false),
    ).toMatchObject({
      kind: 'MANUAL_REVIEW',
      reason: 'BALANCE_OUT_OF_RANGE',
    });
    expect(
      decideLegacyUser({ id: '100', balance: '-1000000000000', status: 'ACTIVE' }, false).kind,
    ).toBe('IMPORT');
  });

  it('imports positive, zero and negative balances, with the map warning they carry', () => {
    expect(decideLegacyUser({ id: '100', balance: '5', status: 'ACTIVE' }, false)).toMatchObject({
      kind: 'IMPORT',
      customer: 'NEW',
      openingKind: 'POSITIVE',
      balanceMinor: 5n,
      mapReason: null,
    });
    expect(decideLegacyUser({ id: '100', balance: '0', status: 'ACTIVE' }, false)).toMatchObject({
      openingKind: 'ZERO',
      mapReason: null,
    });
    expect(decideLegacyUser({ id: '100', balance: '-7', status: 'ACTIVE' }, false)).toMatchObject({
      openingKind: 'NEGATIVE',
      balanceMinor: -7n,
      mapReason: 'NEGATIVE_BALANCE',
    });
    expect(decideLegacyUser({ id: '100', balance: '-7', status: 'ACTIVE' }, true)).toMatchObject({
      customer: 'EXISTING',
      mapReason: 'EXISTING_CUSTOMER',
    });
  });

  it('OQ-LWD-07: a blocked legacy user is imported blocked, with the same money decision', () => {
    for (const balance of ['5', '0', '-7']) {
      const active = decideLegacyUser({ id: '100', balance, status: 'ACTIVE' }, false);
      const blocked = decideLegacyUser({ id: '100', balance, status: 'BLOCKED' }, false);
      expect(active).toMatchObject({ kind: 'IMPORT', blocked: false });
      expect(blocked).toEqual({ ...active, blocked: true });
    }
    expect(decideLegacyUser({ id: '100', balance: '5', status: 'BLOCKED' }, true)).toMatchObject({
      kind: 'IMPORT',
      customer: 'EXISTING',
      blocked: true,
    });
  });

  it('OQ-LWD-07: an unknown User_Status goes to manual review, never ACTIVE', () => {
    expect(decideLegacyUser({ id: '100', balance: '5', status: 'UNKNOWN' }, false)).toEqual({
      kind: 'MANUAL_REVIEW',
      reason: 'STATUS_UNKNOWN',
      mapReason: 'INVALID_SOURCE_ROW',
    });
    expect(decideLegacyUser({ id: '100', balance: '5', status: 'UNKNOWN' }, true).kind).toBe(
      'MANUAL_REVIEW',
    );
    // Identity still comes first.
    expect(decideLegacyUser({ id: 'x', balance: '5', status: 'UNKNOWN' }, false).kind).toBe(
      'INVALID_IDENTITY',
    );
  });

  it('OQ-LWD-07: only the two MirzaBot spellings are known, compared exactly', () => {
    expect(classifyLegacyUserStatus('Active')).toBe('ACTIVE');
    expect(classifyLegacyUserStatus('block')).toBe('BLOCKED');
    for (const raw of [
      null,
      '',
      'active',
      'ACTIVE',
      'Block',
      'BLOCK',
      ' block',
      'block ',
      'blocked',
      'toString',
      '__proto__',
    ]) {
      expect(classifyLegacyUserStatus(raw), String(raw)).toBe('UNKNOWN');
    }
  });

  it('keeps a profile username only when it is one; reports agents', () => {
    expect(legacyProfileUsername('alice_legacy')).toBe('alice_legacy');
    expect(legacyProfileUsername('@alice_legacy')).toBe('alice_legacy');
    expect(legacyProfileUsername('none')).toBeNull();
    expect(legacyProfileUsername('a b')).toBeNull();
    expect(legacyIsAgent('f')).toBe(false);
    expect(legacyIsAgent(null)).toBe(false);
    expect(legacyIsAgent('n')).toBe(true);
    expect(legacyIsAgent('n2')).toBe(true);
  });

  const real = (amountMinor: bigint) => ({ amountMinor, synthetic: false });

  it('plans an opening against what is already posted', () => {
    expect(openingPlanFor(5n, undefined)).toBe('POST');
    expect(openingPlanFor(0n, undefined)).toBe('ZERO_NO_ENTRY');
    expect(openingPlanFor(5n, 5n)).toBe('ALREADY_POSTED');
    expect(openingPlanFor(6n, 5n)).toBe('CONFLICT');
    expect(openingPlanFor(0n, 5n)).toBe('CONFLICT');
  });

  it('plans a NEGATIVE balance as a legacy debt, never a ledger entry (owner decision 6)', () => {
    expect(openingPlanFor(-5n, undefined)).toBe('RECORD_DEBT');
    expect(openingPlanFor(-5n, undefined, real(5n))).toBe('DEBT_ALREADY_RECORDED');
    // A different figure, in amount or in kind, is a conflict — never re-applied.
    expect(openingPlanFor(-6n, undefined, real(5n))).toBe('CONFLICT');
    expect(openingPlanFor(5n, undefined, real(5n))).toBe('CONFLICT');
    expect(openingPlanFor(0n, undefined, real(5n))).toBe('CONFLICT');
    expect(openingPlanFor(-5n, 5n)).toBe('CONFLICT');
    // A DEBIT opening the code before the decision wrote: left alone, never doubled.
    expect(openingPlanFor(-5n, -5n)).toBe('PRIOR_DEBIT_OPENING');
    expect(openingPlanFor(-6n, -5n)).toBe('CONFLICT');
  });

  it('plans a debt of another evidence class as a CONFLICT, as APPLY refuses it (Codex on #233)', () => {
    const synthetic = { amountMinor: 5n, synthetic: true };
    // A real snapshot meeting a synthetic debt of the same magnitude, and the reverse.
    expect(openingPlanFor(-5n, undefined, synthetic, false)).toBe('CONFLICT');
    expect(openingPlanFor(-5n, undefined, real(5n), true)).toBe('CONFLICT');
    expect(openingPlanFor(-5n, undefined, synthetic, true)).toBe('DEBT_ALREADY_RECORDED');
  });
});

describe('service candidates', () => {
  const mapping = parsePanelMapping(syntheticMappingFile(TENANT, PANEL_A, PANEL_B), TENANT);
  const reads = syntheticInventories(PANEL_A, PANEL_B);
  const indexes = new Map(
    [...reads].flatMap(([id, r]) => (r.ok && r.complete ? [[id, r.index] as const] : [])),
  );
  const ctx = (overrides: Partial<ServiceDecisionContext> = {}): ServiceDecisionContext => ({
    userIds: new Set(['1', '2']),
    importedUsers: new Map([['1', '1']]),
    policy: mapping.policy,
    inventories: indexes,
    productCodes: new Set(['p1']),
    productMap: new Map([['p1', 'prod-p1']]),
    tariffOf: () => 'RESOLVED',
    ...overrides,
  });
  const base = {
    idInvoice: 'a0000001',
    idUser: '1',
    username: 'svc_a1',
    isTest: '0',
    codePanel: 'rp1',
    codeProduct: null,
    volume: '30',
    serviceTime: '30',
    timeUnit: '',
    isCustom: '0',
  };

  it('takes each branch in order', () => {
    expect(decideServiceCandidate({ ...base, isTest: '1' }, ctx()).category).toBe(
      'TEST_INVOICE_SKIPPED',
    );
    expect(decideServiceCandidate({ ...base, isTest: 'x' }, ctx()).category).toBe(
      'INVALID_SOURCE_ROW',
    );
    expect(decideServiceCandidate({ ...base, idUser: '9' }, ctx()).category).toBe('ORPHAN');
    expect(decideServiceCandidate({ ...base, idUser: null }, ctx()).category).toBe('ORPHAN');
    expect(decideServiceCandidate({ ...base, idUser: '2' }, ctx()).category).toBe(
      'CUSTOMER_NOT_IMPORTED',
    );
    expect(decideServiceCandidate({ ...base, codePanel: 'tst' }, ctx()).category).toBe(
      'TEST_PANEL_SKIPPED',
    );
    expect(decideServiceCandidate({ ...base, username: '' }, ctx()).category).toBe(
      'INVALID_USERNAME',
    );
    expect(decideServiceCandidate({ ...base, codePanel: 'zzz' }, ctx()).category).toBe(
      'PANEL_UNMAPPED',
    );
    expect(decideServiceCandidate({ ...base, username: 'nobody' }, ctx()).category).toBe(
      'PROVIDER_MISSING',
    );
    expect(
      decideServiceCandidate({ ...base, codePanel: null, username: 'svc_shared' }, ctx()).category,
    ).toBe('AMBIGUOUS_PANEL');
    expect(decideServiceCandidate({ ...base, username: 'case_x' }, ctx()).category).toBe(
      'USERNAME_CASE_COLLISION',
    );
    expect(decideServiceCandidate({ ...base }, ctx({ inventories: new Map() })).category).toBe(
      'INVENTORY_INCOMPLETE',
    );
    expect(decideServiceCandidate({ ...base, timeUnit: 'month' }, ctx())).toMatchObject({
      category: 'UNSUPPORTED_SHAPE',
      shapeReason: 'TIME_UNIT_UNKNOWN',
    });
    expect(
      decideServiceCandidate({ ...base }, ctx({ tariffOf: () => 'UNRESOLVED' })).category,
    ).toBe('PRODUCT_UNRESOLVED');
  });

  it('an eligible candidate carries the panel, the exact provider spelling and the product path', () => {
    expect(
      decideServiceCandidate({ ...base, codePanel: null, username: 'SVC_NULLMATCH' }, ctx()),
    ).toMatchObject({
      category: 'ADOPTION_ELIGIBLE',
      panelId: PANEL_B,
      providerUsername: 'svc_nullmatch',
      telegramUserId: '1',
      product: { kind: 'HIDDEN_SHAPE', custom: false },
    });
    expect(decideServiceCandidate({ ...base, codeProduct: 'p1' }, ctx())).toMatchObject({
      category: 'ADOPTION_ELIGIBLE',
      product: { kind: 'NAMED_PRODUCT', codeProduct: 'p1', productId: 'prod-p1' },
    });
    // A named product the legacy table does not have, and a custom service naming one,
    // are both the hidden legacy product of their shape.
    expect(decideServiceCandidate({ ...base, codeProduct: 'gone' }, ctx())).toMatchObject({
      product: { kind: 'HIDDEN_SHAPE' },
    });
    expect(
      decideServiceCandidate({ ...base, codeProduct: 'p1', isCustom: '1' }, ctx()),
    ).toMatchObject({
      product: { kind: 'HIDDEN_SHAPE', custom: true },
    });
  });

  it('a named product the owner did not map is PRODUCT_MAPPING_UNRESOLVED, never a guess', () => {
    const unmapped = decideServiceCandidate(
      { ...base, codeProduct: 'p1' },
      ctx({ productMap: new Map() }),
    );
    if (unmapped.category === 'ADOPTION_ELIGIBLE') throw new Error('unexpectedly eligible');
    expect(unmapped.category).toBe('PRODUCT_UNRESOLVED');
    expect(unmapped.map).toMatchObject({
      status: 'MANUAL_REVIEW',
      reasonCode: 'PRODUCT_MAPPING_UNRESOLVED',
    });
    // The mapping is by exact code: a map for another code does not stand in for p1.
    expect(
      decideServiceCandidate(
        { ...base, codeProduct: 'p1' },
        ctx({ productMap: new Map([['P1', 'prod-p1']]) }),
      ).category,
    ).toBe('PRODUCT_UNRESOLVED');
  });

  it('an is_custom outside 0/1 is never a named product: it is held, as the shape path holds it', () => {
    for (const bad of ['2', 'yes', '', ' 1', null]) {
      const decision = decideServiceCandidate({ ...base, codeProduct: 'p1', isCustom: bad }, ctx());
      expect(decision, String(bad)).toMatchObject({
        category: 'UNSUPPORTED_SHAPE',
        shapeReason: 'IS_CUSTOM_INVALID',
        map: { status: 'MANUAL_REVIEW', reasonCode: 'UNSUPPORTED_SHAPE' },
      });
    }
    // The accepted spellings still decide as before.
    expect(
      decideServiceCandidate({ ...base, codeProduct: 'p1', isCustom: '0' }, ctx()),
    ).toMatchObject({ product: { kind: 'NAMED_PRODUCT' } });
    expect(
      decideServiceCandidate({ ...base, codeProduct: 'p1', isCustom: '1' }, ctx()),
    ).toMatchObject({ product: { kind: 'HIDDEN_SHAPE', custom: true } });
  });

  it('never matches by inbound id, prefix or fuzzy name', () => {
    expect(decideServiceCandidate({ ...base, username: 'svc_a' }, ctx()).category).toBe(
      'PROVIDER_MISSING',
    );
    expect(decideServiceCandidate({ ...base, username: 'svc_a1 ' }, ctx()).category).toBe(
      'INVALID_USERNAME',
    );
  });

  it('the hidden-shape population and Q1b population', () => {
    const codes = new Set(['p1']);
    expect(needsHiddenShape({ isTest: '0', codeProduct: null, isCustom: '0' }, codes)).toBe(true);
    expect(needsHiddenShape({ isTest: '0', codeProduct: 'p1', isCustom: '0' }, codes)).toBe(false);
    expect(needsHiddenShape({ isTest: '0', codeProduct: 'p1', isCustom: '1' }, codes)).toBe(true);
    expect(needsHiddenShape({ isTest: '0', codeProduct: 'p9', isCustom: '0' }, codes)).toBe(true);
    expect(needsHiddenShape({ isTest: '1', codeProduct: null, isCustom: '0' }, codes)).toBe(false);
    expect(isQ1bPopulation({ isTest: '0', codeProduct: '' })).toBe(true);
    expect(isQ1bPopulation({ isTest: '0', codeProduct: 'p9' })).toBe(false);
  });
});

describe('the plan over the SYNTHETIC dataset', () => {
  async function plan(
    existing: ReadonlyMap<string, string> = new Map([[SYNTHETIC_EXISTING_CUSTOMER, 'c-5']]),
  ) {
    const connector = new FixtureLegacySourceConnector(buildSyntheticLegacyDataset() as never);
    const snapshot = await readFromSession(connector.label, await connector.open());
    return planLegacyImport({
      snapshot,
      mapping: parsePanelMapping(syntheticMappingFile(TENANT, PANEL_A, PANEL_B), TENANT),
      salesCurrency: 'IRT',
      existingCustomers: existing,
      existingOpenings: new Map(),
      trialOverrides: new Map(),
      trialDecided: new Set(),
      existingShapes: new Map(),
      tariffCandidates: [
        {
          id: 'p-30',
          status: 'ACTIVE',
          audience: 'EVERYONE',
          durationDays: 30,
          trafficBytes: 30n * 1024n ** 3n,
          price: money(200_000n, 'IRT'),
          panelBound: true,
          categoryStatus: 'ACTIVE',
        },
      ],
      inventories: syntheticInventories(PANEL_A, PANEL_B),
    });
  }

  it('takes every branch the dataset was built for', async () => {
    const { tallies } = await plan();
    const u = SYNTHETIC_EXPECTED.users;
    expect(tallies.customers).toMatchObject({
      source: u.source,
      invalidIdentity: u.invalidIdentity,
      manualReview: u.manualReview,
      importable: u.imported,
      existing: u.existing,
      new: u.newCustomers,
      agents: u.agents,
      phone: u.phone,
    });
    expect(tallies.wallet.legacySumMinor).toBe(u.legacyBalanceSumMinor);
    expect(tallies.wallet.positive.count).toBe(u.opening.POSITIVE);
    expect(tallies.wallet.zero).toBe(u.opening.ZERO);
    expect(tallies.wallet.negative.count).toBe(u.opening.NEGATIVE);
    // Owner decision 6: the negative balance is a legacy debt, not a sixth posted entry.
    expect(tallies.wallet.openings).toEqual({
      POST: u.opening.POSITIVE,
      ALREADY_POSTED: 0,
      ZERO_NO_ENTRY: 2,
      CONFLICT: 0,
      RECORD_DEBT: u.opening.NEGATIVE,
      DEBT_ALREADY_RECORDED: 0,
      PRIOR_DEBIT_OPENING: 0,
    });
    expect(tallies.customers.duplicateSourceIds).toEqual({ ids: 0, rows: 0 });
    expect(tallies.trials).toMatchObject(u.trial);
    expect(tallies.services.candidates).toBe(SYNTHETIC_EXPECTED.services.candidates);
    expect(tallies.services.categories).toEqual(SYNTHETIC_EXPECTED.services.categories);
    const sum = Object.values(tallies.services.categories).reduce((a, b) => a + b, 0);
    expect(sum, 'every candidate falls in exactly one category').toBe(tallies.services.candidates);
    expect(tallies.services.unmappedCodePanels).toEqual({ zzz: 1 });
    expect(tallies.products).toMatchObject({
      distinctShapes: 6,
      q1bDistinctMappable: 6,
      newShapes: 6,
      unmappable: { TIME_UNIT_UNKNOWN: 1, VOLUME_ZERO: 1 },
      predictedTariff: { MATCHED: 5, NO_CURRENT_TARIFF: 1, AMBIGUOUS_TARIFF: 0 },
      namedProductCandidates: 1,
    });
  });

  it('an existing NEXA customer is matched, not created; without it the same user is new', async () => {
    const withExisting = await plan();
    const without = await plan(new Map());
    expect(withExisting.tallies.customers.existing).toBe(1);
    expect(without.tallies.customers.existing).toBe(0);
    expect(without.tallies.customers.new).toBe(SYNTHETIC_EXPECTED.users.imported);
  });

  it('an existing override is kept, and an already-decided customer is not decided again', async () => {
    const connector = new FixtureLegacySourceConnector(buildSyntheticLegacyDataset() as never);
    const snapshot = await readFromSession(connector.label, await connector.open());
    const common = {
      snapshot,
      mapping: parsePanelMapping(syntheticMappingFile(TENANT, PANEL_A, PANEL_B), TENANT),
      salesCurrency: 'IRT',
      existingCustomers: new Map([[SYNTHETIC_EXISTING_CUSTOMER, 'c-5']]),
      existingOpenings: new Map(),
      existingShapes: new Map(),
      tariffCandidates: [],
      inventories: syntheticInventories(PANEL_A, PANEL_B),
    };
    const kept = planLegacyImport({
      ...common,
      trialOverrides: new Map([['c-5', 3]]),
      trialDecided: new Set(),
    });
    expect(kept.tallies.trials.KEPT_EXISTING_OVERRIDE).toBe(1);
    const decided = planLegacyImport({
      ...common,
      trialOverrides: new Map(),
      trialDecided: new Set(['c-5']),
    });
    expect(decided.tallies.trials.ALREADY_DECIDED).toBe(1);
  });

  it('a posted opening of a different figure is a conflict, never re-posted', async () => {
    const connector = new FixtureLegacySourceConnector(buildSyntheticLegacyDataset() as never);
    const snapshot = await readFromSession(connector.label, await connector.open());
    const out = planLegacyImport({
      snapshot,
      mapping: parsePanelMapping(syntheticMappingFile(TENANT, PANEL_A, PANEL_B), TENANT),
      salesCurrency: 'IRT',
      existingCustomers: new Map(),
      existingOpenings: new Map([
        ['100000001', 50_000n],
        ['100000003', -1n],
      ]),
      trialOverrides: new Map(),
      trialDecided: new Set(),
      existingShapes: new Map(),
      tariffCandidates: [],
      inventories: syntheticInventories(PANEL_A, PANEL_B),
    });
    expect(out.tallies.wallet.openings).toMatchObject({ ALREADY_POSTED: 1, CONFLICT: 1, POST: 4 });
  });

  it('an incomplete inventory makes its candidates undecidable, never provider-missing', async () => {
    const connector = new FixtureLegacySourceConnector(buildSyntheticLegacyDataset() as never);
    const snapshot = await readFromSession(connector.label, await connector.open());
    const reads = syntheticInventories(PANEL_A, PANEL_B);
    reads.set(PANEL_A, { ok: true, complete: false, reason: 'WALKS_DIFFER' });
    const out = planLegacyImport({
      snapshot,
      mapping: parsePanelMapping(syntheticMappingFile(TENANT, PANEL_A, PANEL_B), TENANT),
      salesCurrency: 'IRT',
      existingCustomers: new Map(),
      existingOpenings: new Map(),
      trialOverrides: new Map(),
      trialDecided: new Set(),
      existingShapes: new Map(),
      tariffCandidates: [],
      inventories: reads,
    });
    expect(out.tallies.services.categories.INVENTORY_INCOMPLETE).toBeGreaterThan(0);
    expect(out.tallies.services.categories.PROVIDER_MISSING).toBe(0);
    expect(out.inventories.find((p) => p.panelId === PANEL_A)).toMatchObject({
      complete: false,
      reason: 'WALKS_DIFFER',
    });
  });
});

describe('the invoice key and what the map records', () => {
  it('a key outside the evidenced shape is its own category, before anything else', () => {
    const row = {
      idUser: null,
      username: '',
      isTest: '1',
      codePanel: null,
      codeProduct: null,
      volume: null,
      serviceTime: null,
      timeUnit: null,
      isCustom: null,
    };
    const ctx: ServiceDecisionContext = {
      userIds: new Set<string>(),
      importedUsers: new Map<string, string>(),
      policy: {
        knownPanels: new Map(),
        testPanels: new Set<string>(),
        missingPanels: new Set<string>(),
        productionPanelIds: [],
      },
      inventories: new Map(),
      productCodes: new Set<string>(),
      productMap: new Map<string, string>(),
      tariffOf: () => 'RESOLVED',
    };
    for (const bad of ['LEGACY-X1', 'inv0001', 'A1B2C3D4', '0123456a1b2', 'abc', '']) {
      expect(decideServiceCandidate({ ...row, idInvoice: bad }, ctx).category, bad).toBe(
        'INVOICE_KEY_INVALID',
      );
    }
    for (const good of ['7c1f', 'a1b2c3d4', '1700001b2c3d4e5', '1234567abcd']) {
      expect(decideServiceCandidate({ ...row, idInvoice: good }, ctx).category, good).toBe(
        'TEST_INVOICE_SKIPPED',
      );
    }
  });

  it('every decided category is RECORDED on the map, a review row always with a review reason', () => {
    const mapping = parsePanelMapping(syntheticMappingFile(TENANT, PANEL_A, PANEL_B), TENANT);
    const reads = syntheticInventories(PANEL_A, PANEL_B);
    const indexes = new Map(
      [...reads].flatMap(([id, r]) => (r.ok && r.complete ? [[id, r.index] as const] : [])),
    );
    const base = {
      idInvoice: 'a0000001',
      idUser: '1',
      username: 'svc_a1',
      isTest: '0',
      codePanel: 'rp1' as string | null,
      codeProduct: null,
      volume: '30',
      serviceTime: '30',
      timeUnit: '',
      isCustom: '0',
    };
    const ctx: ServiceDecisionContext = {
      userIds: new Set(['1', '2']),
      importedUsers: new Map([['1', '1']]),
      policy: mapping.policy,
      inventories: indexes,
      productCodes: new Set(['p1']),
      productMap: new Map([['p1', 'prod-p1']]),
      tariffOf: () => 'RESOLVED',
    };
    const cases: [Partial<typeof base>, Partial<ServiceDecisionContext>, string, string | null][] =
      [
        [{ isTest: '1' }, {}, 'SKIPPED', 'HISTORY_NOT_IMPORTED'],
        [{ isTest: 'x' }, {}, 'MANUAL_REVIEW', 'INVALID_SOURCE_ROW'],
        [{ idUser: '9' }, {}, 'MANUAL_REVIEW', 'CUSTOMER_MISSING'],
        [{ idUser: '2' }, {}, 'MANUAL_REVIEW', 'CUSTOMER_MISSING'],
        [{ codePanel: 'tst' }, {}, 'SKIPPED', 'TEST_PANEL'],
        [{ username: '' }, {}, 'MANUAL_REVIEW', 'INVALID_SOURCE_ROW'],
        [{}, { inventories: new Map() }, 'MANUAL_REVIEW', 'INVENTORY_INCOMPLETE'],
        [{ username: 'nobody' }, {}, 'MANUAL_REVIEW', 'PROVIDER_MISSING'],
        [{ codePanel: null, username: 'svc_shared' }, {}, 'MANUAL_REVIEW', 'AMBIGUOUS_PANEL'],
        [{ codePanel: 'zzz' }, {}, 'MANUAL_REVIEW', 'PANEL_UNMAPPED'],
        [{ username: 'case_x' }, {}, 'MANUAL_REVIEW', 'USERNAME_CASE_COLLISION'],
        [{ timeUnit: 'month' }, {}, 'MANUAL_REVIEW', 'UNSUPPORTED_SHAPE'],
        [{}, { tariffOf: () => 'UNRESOLVED' }, 'MANUAL_REVIEW', 'PRODUCT_MAPPING_UNRESOLVED'],
      ];
    for (const [row, over, status, reason] of cases) {
      const decision = decideServiceCandidate({ ...base, ...row }, { ...ctx, ...over });
      if (decision.category === 'ADOPTION_ELIGIBLE') throw new Error('unexpectedly eligible');
      expect(decision.map, decision.category).toMatchObject({ status, reasonCode: reason });
      if (decision.map?.status === 'MANUAL_REVIEW') {
        expect(isLegacyReviewReasonCode(decision.map.reasonCode), decision.category).toBe(true);
      }
    }
    // The one category that is not a row: the map cannot hold the key.
    const bad = decideServiceCandidate({ ...base, idInvoice: 'LEGACY-X1' }, ctx);
    expect(bad).toEqual({ category: 'INVOICE_KEY_INVALID', map: null });
    // Every review reason the importer writes exists in the closed set.
    const codes: readonly string[] = LEGACY_IMPORT_REASON_CODES;
    for (const rule of Object.values(INVOICE_MAP_DECISIONS))
      expect(codes).toContain(rule.reasonCode);
  });
});
