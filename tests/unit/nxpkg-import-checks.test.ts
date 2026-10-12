import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LEGACY_NXPKG_ERROR_CODES, money } from '@nexa/contracts';
import {
  canonicalJson,
  parseStrictJson,
} from '../../apps/api/src/infrastructure/nxpkg/canonical-json';
import { deriveDecisionsKey } from '../../apps/api/src/infrastructure/nxpkg/decisions';
import { openNxpkg, type NxpkgPackage } from '../../apps/api/src/infrastructure/nxpkg/reader';
import {
  checkNxpkgForImport,
  isSupportedNxpkgContract,
  type NxpkgContent,
} from '../../apps/api/src/modules/platform/legacy-importer/application/nxpkg-acceptance';
import {
  nxpkgOwnershipHold,
  ownershipHoldDigest,
  type VerifiedOwnershipDecisions,
} from '../../apps/api/src/modules/platform/legacy-importer/application/nxpkg-ownership';
import {
  NxpkgImportRefused,
  buildPanelMappingFromTargets,
  validatePanelMappingAgainstTargets,
} from '../../apps/api/src/modules/platform/legacy-importer/application/nxpkg-panel-binding';
import { parsePanelMapping } from '../../apps/api/src/modules/platform/legacy-importer/application/panel-mapping';
import {
  decideAllServices,
  inventoryIndexes,
  planLegacyImport,
  planTalliesDigest,
} from '../../apps/api/src/modules/platform/legacy-importer/application/plan';
import { readFromSession } from '../../apps/api/src/modules/platform/legacy-importer/application/source-snapshot';
import { FixtureLegacySourceConnector } from '../../apps/api/src/modules/platform/legacy-importer/infrastructure/fixture-legacy-source';
import { NxpkgLegacySourceConnector } from '../../apps/api/src/modules/platform/legacy-importer/infrastructure/nxpkg-legacy-source';
import {
  readOwnershipRecords,
  verifyOwnershipDecisions,
} from '../../apps/api/src/modules/platform/legacy-importer/infrastructure/nxpkg-ownership-decisions';
import {
  PACKAGE_SECRET_VALUE_REFUSAL,
  PASSWORD_FLAG_REFUSAL,
  isPasswordFlag,
} from '../../apps/api/src/legacy-import-argv';
import { UsageError, packageSecretFromEnv, parseArgs } from '../../apps/api/src/legacy-import.cli';
import { buildSyntheticLegacyDataset } from '../fixtures/legacy/synthetic-legacy';
import { syntheticInventories, syntheticMappingFile } from '../fixtures/legacy/synthetic-support';
import { signDecisionsExport } from '../support/nxpkg/writer';
import { READY_MANIFEST, snapshotOfDataset } from '../support/nxpkg-legacy-package';

