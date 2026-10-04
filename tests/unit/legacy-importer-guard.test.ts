import { describe, expect, it } from 'vitest';
import {
  UsageError,
  exitCodeFor,
  guardTarget,
  parseArgs,
  resolveSpec,
  resolveTarget,
  targetIdentity,
} from '../../apps/api/src/legacy-import.cli';
import {
  classifyTarget,
  evaluateProductionGuard,
  targetAcknowledgement,
} from '../../apps/api/src/modules/platform/legacy-importer/application/production-guard';

/**
 * Migration P7 — the CLI's refusals and the hard production guard
 * (`docs/legacy-migration/importer.md` §CLI, §Guard). Both run before any connection is
 * opened; these are the tests that say so.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const BASE = [
  '--mode',
  'dry-run',
  '--tenant',
  TENANT,
  '--source',
  'env:LEGACY_DSN',
  '--target',
  'env:NEXA_TARGET',
  '--panel-map',
  'map.json',
];

function without(flag: string): string[] {
  const i = BASE.indexOf(flag);
  return [...BASE.slice(0, i), ...BASE.slice(i + 2)];
}

describe('parseArgs: nothing defaults', () => {
  it('accepts the complete set', () => {
    expect(parseArgs(BASE)).toMatchObject({
      mode: 'dry-run',
      tenant: TENANT,
      source: 'env:LEGACY_DSN',
      target: 'env:NEXA_TARGET',
      panelMap: 'map.json',
      allowProductionTarget: false,
      out: null,
    });
  });

  for (const flag of ['--mode', '--tenant', '--source', '--target', '--panel-map']) {
    it(`refuses a missing ${flag}`, () => {
      expect(() => parseArgs(without(flag))).toThrow(UsageError);
      expect(() => parseArgs(without(flag))).toThrow(/no default/u);
    });
  }

  it('refuses an unknown mode, a bad tenant, an unknown flag and a repeated one', () => {
    const at = (flag: string, value: string) => {
      const args = [...BASE];
      args[args.indexOf(flag) + 1] = value;
      return args;
    };
    expect(() => parseArgs(at('--mode', 'apply'))).toThrow(UsageError);
    expect(() => parseArgs(at('--tenant', 'Primary Tenant'))).toThrow(UsageError);
    expect(() => parseArgs([...BASE, '--force'])).toThrow(/Unknown argument/u);
    expect(() => parseArgs([...BASE, '--mode', 'audit'])).toThrow(/twice/u);
  });

  it('never accepts a password on the command line', () => {
    const at = (flag: string, value: string) => {
      const args = [...BASE];
      args[args.indexOf(flag) + 1] = value;
      return args;
    };
    expect(() => parseArgs(at('--source', 'mysql://ro:secret@db:3306/oldbot'))).toThrow(
      /password/u,
    );
    expect(() => parseArgs(at('--target', 'postgres://nexa:secret@db/nexa_staging'))).toThrow(
      /password/u,
    );
    expect(() => parseArgs([...BASE, '--password', 'x'])).toThrow(/password/u);
    expect(() => parseArgs([...BASE, '--source-password', 'x'])).toThrow(/password/u);
    // A password-less DSN, with its password from a NAMED variable, is fine.
    expect(
      parseArgs([
        ...at('--source', 'mysql://ro@db:3306/oldbot'),
        '--source-password-env',
        'LEGACY_PW',
      ]).sourcePasswordEnv,
    ).toBe('LEGACY_PW');
  });

  it('accepts only the declared source and target forms', () => {
    const at = (flag: string, value: string) => {
      const args = [...BASE];
      args[args.indexOf(flag) + 1] = value;
      return args;
    };
    expect(() => parseArgs(at('--source', 'oldbot'))).toThrow(UsageError);
    expect(() => parseArgs(at('--target', 'Nexa DB'))).toThrow(UsageError);
    expect(() => parseArgs(at('--source', 'env:lower'))).toThrow(UsageError);
    expect(
      parseArgs(at('--source', 'fixture:tests/fixtures/legacy/synthetic-legacy.json')).source,
    ).toMatch(/^fixture:/u);
  });

  it('--abort-running applies to resume only', () => {
    expect(() => parseArgs([...BASE, '--abort-running'])).toThrow(UsageError);
    const resume = [...BASE];
    resume[1] = 'resume';
    expect(
      parseArgs([...resume, '--abort-running', '--evidence-class', 'staging']).abortRunning,
    ).toBe(true);
  });

  it('takes the mode positionally or as --mode, never both, and a slug or uuid tenant', () => {
    const positional = ['import', ...without('--mode'), '--evidence-class', 'staging'];
    expect(parseArgs(positional).mode).toBe('import');
    expect(() => parseArgs(['import', ...BASE])).toThrow(/twice/u);
    expect(() => parseArgs(['apply', ...without('--mode')])).toThrow(UsageError);
    const slug = [...BASE];
    slug[slug.indexOf('--tenant') + 1] = 'acme';
    expect(parseArgs(slug).tenant).toBe('acme');
    expect(parseArgs([...BASE, '--format', 'json']).format).toBe('json');
    expect(parseArgs(BASE).format).toBe('md');
    expect(() => parseArgs([...BASE, '--format', 'xml'])).toThrow(UsageError);
  });

  it('a bare database name is a confirmation of DATABASE_URL, never a default', () => {
    const env = { DATABASE_URL: 'postgres://nexa@db:5432/nexa_staging' };
    expect(resolveTarget('nexa_staging', env)).toBe(env.DATABASE_URL);
    expect(() => resolveTarget('nexa_other', env)).toThrow(/does not match/u);
    expect(() => resolveTarget('nexa_staging', {})).toThrow(/DATABASE_URL/u);
    expect(resolveTarget('postgres://u@h/d', env)).toBe('postgres://u@h/d');
  });

  it('resolves env: specs and refuses an unset variable', () => {
    expect(resolveSpec('env:X', { X: 'postgres://a@b/c' })).toBe('postgres://a@b/c');
    expect(() => resolveSpec('env:X', {})).toThrow(UsageError);
    expect(resolveSpec('postgres://a@b/c', {})).toBe('postgres://a@b/c');
  });
});

describe('the production guard', () => {
  const staging = { host: 'db', port: '5432', database: 'nexa_staging' };
  const prod = { host: 'db', port: '5432', database: 'nexa' };

  it('classifies conservatively: production-like unless every sign says otherwise', () => {
    expect(classifyTarget(staging, {}).productionLike).toBe(false);
    expect(classifyTarget({ ...staging, database: 'nexa_p4_import' }, {}).productionLike).toBe(
      false,
    );
    expect(classifyTarget(prod, {}).productionLike).toBe(true);
    expect(classifyTarget({ ...staging, database: 'nexastaging' }, {}).productionLike).toBe(true);
    expect(classifyTarget({ ...staging, database: 'nexa_production' }, {}).productionLike).toBe(
      true,
    );
    // NODE_ENV=production makes even a staging-named database production-like.
    expect(classifyTarget(staging, { NODE_ENV: 'production' }).productionLike).toBe(true);
  });

  it('refuses a production-like target BY DEFAULT', () => {
    const verdict = evaluateProductionGuard({
      target: prod,
      tenantId: TENANT,
      env: {},
      allowProductionFlag: false,
      syntheticSource: false,
    });
    expect(verdict.allowed).toBe(false);
  });

  it('needs the flag AND the acknowledgement; either alone is refused', () => {
    const ack = targetAcknowledgement(prod, TENANT);
    const run = (flag: boolean, value: string | undefined) =>
      evaluateProductionGuard({
        target: prod,
        tenantId: TENANT,
        env: { NEXA_LEGACY_IMPORT_TARGET_ACK: value },
        allowProductionFlag: flag,
        syntheticSource: false,
      }).allowed;
    expect(run(true, undefined)).toBe(false);
    expect(run(false, ack)).toBe(false);
    expect(run(true, ack)).toBe(true);
  });

  it('binds the acknowledgement to the target AND the tenant', () => {
    const ackForStaging = targetAcknowledgement({ ...prod, database: 'nexa_staging' }, TENANT);
    const ackOtherTenant = targetAcknowledgement(prod, '22222222-2222-4222-8222-222222222222');
    const ackOtherHost = targetAcknowledgement({ ...prod, host: 'other' }, TENANT);
    for (const ack of [ackForStaging, ackOtherTenant, ackOtherHost]) {
      const verdict = evaluateProductionGuard({
        target: prod,
        tenantId: TENANT,
        env: { NEXA_LEGACY_IMPORT_TARGET_ACK: ack },
        allowProductionFlag: true,
        syntheticSource: false,
      });
      expect(verdict.allowed).toBe(false);
      if (!verdict.allowed) expect(verdict.message).toContain(targetAcknowledgement(prod, TENANT));
    }
    expect(targetAcknowledgement(prod, TENANT)).toMatch(/^[0-9a-f]{16}$/u);
  });

  it('refuses a SYNTHETIC source against a production-like target, acknowledged or not', () => {
    const verdict = evaluateProductionGuard({
      target: prod,
      tenantId: TENANT,
      env: { NEXA_LEGACY_IMPORT_TARGET_ACK: targetAcknowledgement(prod, TENANT) },
      allowProductionFlag: true,
      syntheticSource: true,
    });
    expect(verdict.allowed).toBe(false);
  });

  it('lets a non-production target through without any acknowledgement', () => {
    expect(
      evaluateProductionGuard({
        target: staging,
        tenantId: TENANT,
        env: {},
        allowProductionFlag: false,
        syntheticSource: true,
      }).allowed,
    ).toBe(true);
  });

  it('guardTarget is what the CLI applies, from the URL', () => {
    const args = parseArgs(BASE);
    expect(() => guardTarget(args, 'postgres://nexa@db:5432/nexa', {})).toThrow(UsageError);
    expect(() => guardTarget(args, 'postgres://nexa@db:5432/nexa_staging', {})).not.toThrow();
    expect(() =>
      guardTarget(args, 'postgres://nexa@db:5432/nexa_staging', { NODE_ENV: 'production' }),
    ).toThrow(UsageError);
    const armed = parseArgs([...BASE, '--allow-production-target']);
    const ack = targetAcknowledgement({ host: 'db', port: '5432', database: 'nexa' }, TENANT);
    expect(() =>
      guardTarget(armed, 'postgres://nexa@db:5432/nexa', { NEXA_LEGACY_IMPORT_TARGET_ACK: ack }),
    ).not.toThrow();
    expect(targetIdentity('postgres://u@h/d')).toEqual({ host: 'h', port: '5432', database: 'd' });
    expect(() => targetIdentity('mysql://u@h/d')).toThrow(UsageError);
  });

  it('exit codes: a run needing a person is not a clean exit', () => {
    const report = (verdict: string | null) =>
      ({ verdict }) as unknown as Parameters<typeof exitCodeFor>[0];
    expect(exitCodeFor(report('COMPLETED'))).toBe(0);
    expect(exitCodeFor(report('RECONCILED'))).toBe(0);
    expect(exitCodeFor(report('DISCREPANCY'))).toBe(3);
    expect(exitCodeFor(report('BLOCKED'))).toBe(3);
    expect(exitCodeFor(report('COMPLETED_ADOPTION_PENDING_P6'))).toBe(3);
  });
});
