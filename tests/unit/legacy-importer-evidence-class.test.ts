import { describe, expect, it } from 'vitest';
import { UsageError, parseArgs, wantsHelp } from '../../apps/api/src/legacy-import.cli';
import { decideEvidenceClass } from '../../apps/api/src/modules/platform/legacy-importer/application/production-guard';
import type { LegacySourceSession } from '../../apps/api/src/modules/platform/legacy-importer/application/source-port';
import { readFromSession } from '../../apps/api/src/modules/platform/legacy-importer/application/source-snapshot';
import { FixtureLegacySourceConnector } from '../../apps/api/src/modules/platform/legacy-importer/infrastructure/fixture-legacy-source';
import {
  buildSyntheticLegacyDataset,
  syntheticLegacySql,
} from '../fixtures/legacy/synthetic-legacy';

/**
 * Migration P7 — a SYNTHETIC run can never be labelled staging or production
 * (`docs/legacy-migration/importer.md` §Evidence class). The label is decided against the
 * source's own marker (`nexa_synthetic_fixture`), not against how the source was named.
 */

describe('the evidence class', () => {
  it('a synthetic-marked source is synthetic, whatever is claimed or wherever it runs', () => {
    expect(
      decideEvidenceClass({ claim: null, syntheticSource: true, productionLikeTarget: false }),
    ).toEqual({
      ok: true,
      evidenceClass: 'synthetic',
    });
    expect(
      decideEvidenceClass({
        claim: 'synthetic',
        syntheticSource: true,
        productionLikeTarget: false,
      }),
    ).toMatchObject({ ok: true, evidenceClass: 'synthetic' });
    for (const claim of ['staging', 'production'] as const) {
      expect(
        decideEvidenceClass({ claim, syntheticSource: true, productionLikeTarget: false }).ok,
      ).toBe(false);
    }
    // A production-like target is refused outright, even with the honest claim.
    expect(
      decideEvidenceClass({ claim: 'synthetic', syntheticSource: true, productionLikeTarget: true })
        .ok,
    ).toBe(false);
  });

  it('a real source is never synthetic, and production needs a production-like target', () => {
    expect(
      decideEvidenceClass({
        claim: 'synthetic',
        syntheticSource: false,
        productionLikeTarget: false,
      }).ok,
    ).toBe(false);
    expect(
      decideEvidenceClass({
        claim: 'production',
        syntheticSource: false,
        productionLikeTarget: false,
      }).ok,
    ).toBe(false);
    expect(
      decideEvidenceClass({
        claim: 'production',
        syntheticSource: false,
        productionLikeTarget: true,
      }),
    ).toMatchObject({ ok: true, evidenceClass: 'production' });
    // A staging server running NODE_ENV=production is production-like and still staging.
    expect(
      decideEvidenceClass({ claim: 'staging', syntheticSource: false, productionLikeTarget: true }),
    ).toMatchObject({ ok: true, evidenceClass: 'staging' });
    expect(
      decideEvidenceClass({ claim: null, syntheticSource: false, productionLikeTarget: false }),
    ).toMatchObject({
      evidenceClass: 'staging',
    });
  });

  it('import, resume and report require the claim; the value is closed', () => {
    const base = [
      '--tenant',
      'acme',
      '--source',
      'env:L',
      '--target',
      'env:T',
      '--panel-map',
      'm.json',
    ];
    for (const mode of ['import', 'resume', 'report']) {
      expect(() => parseArgs([mode, ...base])).toThrow(/--evidence-class is required/u);
      expect(parseArgs([mode, ...base, '--evidence-class', 'staging']).evidenceClass).toBe(
        'staging',
      );
    }
    expect(parseArgs(['audit', ...base]).evidenceClass).toBeNull();
    expect(() => parseArgs(['audit', ...base, '--evidence-class', 'real'])).toThrow(UsageError);
  });

  it('--help is asked for anywhere in argv', () => {
    expect(wantsHelp(['--help'])).toBe(true);
    expect(wantsHelp(['import', '-h'])).toBe(true);
    expect(wantsHelp(['review', 'list', '--help'])).toBe(true);
    expect(wantsHelp(['import', '--tenant', 'acme'])).toBe(false);
  });
});

describe('the SYNTHETIC marker', () => {
  it('every synthetic SQL load carries it, labelled', () => {
    const sql = syntheticLegacySql(buildSyntheticLegacyDataset());
    expect(sql).toContain('CREATE TABLE `nexa_synthetic_fixture`');
    expect(sql).toMatch(/INSERT INTO `nexa_synthetic_fixture` \(`label`\) VALUES \('SYNTHETIC/u);
  });

  it('the snapshot reads it, and a marked copy never fingerprints as the unmarked rows', async () => {
    const connector = new FixtureLegacySourceConnector(buildSyntheticLegacyDataset() as never);
    const marked = await readFromSession(connector.label, await connector.open());
    expect(marked.synthetic).toBe(true);
    expect(marked.syntheticLabel).toContain('SYNTHETIC');
    const session = await connector.open();
    const unmarked: LegacySourceSession = {
      ...session,
      syntheticMarker: () => Promise.resolve(null),
    };
    const real = await readFromSession('as if real', unmarked);
    expect(real.synthetic).toBe(false);
    expect(real.tables).toEqual(marked.tables);
    expect(real.fingerprint).not.toBe(marked.fingerprint);
  });
});