/**
 * Mirza `.nxpkg` importer — the package acceptance checks (design §1), the panel binding
 * (§1, principle 4), the ownership decisions (§7) and the hold they produce, and the CLI's
 * argv rules for the package secret. SYNTHETIC data only; the decisions fixture is the
 * converter's own (Python) signed export for its own synthetic package.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const PANEL_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PANEL_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MARZBAN = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const FIXTURES = join(__dirname, '../fixtures/nxpkg');

let root: string;
let pkg: NxpkgPackage;
let keyFileText: string;
let decisionsText: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'nxpkg-checks-'));
  keyFileText = await readFile(join(FIXTURES, 'synthetic-keyfile.nxkey'), 'utf8');
  decisionsText = await readFile(join(FIXTURES, 'ownership-decisions.json'), 'utf8');
  pkg = await openNxpkg(
    join(FIXTURES, 'synthetic-keyfile.nxpkg'),
    { keyFileText },
    {
      workDir: root,
      maxPayloadBytes: 64 * 1024 * 1024,
      maxFiles: 1000,
      maxFileBytes: 64 * 1024 * 1024,
    },
  );
});
afterAll(async () => {
  await pkg?.close();
  await rm(root, { recursive: true, force: true });
});

// --- an in-memory package ---------------------------------------------------------------------

type Files = Record<string, unknown>;

function memory(manifest: Record<string, unknown>, files: Files): NxpkgContent {
  return {
    manifest,
    files: () =>
      Object.keys(files)
        .sort()
        .map((path) => ({ path })),
    has: (rel) => Object.hasOwn(files, rel),
    readJson: (rel) => Promise.resolve(files[rel]),
    iterJsonl: (rel) =>
      (async function* () {
        for (const r of files[rel] as Record<string, unknown>[]) yield r;
      })(),
  };
}

function readyPackage(extra: Files = {}, manifest: Record<string, unknown> = {}): NxpkgContent {
  const parts = snapshotOfDataset(buildSyntheticLegacyDataset() as never);
  return memory(
    {
      package_schema: 'nexa.migration.mirza',
      import_id: '0123456789abcdef0123456789abcdef',
      source_fingerprint: 'f'.repeat(64),
      ...READY_MANIFEST,
      ...manifest,
    },
    {
      'source/catalog.json': parts.catalog,
      'source/tables/user.jsonl': parts.tables.user,
      'source/tables/invoice.jsonl': parts.tables.invoice,
      'source/tables/product.jsonl': parts.tables.product,
      ...extra,
    },
  );
}

const codes = async (p: NxpkgContent) => (await checkNxpkgForImport(p)).problems.map((x) => x.code);

describe('checkNxpkgForImport', () => {
  it('a ready 1.4.0 package passes; so does the converter-written fixture package', async () => {
    expect(await checkNxpkgForImport(readyPackage())).toEqual({ ok: true, problems: [] });
    // The converter's own synthetic package: every live flag false, every target RickPanel or
    // none — the scan has no false positive on real converter output.
    expect(await checkNxpkgForImport(pkg)).toEqual({ ok: true, problems: [] });
  });

  it('NXPKG_UNSUPPORTED_VERSION: below 1.4.0, another major, a pre-release, another schema', async () => {
    for (const v of ['1.3.0', '1.3.9', '2.0.0', '0.9.0', '1.4.0-rc1', '1.4', 'x']) {
      expect(isSupportedNxpkgContract(v), v).toBe(false);
      expect(await codes(readyPackage({}, { package_schema_version: v })), v).toContain(
        'NXPKG_UNSUPPORTED_VERSION',
      );
    }
    for (const v of ['1.4.0', '1.4.1', '1.10.0']) expect(isSupportedNxpkgContract(v), v).toBe(true);
    expect(await codes(readyPackage({}, { package_schema: 'other' }))).toEqual([
      'NXPKG_UNSUPPORTED_VERSION',
    ]);
  });

  it('NXPKG_NOT_READY: readiness not ready, or any blocker', async () => {
    expect(await codes(readyPackage({}, { readiness: 'blocked' }))).toEqual(['NXPKG_NOT_READY']);
    expect(await codes(readyPackage({}, { blockers: ['SOURCE_SNAPSHOT_KEY_INVALID'] }))).toEqual([
      'NXPKG_NOT_READY',
    ]);
    expect(await codes(readyPackage({}, { blockers: undefined }))).toEqual(['NXPKG_NOT_READY']);
  });

  it('NXPKG_MONEY_UNIT: rial, a rescaled amount, another currency, no money block', async () => {
    for (const money of [
      { declared_unit: 'rial', currency: 'IRR', rescaled: false },
      { declared_unit: 'toman', currency: 'IRT', rescaled: true },
      { declared_unit: 'toman', currency: 'IRR', rescaled: false },
      undefined,
    ]) {
      expect(await codes(readyPackage({}, { money })), JSON.stringify(money)).toEqual([
        'NXPKG_MONEY_UNIT',
      ]);
    }
  });

  it('NXPKG_SOURCE_SNAPSHOT_MISSING: no catalogue, an invalid one, a missing rows file', async () => {
    const without = readyPackage();
    const files = {
      'source/tables/user.jsonl': [],
    };
    expect(await codes(memory(without.manifest as Record<string, unknown>, files))).toEqual([
      'NXPKG_SOURCE_SNAPSHOT_MISSING',
    ]);
    expect(await codes(readyPackage({ 'source/catalog.json': { format: 'nope' } }))).toEqual([
      'NXPKG_SOURCE_SNAPSHOT_MISSING',
    ]);
    const parts = snapshotOfDataset(buildSyntheticLegacyDataset() as never);
    const noProduct = memory(readyPackage().manifest as Record<string, unknown>, {
      'source/catalog.json': parts.catalog,
      'source/tables/user.jsonl': parts.tables.user,
      'source/tables/invoice.jsonl': parts.tables.invoice,
    });
    expect(await codes(noProduct)).toEqual(['NXPKG_SOURCE_SNAPSHOT_MISSING']);
  });

  it('NXPKG_CONTAINER_INVALID: no import_id or source_fingerprint', async () => {
    expect(await codes(readyPackage({}, { import_id: '' }))).toEqual(['NXPKG_CONTAINER_INVALID']);
    expect(await codes(readyPackage({}, { source_fingerprint: undefined }))).toEqual([
      'NXPKG_CONTAINER_INVALID',
    ]);
  });

  it('PANEL_TARGET_MISMATCH: a target that is not RickPanel', async () => {
    const target = (t: Record<string, unknown> | null) => ({
      record_type: 'legacy_panel_target',
      code_panel: 'x',
      target: t,
    });
    expect(
      await codes(
        readyPackage({
          'records/panel_target_mapping.jsonl': [
            target(null),
            target({ provider_type: 'rickpanel', provider_display_name: 'RickPanel' }),
          ],
        }),
      ),
    ).toEqual([]);
    for (const bad of [
      { provider_type: 'marzban', provider_display_name: 'Marzban' },
      { provider_type: 'rickpanel', provider_display_name: 'RIC Panel' },
      { provider_type: 'RickPanel', provider_display_name: 'RickPanel' },
    ]) {
      expect(
        await codes(readyPackage({ 'records/panel_target_mapping.jsonl': [target(bad)] })),
        JSON.stringify(bad),
      ).toEqual(['PANEL_TARGET_MISMATCH']);
    }
  });

  it('NXPKG_LIVE_FLAG: any live-state flag that is not false, at any depth, in any record file', async () => {
    const ok = { record_type: 'customer', provision: false, affects_wallet: false };
    expect(await codes(readyPackage({ 'records/customers.jsonl': [ok, ok] }))).toEqual([]);
    for (const [file, rec] of [
      ['records/customers.jsonl', { ...ok, provision: true }],
      ['records/services.jsonl', { record_type: 'x', nested: { creates_payment: true } }],
      ['records/agents/state.jsonl', { record_type: 'x', role_active: 'true' }],
      ['records/legacy_debts.jsonl', { record_type: 'x', list: [{ grants_credit: 1 }] }],
      ['records/payments.jsonl', { record_type: 'x', counts_as_revenue: null }],
    ] as const) {
      const result = await checkNxpkgForImport(readyPackage({ [file]: [ok, rec] }));
      expect(result.ok, file).toBe(false);
      expect(
        result.problems.map((p) => p.code),
        file,
      ).toEqual(['NXPKG_LIVE_FLAG']);
      expect(result.problems[0]?.detail).toContain(file);
    }
  });

  it('every code it emits is a contract error code', async () => {
    const all = await checkNxpkgForImport(
      readyPackage(
        { 'records/x.jsonl': [{ provision: true }] },
        { readiness: 'no', money: null, package_schema_version: '1.0.0', import_id: null },
      ),
    );
    for (const p of all.problems) expect(LEGACY_NXPKG_ERROR_CODES).toContain(p.code);
    expect(new Set(all.problems.map((p) => p.code))).toEqual(
      new Set([
        'NXPKG_UNSUPPORTED_VERSION',
        'NXPKG_CONTAINER_INVALID',
        'NXPKG_NOT_READY',
        'NXPKG_MONEY_UNIT',
        'NXPKG_LIVE_FLAG',
      ]),
    );
  });
});

// --- panel binding ----------------------------------------------------------------------------

const panel = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  tenantId: TENANT,
  providerType: 'rickpanel',
  status: 'ACTIVE',
  archived: false,
  ...over,
});
const PANELS = [panel(PANEL_A), panel(PANEL_B), panel(MARZBAN, { providerType: 'marzban' })];

function targetRecord(code: string, target: Record<string, unknown> | null) {
  const connect = target?.['nexa_panel_id'] ?? null;
  return {
    record_type: 'legacy_panel_target',
    schema: 'm2n.legacy_panel_target.v1',
    idempotency_key: `legacy:panel-target:${code}`,
    code_panel: code,
    target:
      target === null
        ? null
        : {
            provider_type: 'rickpanel',
            provider_display_name: 'RickPanel',
            provider_version_declared: '1.0.0',
            nexa_panel_id: null,
            binding:
              connect === null ? 'CREATE_IN_NEXA_THEN_CONNECT' : 'CONNECT_EXISTING_NEXA_PANEL',
            decided_by: 'operator',
            evidence: [],
            ...target,
          },
    mapping_state: target === null ? 'OPERATOR_MUST_MAP' : 'TARGET_SELECTED',
    nexa_panel_map_entry: connect === null ? null : { codePanel: code, panelId: connect },
    credentials_in_package: false,
    services_reprovisioned: false,
    provision: false,
    applies_to_live_state: false,
  };
}

function refusedWith(fn: () => unknown): readonly string[] {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(NxpkgImportRefused);
    expect((e as NxpkgImportRefused).code).toBe('PANEL_TARGET_MISMATCH');
    return (e as NxpkgImportRefused).problems;
  }
  throw new Error('expected a refusal');
}

describe('buildPanelMappingFromTargets', () => {
  const targets = [
    targetRecord('rp1', {}),
    targetRecord('rp2', { nexa_panel_id: PANEL_B }),
    targetRecord('later', null),
    targetRecord('(no code_panel)', null),
  ];

  it('binds rickpanel targets to ACTIVE RickPanels, declares the rest OWNER_DECIDES_LATER, and the importer accepts the result', () => {
    const out = buildPanelMappingFromTargets({
      tenantId: TENANT,
      targets,
      bindings: { rp1: PANEL_A, rp2: PANEL_B },
      tenantPanels: PANELS,
    });
    expect(JSON.parse(out.text)).toEqual({
      format: 'nexa-legacy-panel-map/v1',
      tenantId: TENANT,
      panels: [
        { codePanel: 'rp1', panelId: PANEL_A },
        { codePanel: 'rp2', panelId: PANEL_B },
      ],
      testPanels: [],
      missingPanels: [],
      unresolvedPanels: [{ codePanel: 'later', reason: 'OWNER_DECIDES_LATER' }],
      productionPanels: [PANEL_A, PANEL_B].sort(),
      products: [],
    });
    expect(out.unresolved).toEqual(['later']);
    // The importer's own parser gives the same fingerprint for the same text.
    expect(parsePanelMapping(out.text, TENANT).fingerprint).toBe(out.mapping.fingerprint);
  });

  it('refuses a binding onto a Marzban panel, an unknown, disabled, archived or other-tenant panel', () => {
    for (const [bound, panels, why] of [
      [MARZBAN, PANELS, /marzban panel, not a RickPanel/u],
      ['dddddddd-dddd-4ddd-8ddd-dddddddddddd', PANELS, /does not have/u],
      [PANEL_A, [panel(PANEL_A, { status: 'DISABLED' }), panel(PANEL_B)], /not ACTIVE/u],
      [PANEL_A, [panel(PANEL_A, { archived: true }), panel(PANEL_B)], /not ACTIVE/u],
      [PANEL_A, [panel(PANEL_A, { tenantId: 'other' }), panel(PANEL_B)], /does not have/u],
    ] as const) {
      const problems = refusedWith(() =>
        buildPanelMappingFromTargets({
          tenantId: TENANT,
          targets,
          bindings: { rp1: bound, rp2: PANEL_B },
          tenantPanels: panels as never,
        }),
      );
      expect(problems.join('\n')).toMatch(why);
    }
  });

  it('refuses a CONNECT_EXISTING target bound to another panel than its own nexa_panel_id', () => {
    expect(
      refusedWith(() =>
        buildPanelMappingFromTargets({
          tenantId: TENANT,
          targets,
          bindings: { rp1: PANEL_A, rp2: PANEL_A },
          tenantPanels: PANELS,
        }),
      ).join('\n'),
    ).toMatch(/another panel than the package's target/u);
  });

  it('refuses an unbound target, a bound code without a target, an unknown code, a non-rickpanel target, the empty-code bucket', () => {
    const cases: [Record<string, string>, readonly Record<string, unknown>[], RegExp][] = [
      [{ rp2: PANEL_B }, targets, /has a RickPanel target and is not bound/u],
      [
        { rp1: PANEL_A, rp2: PANEL_B, later: PANEL_A },
        targets,
        /no RickPanel target in the package/u,
      ],
      [{ rp1: PANEL_A, rp2: PANEL_B, ghost: PANEL_A }, targets, /does not list/u],
      [
        { rp1: PANEL_A },
        [
          {
            ...targetRecord('rp1', {}),
            target: { ...targetRecord('rp1', {}).target, provider_type: 'marzban' },
          },
        ],
        /not RickPanel/u,
      ],
      [
        { rp1: PANEL_A, '(no code_panel)': PANEL_A },
        [targetRecord('rp1', {}), targetRecord('(no code_panel)', null)],
        /empty-code bucket/u,
      ],
      [{}, [targetRecord('later', null)], /nothing to import services onto/u],
      [{ rp1: PANEL_A }, [targetRecord('rp1', {}), targetRecord('rp1', {})], /two target records/u],
    ];
    for (const [bindings, list, why] of cases) {
      expect(
        refusedWith(() =>
          buildPanelMappingFromTargets({
            tenantId: TENANT,
            targets: list,
            bindings,
            tenantPanels: PANELS,
          }),
        ).join('\n'),
        String(why),
      ).toMatch(why);
    }
  });
});

// --- ownership decisions ----------------------------------------------------------------------

describe('validatePanelMappingAgainstTargets (H2: a given --panel-map for a package)', () => {
  const targets = [
    targetRecord('rp1', {}),
    targetRecord('rp2', { nexa_panel_id: PANEL_B }),
    targetRecord('later', null),
    targetRecord('(no code_panel)', null),
  ];
  const built = buildPanelMappingFromTargets({
    tenantId: TENANT,
    targets,
    bindings: { rp1: PANEL_A, rp2: PANEL_B },
    tenantPanels: PANELS,
    products: [{ codeProduct: 'p1', productId: PANEL_A }],
  });
  const check = (file: Record<string, unknown>) =>
    validatePanelMappingAgainstTargets({
      tenantId: TENANT,
      targets,
      mapping: parsePanelMapping(JSON.stringify(file), TENANT),
      tenantPanels: PANELS,
    });
  const base = JSON.parse(built.text) as Record<string, any>;

  it("accepts exactly the targets' own map, reformatted or reordered, products passed through", () => {
    expect(check(base).mapping.fingerprint).toBe(built.mapping.fingerprint);
    expect(check({ ...base, panels: [...base['panels']].reverse() }).mapping.fingerprint).toBe(
      built.mapping.fingerprint,
    );
  });

  it('refuses a test or missing panel, a moved unresolved code, an unbound target, a non-RickPanel or another panel', () => {
    const refused = (file: Record<string, unknown>) => refusedWith(() => check(file));
    const noLater = { ...base, unresolvedPanels: undefined };
    refused({ ...noLater, testPanels: ['later'] });
    refused({ ...noLater, missingPanels: ['later'] });
    refused({
      ...base,
      unresolvedPanels: [
        ...base['unresolvedPanels'],
        { codePanel: 'extra', reason: 'UNKNOWN_ORIGIN' },
      ],
    });
    refused({
      ...base,
      panels: [{ codePanel: 'rp2', panelId: PANEL_B }],
      unresolvedPanels: [
        { codePanel: 'later', reason: 'OWNER_DECIDES_LATER' },
        { codePanel: 'rp1', reason: 'OWNER_DECIDES_LATER' },
      ],
      productionPanels: [PANEL_B],
    });
    refused({
      ...base,
      panels: [
        { codePanel: 'rp1', panelId: MARZBAN },
        { codePanel: 'rp2', panelId: PANEL_B },
      ],
      productionPanels: [MARZBAN, PANEL_B].sort(),
    });
    refused({
      ...base,
      panels: [
        { codePanel: 'rp1', panelId: PANEL_A },
        { codePanel: 'rp2', panelId: PANEL_A },
      ],
      productionPanels: [PANEL_A],
    });
  });
});

describe('legacy-import --expected-plan-tallies-digest', () => {
  const argv = (mode: string, ...extra: string[]) => [
    mode,
    '--tenant',
    'acme',
    '--target',
    'nexa_test',
    '--panel-map',
    'map.json',
    '--source',
    'nxpkg:/srv/p.nxpkg',
    '--package-key-env',
    'K',
    '--evidence-class',
    'synthetic',
    ...extra,
  ];
  it('import only, a lowercase SHA-256', () => {
    const d = 'a'.repeat(64);
    expect(parseArgs(argv('import', '--expected-plan-tallies-digest', d))).toMatchObject({
      expectedPlanTalliesDigest: d,
    });
    expect(parseArgs(argv('import'))).toMatchObject({ expectedPlanTalliesDigest: null });
    expect(() => parseArgs(argv('resume', '--expected-plan-tallies-digest', d))).toThrow(
      /import only/u,
    );
    expect(() =>
      parseArgs(argv('import', '--expected-plan-tallies-digest', 'A'.repeat(64))),
    ).toThrow(UsageError);
  });
});

describe('verifyOwnershipDecisions', () => {
  const secret = () => ({ keyFileText });
  const doc = () => parseStrictJson(decisionsText) as Record<string, any>;
  async function resign(mutate: (d: Record<string, any>) => void): Promise<string> {
    const d = doc();
    mutate(d);
    const key = await deriveDecisionsKey(join(FIXTURES, 'synthetic-keyfile.nxpkg'), secret());
    return JSON.stringify(signDecisionsExport(d, key));
  }
  const refusal = (text: string) =>
    verifyOwnershipDecisions(text, pkg, secret()).then(
      () => null,
      (e: unknown) => e,
    );
  const expectRefused = async (text: string, why: RegExp) => {
    const e = await refusal(text);
    expect(e).toBeInstanceOf(NxpkgImportRefused);
    expect((e as NxpkgImportRefused).code).toBe('DECISIONS_INVALID');
    expect((e as NxpkgImportRefused).problems.join('\n')).toMatch(why);
  };
  const redigest = (d: Record<string, any>) => {
    const digest = createHash('sha256').update(canonicalJson(d.entries)).digest('hex');
    d.entries_digest = digest;
    d.sealed_digest = digest;
  };

  it("verifies the converter's own signed export for its own package", async () => {
    const verified = await verifyOwnershipDecisions(decisionsText, pkg, secret());
    expect(verified.summary).toEqual({
      items: 19,
      PROVEN: 7,
      ADMIN_APPROVED_UNVERIFIED: 4,
      PENDING: 2,
      REJECTED: 0,
      QUARANTINED: 6,
      stale: 0,
    });
    // A re-signed, unchanged document verifies too (the test signer is the Python one's twin).
    await expect(
      verifyOwnershipDecisions(await resign(() => undefined), pkg, secret()),
    ).resolves.toMatchObject({
      entriesDigest: verified.entriesDigest,
    });
  });

  it('refuses a tampered document (MAC), the wrong package key, another import, another package header, another source', async () => {
    const tampered = doc();
    tampered.summary.PROVEN = 8;
    await expectRefused(JSON.stringify(tampered), /HMAC does not verify/u);
    const unsigned = doc();
    delete unsigned.authentication;
    await expectRefused(JSON.stringify(unsigned), /unsigned/u);
    await expect(
      verifyOwnershipDecisions(decisionsText, pkg, { passphrase: 'not the key' }),
    ).rejects.toMatchObject({ code: 'NXPKG_WRONG_KEY' });
    await expectRefused(
      await resign((d) => (d.import_id = 'ffffffffffffffffffffffffffffffff')),
      /another import/u,
    );
    await expectRefused(
      await resign((d) => (d.package_header_sha256 = 'a'.repeat(64))),
      /another package/u,
    );
    await expectRefused(
      await resign((d) => (d.source_fingerprint = 'b'.repeat(64))),
      /another source/u,
    );
  });

  it('refuses unsealed, changed-after-seal, a broken audit, divergence, attestation-as-proof', async () => {
    await expectRefused(await resign((d) => (d.sealed = false)), /not sealed/u);
    await expectRefused(await resign((d) => (d.matches_seal = false)), /changed after/u);
    await expectRefused(await resign((d) => (d.audit.ok = false)), /audit chain/u);
    await expectRefused(await resign((d) => (d.sealed_divergence = 1)), /records changed/u);
    await expectRefused(await resign((d) => (d.admin_attestation_is_proof = true)), /proof/u);
    await expectRefused(await resign((d) => (d.sealed_digest = 'c'.repeat(64))), /sealed entries/u);
  });

  it('refuses a binding that is not the package record, an unknown class or field, a summary that lies, a missing entry', async () => {
    await expectRefused(
      await resign((d) => {
        d.entries[0].binding = 'd'.repeat(64);
        redigest(d);
      }),
      /binding/u,
    );
    await expectRefused(
      await resign((d) => {
        d.entries[0].class = 'MAYBE';
        redigest(d);
      }),
      /unknown class/u,
    );
    await expectRefused(
      await resign((d) => {
        d.entries[0].basis = 'EVIDENCE';
        d.entries[0].class = 'ADMIN_APPROVED_UNVERIFIED';
        redigest(d);
      }),
      /basis/u,
    );
    await expectRefused(await resign((d) => (d.extra = 1)), /field the converter never writes/u);
    await expectRefused(
      await resign((d) => {
        d.entries[0].note = 'x';
        redigest(d);
      }),
      /unexpected set of fields/u,
    );
    await expectRefused(
      await resign((d) => {
        const removed = d.entries.pop();
        d.summary.items -= 1;
        d.summary[removed.class] -= 1;
        redigest(d);
      }),
      /not the same set/u,
    );
    await expectRefused(await resign((d) => (d.summary.QUARANTINED = 5)), /summary/u);
  });

  it('the hold: QUARANTINED / REJECTED / PENDING / stale held; ADMIN_APPROVED_UNVERIFIED attested, never proven; PROVEN only when its owner is the invoice owner', async () => {
    const verified = await verifyOwnershipDecisions(decisionsText, pkg, secret());
    const connector = await NxpkgLegacySourceConnector.fromPackage(pkg);
    const snapshot = await readFromSession(connector.label, await connector.open());
    const { facts } = await readOwnershipRecords(pkg);
    const out = nxpkgOwnershipHold({
      records: facts,
      decisions: verified,
      liveInvoices: snapshot.liveInvoices,
    });
    const classOf = (invoice: string) =>
      [...verified.entries.values()].find((e) => e.invoiceKey === invoice)?.class;
    const baselineHeld = (invoice: { idInvoice: string; idUser: string | null }) => {
      const f = facts.filter((r) => r.invoiceKey === invoice.idInvoice);
      return !(
        f.length === 1 &&
        ['CONFIRMED_CURRENT_OWNER', 'CONFIRMED_TRANSFER', 'NO_CONFLICT'].includes(
          f[0]?.decision ?? '',
        ) &&
        f[0]?.finalOwner === invoice.idUser
      );
    };
    let attestedHeld = 0;
    for (const invoice of snapshot.liveInvoices) {
      const cls = classOf(invoice.idInvoice);
      if (cls === 'PENDING' || cls === 'QUARANTINED' || cls === 'REJECTED') {
        expect(out.hold.has(invoice.idInvoice), cls).toBe(true);
      }
      if (cls === 'ADMIN_APPROVED_UNVERIFIED') {
        // Reported as attested, never proven — and the attestation never lifts the
        // package evidence's own hold.
        expect(out.attested.has(invoice.idInvoice)).toBe(true);
        expect(out.proven.has(invoice.idInvoice)).toBe(false);
        expect(out.hold.has(invoice.idInvoice)).toBe(baselineHeld(invoice));
        if (baselineHeld(invoice)) attestedHeld += 1;
      }
      if (cls === 'PROVEN') {
        expect(out.proven.has(invoice.idInvoice)).toBe(!baselineHeld(invoice));
        expect(out.hold.has(invoice.idInvoice)).toBe(baselineHeld(invoice));
      }
    }
    // The converter's fixture attests unproven (AMBIGUOUS_*) records: they stay held.
    expect(attestedHeld).toBeGreaterThan(0);
    // Every live invoice is exactly one of: held, proven, attested (and not held).
    expect(out.hold.size + out.proven.size + out.attested.size - attestedHeld).toBe(
      snapshot.liveInvoices.length,
    );
    expect(Object.values(out.reasons).reduce((a, b) => a + (b ?? 0), 0)).toBe(out.hold.size);
    expect(out.reasons).toMatchObject({ DECISION_PENDING: 2 });

    // A stale entry is held whatever its class.
    const stale: VerifiedOwnershipDecisions = {
      ...verified,
      entries: new Map([...verified.entries].map(([k, e]) => [k, { ...e, stale: true }])),
    };
    const allStale = nxpkgOwnershipHold({
      records: facts,
      decisions: stale,
      liveInvoices: snapshot.liveInvoices,
    });
    expect(allStale.hold.size).toBe(snapshot.liveInvoices.length);

    // Without decisions: only CONFIRMED_* / NO_CONFLICT pass; AMBIGUOUS_* are held.
    const bare = nxpkgOwnershipHold({
      records: facts,
      decisions: null,
      liveInvoices: snapshot.liveInvoices,
    });
    expect(bare.attested.size).toBe(0);
    for (const f of facts) {
      if (f.invoiceKey === null || !snapshot.liveInvoices.some((i) => i.idInvoice === f.invoiceKey))
        continue;
      expect(bare.hold.has(f.invoiceKey), String(f.decision)).toBe(
        !['CONFIRMED_CURRENT_OWNER', 'CONFIRMED_TRANSFER', 'NO_CONFLICT'].includes(
          f.decision ?? '',
        ),
      );
    }
    // A proof about somebody else is no proof for an adoption onto id_user.
    const other = nxpkgOwnershipHold({
      records: facts.map((f) => ({ ...f, finalOwner: f.finalOwner === null ? null : '1' })),
      decisions: null,
      liveInvoices: snapshot.liveInvoices,
    });
    expect(other.proven.size).toBe(0);
    expect(other.reasons.PROVEN_OWNER_IS_NOT_INVOICE_OWNER).toBe(bare.proven.size);
    // A live invoice without an ownership record is held.
    expect(
      nxpkgOwnershipHold({ records: [], decisions: null, liveInvoices: snapshot.liveInvoices }).hold
        .size,
    ).toBe(snapshot.liveInvoices.length);
  });
});

// --- the hold inside the importer's decision ---------------------------------------------------

describe('decideAllServices with an ownership hold', () => {
  async function plan(ownershipHold?: ReadonlySet<string>) {
    const connector = new FixtureLegacySourceConnector(buildSyntheticLegacyDataset() as never);
    const snapshot = await readFromSession(connector.label, await connector.open());
    const mapping = parsePanelMapping(syntheticMappingFile(TENANT, PANEL_A, PANEL_B), TENANT);
    return {
      snapshot,
      out: planLegacyImport({
        snapshot,
        mapping,
        salesCurrency: 'IRT',
        existingCustomers: new Map(),
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
        ...(ownershipHold === undefined ? {} : { review: { ownershipHold } }),
      } as never),
      mapping,
    };
  }

  it('a held ELIGIBLE invoice becomes AMBIGUOUS_OWNERSHIP (map MANUAL_REVIEW); everything else is unchanged; it never adds an adoption', async () => {
    const before = await plan();
    const eligible = before.out.services.filter((s) => s.decision.category === 'ADOPTION_ELIGIBLE');
    expect(eligible.length).toBeGreaterThan(1);
    const held = eligible[0]?.invoice.idInvoice as string;
    const notEligible = before.out.services.find(
      (s) => s.decision.category !== 'ADOPTION_ELIGIBLE',
    );
    const hold = new Set([held, notEligible?.invoice.idInvoice as string]);
    const after = await plan(hold);
    for (const s of after.out.services) {
      const was = before.out.services.find((b) => b.invoice.idInvoice === s.invoice.idInvoice);
      if (s.invoice.idInvoice === held) {
        expect(s.decision.category).toBe('AMBIGUOUS_OWNERSHIP');
        expect((s.decision as { map: { status: string } }).map.status).toBe('MANUAL_REVIEW');
      } else {
        expect(s.decision).toEqual(was?.decision);
      }
    }
    // The same through decideAllServices directly (what the adoption phase calls).
    const direct = (ownershipHold?: ReadonlySet<string>) =>
      decideAllServices(
        after.snapshot,
        after.mapping,
        inventoryIndexes(after.mapping, syntheticInventories(PANEL_A, PANEL_B)),
        new Map(after.snapshot.users.map((u) => [u.id, u.id])),
        () => 'RESOLVED',
        ownershipHold === undefined ? {} : { ownershipHold },
      );
    const unheld = direct();
    const first = unheld.services.find((s) => s.decision.category === 'ADOPTION_ELIGIBLE');
    const directHeld = first?.invoice.idInvoice as string;
    const withHold = direct(new Set([directHeld]));
    expect(
      withHold.services.find((s) => s.invoice.idInvoice === directHeld)?.decision.category,
    ).toBe('AMBIGUOUS_OWNERSHIP');
    expect(withHold.categories.ADOPTION_ELIGIBLE).toBe(unheld.categories.ADOPTION_ELIGIBLE - 1);
    expect(withHold.categories.AMBIGUOUS_OWNERSHIP).toBe(unheld.categories.AMBIGUOUS_OWNERSHIP + 1);
    // `sections.ownershipHold.changedCategory`: only an ELIGIBLE invoice the hold changed.
    expect(unheld.ownershipHoldChanged).toBe(0);
    expect(withHold.ownershipHoldChanged).toBe(1);
    expect(before.out.ownershipHoldChanged).toBe(0);
    expect(after.out.ownershipHoldChanged).toBe(1);
    // A hold only on an invoice that was not eligible changes no category.
    expect(direct(new Set([notEligible?.invoice.idInvoice as string])).ownershipHoldChanged).toBe(
      0,
    );
  });

  it('planTalliesDigest: stable, key-order free, and moved by any tally (the hold included)', async () => {
    const before = await plan();
    const d = planTalliesDigest(before.out);
    expect(d).toMatch(/^[0-9a-f]{64}$/u);
    expect(planTalliesDigest((await plan()).out)).toBe(d);
    // Key order does not matter; a bigint is not a number.
    const reordered = JSON.parse(
      JSON.stringify(before.out.tallies, (_k, v: unknown) =>
        typeof v === 'bigint' ? { __big: v.toString() } : v,
      ),
      (_k, v: unknown) =>
        v !== null && typeof v === 'object' && '__big' in (v as object)
          ? BigInt((v as { __big: string }).__big)
          : v,
    ) as Record<string, unknown>;
    const reversed = Object.fromEntries(Object.entries(reordered).reverse());
    expect(planTalliesDigest({ tallies: reversed as never })).toBe(d);
    const wallet = before.out.tallies.wallet;
    expect(
      planTalliesDigest({
        tallies: {
          ...before.out.tallies,
          wallet: { ...wallet, legacySumMinor: wallet.legacySumMinor + 1n },
        },
      }),
    ).not.toBe(d);
    expect(
      planTalliesDigest({
        tallies: {
          ...before.out.tallies,
          wallet: { ...wallet, legacySumMinor: Number(wallet.legacySumMinor) as never },
        },
      }),
    ).not.toBe(d);
    const eligible = before.out.services.find((s) => s.decision.category === 'ADOPTION_ELIGIBLE');
    expect(
      planTalliesDigest((await plan(new Set([eligible?.invoice.idInvoice as string]))).out),
    ).not.toBe(d);
  });
});

// --- the hold, record by record (H3) -------------------------------------------------------------

describe('nxpkgOwnershipHold: a decision only ever adds to the evidence hold', () => {
  const invoice = { idInvoice: 'i1', idUser: '100' };
  const record = (decision: string | null, finalOwner: string | null = '100') => ({
    key: 'k1',
    invoiceKey: 'i1',
    decision,
    finalOwner,
  });
  const decisions = (
    cls: VerifiedOwnershipDecisions['entries'] extends ReadonlyMap<string, infer E>
      ? E extends { class: infer C }
        ? C
        : never
      : never,
    stale = false,
  ): VerifiedOwnershipDecisions => ({
    summary: {
      items: 1,
      PROVEN: 0,
      ADMIN_APPROVED_UNVERIFIED: 0,
      PENDING: 0,
      REJECTED: 0,
      QUARANTINED: 0,
      stale: 0,
    },
    entriesDigest: 'e'.repeat(64),
    auditHead: null,
    entries: new Map([
      ['k1', { key: 'k1', invoiceKey: 'i1', class: cls, basis: 'X', batchId: null, stale }],
    ]),
  });
  const hold = (r: ReturnType<typeof record>, d: VerifiedOwnershipDecisions | null) =>
    nxpkgOwnershipHold({ records: [r], decisions: d, liveInvoices: [invoice] });

  it('no decisions: an unproven record is held; a proven one for id_user is not', () => {
    expect(hold(record('AMBIGUOUS_OWNER', null), null)).toMatchObject({
      reasons: { OWNERSHIP_NOT_PROVEN: 1 },
    });
    expect(hold(record('AMBIGUOUS_OWNER', null), null).hold.has('i1')).toBe(true);
    const proven = hold(record('CONFIRMED_CURRENT_OWNER'), null);
    expect(proven.hold.size).toBe(0);
    expect(proven.proven.has('i1')).toBe(true);
    expect(hold(record('CONFIRMED_CURRENT_OWNER', '999'), null).reasons).toEqual({
      PROVEN_OWNER_IS_NOT_INVOICE_OWNER: 1,
    });
  });

  it('ADMIN_APPROVED_UNVERIFIED never removes the baseline hold; it is still reported as attested', () => {
    const attested = hold(record('AMBIGUOUS_OWNER', null), decisions('ADMIN_APPROVED_UNVERIFIED'));
    expect(attested.hold.has('i1')).toBe(true);
    expect(attested.attested.has('i1')).toBe(true);
    expect(attested.proven.size).toBe(0);
    expect(attested.reasons).toEqual({ OWNERSHIP_NOT_PROVEN: 1 });
    // Attested over a proof for another owner: still held.
    expect(
      hold(record('CONFIRMED_TRANSFER', '999'), decisions('ADMIN_APPROVED_UNVERIFIED')).hold.has(
        'i1',
      ),
    ).toBe(true);
    // Only where the evidence itself proves the record for id_user is it left to NEXA's rules,
    // and even then it is attested, never proven.
    const clean = hold(record('NO_CONFLICT'), decisions('ADMIN_APPROVED_UNVERIFIED'));
    expect(clean.hold.size).toBe(0);
    expect(clean.attested.has('i1')).toBe(true);
    expect(clean.proven.size).toBe(0);
  });

  it('a PROVEN decision does not lift the baseline either; a REJECTED / stale decision holds a proven record', () => {
    expect(hold(record('AMBIGUOUS_OWNER', null), decisions('PROVEN')).hold.has('i1')).toBe(true);
    const rejected = hold(record('CONFIRMED_CURRENT_OWNER'), decisions('REJECTED'));
    expect(rejected.hold.has('i1')).toBe(true);
    expect(rejected.reasons).toEqual({ DECISION_REJECTED: 1 });
    expect(rejected.proven.size).toBe(0);
    expect(hold(record('CONFIRMED_CURRENT_OWNER'), decisions('PROVEN', true)).reasons).toEqual({
      DECISION_STALE: 1,
    });
    const ok = hold(record('CONFIRMED_CURRENT_OWNER'), decisions('PROVEN'));
    expect(ok.hold.size).toBe(0);
    expect(ok.proven.has('i1')).toBe(true);
  });

  it('ownershipHoldDigest binds the sorted hold and the decisions digest', () => {
    const a = ownershipHoldDigest(new Set(['b', 'a']), null);
    expect(a).toMatch(/^[0-9a-f]{64}$/u);
    expect(ownershipHoldDigest(new Set(['a', 'b']), null)).toBe(a);
    expect(ownershipHoldDigest(new Set(['a']), null)).not.toBe(a);
    expect(ownershipHoldDigest(new Set(['a', 'b']), 'e'.repeat(64))).not.toBe(a);
    expect(ownershipHoldDigest(new Set(), null)).not.toBe(ownershipHoldDigest(new Set(), 'none2'));
  });
});

// --- the CLI's argv rules ---------------------------------------------------------------------

describe('legacy-import --source nxpkg: argv', () => {
  const base = [
    'dry-run',
    '--tenant',
    'acme',
    '--target',
    'nexa_test',
    '--panel-map',
    'map.json',
    '--source',
    'nxpkg:/srv/p.nxpkg',
  ];
  const refused = (argv: readonly string[]) => {
    try {
      parseArgs(argv);
    } catch (e) {
      expect(e).toBeInstanceOf(UsageError);
      return (e as Error).message;
    }
    throw new Error('expected a usage error');
  };

  it('needs exactly one of --package-key-env / --package-passphrase-env, each naming a variable', () => {
    expect(refused(base)).toMatch(/exactly one of/u);
    expect(refused([...base, '--package-key-env', 'A', '--package-passphrase-env', 'B'])).toMatch(
      /exactly one of/u,
    );
    expect(refused([...base, '--package-key-env', 'lower'])).toMatch(/name a variable/u);
    expect(parseArgs([...base, '--package-key-env', 'NXPKG_KEY'])).toMatchObject({
      source: 'nxpkg:/srv/p.nxpkg',
      packageKeyEnv: 'NXPKG_KEY',
      packagePassphraseEnv: null,
    });
    expect(parseArgs([...base, '--package-passphrase-env', 'NXPKG_PASS'])).toMatchObject({
      packagePassphraseEnv: 'NXPKG_PASS',
    });
  });

  it('never accepts a package secret on argv: no --package-key / --passphrase flags, no key text as a value', () => {
    for (const flag of [
      '--package-key',
      '--package-passphrase',
      '--passphrase',
      '--key-file',
      '--package-key-file',
      '--package-key-envx',
    ]) {
      expect(isPasswordFlag(flag), flag).toBe(true);
      expect(refused([...base, flag, 'x']), flag).toBe(PASSWORD_FLAG_REFUSAL);
    }
    for (const ok of ['--package-key-env', '--package-passphrase-env', '--source-password-env']) {
      expect(isPasswordFlag(ok), ok).toBe(false);
    }
    expect(refused([...base, '--package-key-env', 'K', '--out', 'nxkey1:AAAA'])).toBe(
      PACKAGE_SECRET_VALUE_REFUSAL,
    );
  });

  it('the package flags apply to an nxpkg: source only; the secret is read from the named variable', () => {
    expect(
      refused([
        'dry-run',
        '--tenant',
        'acme',
        '--target',
        'nexa_test',
        '--panel-map',
        'm.json',
        '--source',
        'fixture:/x.json',
        '--package-key-env',
        'K',
      ]),
    ).toMatch(/nxpkg: source only/u);
    expect(
      packageSecretFromEnv({ packageKeyEnv: 'K', packagePassphraseEnv: null }, { K: 'nxkey1:x' }),
    ).toEqual({
      keyFileText: 'nxkey1:x',
    });
    expect(
      packageSecretFromEnv({ packageKeyEnv: null, packagePassphraseEnv: 'P' }, { P: 'pw' }),
    ).toEqual({
      passphrase: 'pw',
    });
    expect(() =>
      packageSecretFromEnv({ packageKeyEnv: 'K', packagePassphraseEnv: null }, {}),
    ).toThrow(/K is not set/u);
  });
});
