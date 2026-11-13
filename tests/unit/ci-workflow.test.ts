import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * The CI workflow's scheduling rules, checked before they matter.
 *
 * A workflow change cannot be run locally, and the failure these rules prevent
 * — a main commit whose CI was cancelled by the next merge, so the release gate
 * finds no passing run for the tagged SHA — only shows up on the day somebody
 * tries to release. So the concurrency expressions are EVALUATED here, for the
 * events that produce them, rather than compared as strings.
 */
interface Step {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
  'timeout-minutes'?: number;
}
interface Job {
  name?: string;
  needs?: string | string[];
  if?: string;
  outputs?: Record<string, string>;
  'timeout-minutes'?: number;
  strategy?: { 'fail-fast'?: boolean; matrix?: { shard?: number[]; engine?: unknown } };
  services?: Record<string, unknown>;
  steps: Step[];
}
interface Workflow {
  on: {
    push?: { branches?: string[] };
    pull_request?: unknown;
    workflow_dispatch?: unknown;
    workflow_call?: unknown;
  };
  permissions: Record<string, string>;
  concurrency: { group: string; 'cancel-in-progress': string | boolean };
  jobs: Record<string, Job>;
}

const workflow = parse(
  readFileSync(join(__dirname, '../../.github/workflows/ci.yml'), 'utf8'),
) as Workflow;

const ROOT = join(__dirname, '../..');

/**
 * Every job `changes` may leave out of a pull request, and the scope output
 * that decides it (scripts/ci-scope.sh). The audit is gated too, on `audit`
 * alone, and stays out of the aggregate (a registry outage is not a test result).
 */
const SCOPED_JOBS: Record<string, string> = {
  unit: 'unit',
  web: 'web',
  integration: 'integration',
  'legacy-mysql': 'legacy',
  'legacy-rehearsal': 'legacy',
  'deploy-logic': 'deploy_logic',
  deploy: 'deploy',
  'deploy-update': 'deploy',
};
const SCOPE_OUTPUTS = [
  'full',
  'unit',
  'web',
  'integration',
  'legacy',
  'deploy',
  'deploy_logic',
  'audit',
  'legacy_engines',
];

interface Engine {
  label: string;
  image: string;
  health: string;
}

function parseOutputs(text: string): Record<string, string> {
  return Object.fromEntries(
    text
      .trim()
      .split('\n')
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
  );
}

/** The scope script's outputs for this event and these changed paths (on stdin). */
function scopeInput(event: string, input: string): Record<string, string> {
  return parseOutputs(
    execFileSync('bash', [join(ROOT, 'scripts/ci-scope.sh'), event, '--stdin'], {
      cwd: ROOT,
      input,
    }).toString(),
  );
}
const scope = (event: string, ...paths: string[]) =>
  scopeInput(event, paths.map((p) => `${p}\n`).join(''));

interface Context {
  workflow: string;
  event_name: string;
  ref: string;
  sha: string;
  event: { pull_request?: { number: number } };
}

/**
 * Evaluates the subset of GitHub's expression language these two fields use:
 * `github.*` property access, string literals, numbers, `==`, `&&`, `||`,
 * parentheses and `format()`. `&&` and `||` return an operand, as GitHub's do,
 * which is what the group's `a && b || c` relies on. Anything outside the
 * subset throws, so the test fails rather than guessing.
 */
function evaluateExpression(source: string, github: Context): unknown {
  const tokens = source.match(/\s*('(?:[^']|'')*'|==|&&|\|\||[(),]|[A-Za-z_][\w.-]*|\d+)\s*/g);
  if (!tokens || tokens.join('').trim() !== source.trim()) {
    throw new Error(`expression outside the supported subset: ${source}`);
  }
  const list = tokens.map((t) => t.trim());
  let at = 0;
  const peek = () => list[at];
  const take = (expected?: string) => {
    const token = list[at++];
    if (expected !== undefined && token !== expected) throw new Error(`expected ${expected}`);
    return token!;
  };
  const truthy = (v: unknown) =>
    v !== false && v !== null && v !== undefined && v !== '' && v !== 0;
  function primary(): unknown {
    const token = take();
    if (token === '(') {
      const value = or();
      take(')');
      return value;
    }
    if (token.startsWith("'")) return token.slice(1, -1).replace(/''/g, "'");
    if (/^\d+$/.test(token)) return Number(token);
    if (token === 'format' && peek() === '(') {
      take('(');
      const args: unknown[] = [or()];
      while (peek() === ',') {
        take(',');
        args.push(or());
      }
      take(')');
      const [template, ...rest] = args;
      return String(template).replace(/\{(\d+)\}/g, (_, i: string) => String(rest[Number(i)]));
    }
    const [root, ...path] = token.split('.');
    if (root !== 'github') throw new Error(`unsupported name ${token}`);
    return path.reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], github);
  }
  function equality(): unknown {
    const left = primary();
    if (peek() !== '==') return left;
    take('==');
    return left === primary();
  }
  function and(): unknown {
    let value = equality();
    while (peek() === '&&') {
      take('&&');
      const right = equality();
      value = truthy(value) ? right : value;
    }
    return value;
  }
  function or(): unknown {
    let value = and();
    while (peek() === '||') {
      take('||');
      const right = and();
      value = truthy(value) ? value : right;
    }
    return value;
  }
  const value = or();
  if (at !== list.length) throw new Error(`trailing tokens in ${source}`);
  return value;
}

/** A field value: a whole `${{ }}` keeps its type; a template is a string. */
function evaluate(field: string | boolean, github: Context): unknown {
  if (typeof field === 'boolean') return field;
  const whole = /^\$\{\{((?:(?!\}\}).)*)\}\}$/s.exec(field.trim());
  if (whole) return evaluateExpression(whole[1]!, github);
  return field.replace(/\$\{\{((?:(?!\}\}).)*)\}\}/gs, (_, inner: string) =>
    String(evaluateExpression(inner, github)),
  );
}

function context(overrides: Partial<Context>): Context {
  return {
    workflow: 'CI',
    event_name: 'push',
    ref: 'refs/heads/main',
    sha: '1'.repeat(40),
    event: {},
    ...overrides,
  };
}

const group = (c: Context) => String(evaluate(workflow.concurrency.group, c));
const cancels = (c: Context) => evaluate(workflow.concurrency['cancel-in-progress'], c);

describe('the CI workflow', () => {
  it('runs on pull requests, on pushes to main only, and on demand', () => {
    // A push run of a PR branch duplicated the pull_request run of the same
    // head. Main still runs on push: that run is the release evidence.
    expect(workflow.on.push?.branches).toEqual(['main']);
    expect(workflow.on).toHaveProperty('pull_request');
    expect(workflow.on).toHaveProperty('workflow_dispatch');
  });

  it('never cancels a run on main, and gives every main commit its own group', () => {
    const first = context({ sha: 'a'.repeat(40) });
    const second = context({ sha: 'b'.repeat(40) });
    expect(cancels(first)).toBe(false);
    expect(cancels(second)).toBe(false);
    // Two merges in quick succession must not share a group: a shared group
    // keeps ONE pending run and cancels the other even without
    // cancel-in-progress.
    expect(group(first)).not.toBe(group(second));
    // A re-run of an old main SHA cannot collide with a newer commit's run.
    expect(group(first)).toContain('a'.repeat(40));
  });

  it('never cancels a dispatched run', () => {
    const dispatched = context({ event_name: 'workflow_dispatch', ref: 'refs/heads/hotfix/x' });
    expect(cancels(dispatched)).toBe(false);
    expect(group(dispatched)).toContain(dispatched.sha);
  });

  it('cancels a superseded pull-request run, and only that', () => {
    const pr = (sha: string, number = 42) =>
      context({
        event_name: 'pull_request',
        ref: `refs/pull/${number}/merge`,
        sha,
        event: { pull_request: { number } },
      });
    expect(cancels(pr('c'.repeat(40)))).toBe(true);
    // A new head of the same PR replaces the old one's run...
    expect(group(pr('c'.repeat(40)))).toBe(group(pr('d'.repeat(40))));
    // ...another PR's runs are untouched...
    expect(group(pr('c'.repeat(40), 43))).not.toBe(group(pr('c'.repeat(40), 42)));
    // ...and no PR can share a group with a main run, whatever its SHA.
    expect(group(pr('a'.repeat(40)))).not.toBe(group(context({ sha: 'a'.repeat(40) })));
  });

  it('bounds every job, so a hang is reported rather than billed for six hours', () => {
    for (const [name, job] of Object.entries(workflow.jobs)) {
      expect(job['timeout-minutes'], `${name} has no timeout`).toBeGreaterThan(0);
      expect(
        job['timeout-minutes'],
        `${name} timeout is the default in disguise`,
      ).toBeLessThanOrEqual(60);
    }
  });

  it('runs every integration file in exactly one shard, each against its own database', () => {
    const job = workflow.jobs.integration!;
    const shards = job.strategy?.matrix?.shard ?? [];
    expect(shards.length).toBeGreaterThan(1);
    expect(shards).toEqual(shards.map((_, i) => i + 1));
    // One failing shard must not cancel the others' evidence.
    expect(job.strategy?.['fail-fast']).toBe(false);
    // R5C-2 E: the database and cache are started by a retried step, never `services:` — a
    // service container that fails at "Initialize containers" cannot be retried.
    expect(job.services).toBeUndefined();
    const start = job.steps.find((s) => s.name === 'Start PostgreSQL and Redis (bounded retry)');
    expect(start?.run).toBe('bash scripts/ci-start-services.sh');
    const tests = job.steps.find((s) => s.name === 'Integration tests');
    // The count is the matrix length, so the denominator cannot drift from
    // the list: a stale `/4` with five matrix entries would run some files
    // twice and others never.
    expect(tests?.run).toContain('pnpm test:integration');
    expect(tests?.run).toContain('--shard="${{ matrix.shard }}/${{ strategy.job-total }}"');
    expect(tests?.['timeout-minutes'], 'the test step has no timeout of its own').toBeGreaterThan(
      0,
    );
    // Progress output that tells slow from stuck from held-open.
    expect(tests?.run).toContain('--reporter=./tests/support/ci-progress-reporter.ts');
    expect(tests?.run).toContain('--reporter=hanging-process');
    expect(tests?.run).toContain('--reporter=default');
  });

  it('prepares each shard database with the compiled migrator, without secrets, after tuning', () => {
    const steps = workflow.jobs.integration!.steps;
    const names = steps.map((s) => s.name);
    const start = names.indexOf('Start PostgreSQL and Redis (bounded retry)');
    const tune = names.indexOf('Make the throwaway database non-durable');
    const migrate = names.indexOf('Apply migrations without application secrets');
    const tests = names.indexOf('Integration tests');
    expect(start).toBeGreaterThan(-1);
    expect(tune).toBeGreaterThan(start);
    expect(migrate).toBeGreaterThan(tune);
    expect(tests).toBeGreaterThan(migrate);
    expect(steps[migrate]?.run).toBe('env -u SECRETS_KEK -u SECRETS_KEK_ID pnpm db:migrate');
    expect(steps[tune]?.env?.POSTGRES_CONTAINER).toBe('nexa-ci-postgres');
  });

  it('reports one result that is green only when every test job is', () => {
    const job = workflow.jobs.test!;
    expect(job.name).toBe('Unit and integration tests');
    // Without always() a failed shard SKIPS this job, and a skipped required
    // check is not a red one.
    expect(job.if).toBe('always()');
    expect(job.needs).toEqual(
      expect.arrayContaining(['changes', 'build', ...Object.keys(SCOPED_JOBS)]),
    );
    const step = job.steps.find((s) => s.name === 'Every test job succeeded')!;
    expect(step.run).toBe('bash scripts/ci-aggregate.sh');
    expect(step.env?.EVENT).toBe('${{ github.event_name }}');
    expect(step.env?.CHANGES).toBe('${{ needs.changes.result }}');
    expect(step.env?.FULL).toBe('${{ needs.changes.outputs.full }}');
    expect(step.env?.BUILD_RESULT).toBe('${{ needs.build.result }}');
    // Every scoped job is handed to the decision with its OWN result and the
    // SAME scope output its `if:` runs on, so the two cannot disagree.
    for (const [name, output] of Object.entries(SCOPED_JOBS)) {
      const key = name.toUpperCase().replace(/-/g, '_');
      expect(step.env?.[`${key}_RESULT`], name).toBe(`\${{ needs.${name}.result }}`);
      expect(step.env?.[`${key}_SCOPE`], name).toBe(`\${{ needs.changes.outputs.${output} }}`);
    }
    // ...and the script checks every one of them.
    const script = readFileSync(join(ROOT, 'scripts/ci-aggregate.sh'), 'utf8');
    const listed = /^JOBS=\(([^)]*)\)$/mu.exec(script)?.[1]?.trim().split(/\s+/u) ?? [];
    expect(listed.sort()).toEqual(
      Object.keys(SCOPED_JOBS)
        .map((n) => n.toUpperCase().replace(/-/g, '_'))
        .sort(),
    );
  });

  describe('the aggregate decision (scripts/ci-aggregate.sh)', () => {
    const keys = Object.keys(SCOPED_JOBS).map((n) => n.toUpperCase().replace(/-/g, '_'));
    /** Exit status of the aggregate for these results; everything else green and in scope. */
    function aggregate(overrides: Record<string, string | undefined>): number {
      const env: Record<string, string> = {
        PATH: process.env.PATH ?? '',
        EVENT: 'pull_request',
        CHANGES: 'success',
        FULL: 'false',
        BUILD_RESULT: 'success',
      };
      for (const key of keys) {
        env[`${key}_RESULT`] = 'success';
        env[`${key}_SCOPE`] = 'true';
      }
      for (const [key, value] of Object.entries(overrides)) {
        if (value === undefined) delete env[key];
        else env[key] = value;
      }
      try {
        execFileSync('bash', [join(ROOT, 'scripts/ci-aggregate.sh')], { env, stdio: 'pipe' });
        return 0;
      } catch (error) {
        return (error as { status: number }).status;
      }
    }
    const outOfScope = (key: string) => ({
      [`${key}_RESULT`]: 'skipped',
      [`${key}_SCOPE`]: 'false',
    });

    it('passes when every job succeeded, on every event', () => {
      for (const event of ['pull_request', 'push', 'workflow_dispatch', 'schedule']) {
        expect(aggregate({ EVENT: event }), event).toBe(0);
        expect(aggregate({ EVENT: event, FULL: 'true' }), event).toBe(0);
      }
    });

    it('accepts a skip on a pull request only for a job its scope left out', () => {
      const all = Object.assign({}, ...keys.map(outOfScope)) as Record<string, string>;
      expect(aggregate(all)).toBe(0);
      for (const key of keys) {
        expect(aggregate(outOfScope(key)), key).toBe(0);
        // In scope and skipped: something that should have run did not.
        expect(aggregate({ [`${key}_RESULT`]: 'skipped' }), `${key} in scope`).not.toBe(0);
        expect(aggregate({ [`${key}_RESULT`]: 'skipped', [`${key}_SCOPE`]: '' }), key).not.toBe(0);
        expect(
          aggregate({ [`${key}_RESULT`]: 'skipped', [`${key}_SCOPE`]: undefined }),
          key,
        ).not.toBe(0);
      }
    });

    it('never accepts a cancelled, failed or missing result, in scope or not', () => {
      for (const key of keys) {
        for (const result of ['cancelled', 'failure', 'timed_out', '']) {
          expect(aggregate({ [`${key}_RESULT`]: result }), `${key} ${result}`).not.toBe(0);
          expect(aggregate({ [`${key}_RESULT`]: result, [`${key}_SCOPE`]: 'false' }), key).not.toBe(
            0,
          );
        }
        expect(
          aggregate({ [`${key}_RESULT`]: undefined, [`${key}_SCOPE`]: 'false' }),
          key,
        ).not.toBe(0);
      }
    });

    it('never accepts a skip on a push, a dispatch or the nightly — the release evidence', () => {
      for (const event of ['push', 'workflow_dispatch', 'schedule', '']) {
        for (const key of keys) {
          expect(aggregate({ EVENT: event, ...outOfScope(key) }), `${event} ${key}`).not.toBe(0);
        }
      }
    });

    it('never accepts a skip on a full pull request, or when the decision failed', () => {
      for (const key of keys) {
        expect(aggregate({ FULL: 'true', ...outOfScope(key) }), key).not.toBe(0);
        expect(aggregate({ FULL: '', ...outOfScope(key) }), key).not.toBe(0);
        for (const changes of ['failure', 'cancelled', 'skipped', '']) {
          expect(aggregate({ CHANGES: changes, ...outOfScope(key) }), key).not.toBe(0);
        }
      }
      expect(aggregate({ CHANGES: 'failure' })).not.toBe(0);
      for (const build of ['skipped', 'failure', 'cancelled']) {
        expect(aggregate({ BUILD_RESULT: build }), build).not.toBe(0);
      }
    });
  });

  it('runs each scoped job on its own scope output or a full run, and nothing else', () => {
    for (const [name, output] of Object.entries(SCOPED_JOBS)) {
      const job = workflow.jobs[name]!;
      expect(job.if, name).toBe(
        `needs.changes.outputs.full == 'true' || needs.changes.outputs.${output} == 'true'`,
      );
      expect([job.needs].flat(), name).toContain('changes');
    }
    // The audit reads the dependency graph only: its own output, which is true
    // on every non-PR event and on a PR that changed the graph — not `full`.
    expect(workflow.jobs.audit!.if).toBe("needs.changes.outputs.audit == 'true'");
    expect([workflow.jobs.audit!.needs].flat()).toContain('changes');
    // Static and build always run; nothing else may be gated by `changes`.
    const gated = Object.entries(workflow.jobs)
      .filter(([, job]) => job.if?.includes('needs.changes.outputs'))
      .map(([name]) => name)
      .sort();
    expect(gated).toEqual([...Object.keys(SCOPED_JOBS), 'audit'].sort());
    expect(workflow.jobs.static!.if).toBeUndefined();
    expect(workflow.jobs.build!.if).toBeUndefined();
    // Every output the script prints is published by `changes`, under its own name.
    const changes = workflow.jobs.changes!;
    for (const output of SCOPE_OUTPUTS) {
      expect(changes.outputs?.[output], output).toBe(`\${{ steps.decide.outputs.${output} }}`);
    }
    expect(Object.keys(changes.outputs ?? {}).sort()).toEqual([...SCOPE_OUTPUTS].sort());
    const decide = changes.steps.find((s) => s.name === 'Decide which jobs run');
    expect(decide?.run).toContain('set -euo pipefail');
    expect(decide?.run).toContain('bash scripts/ci-scope.sh "$EVENT" | tee -a "$GITHUB_OUTPUT"');
    expect(existsSync(join(ROOT, 'scripts/ci-docs-only.sh')), 'the old script is back').toBe(false);
  });

  it('runs the legacy source on MySQL 8.0 only for a pull request, on both engines otherwise', () => {
    const job = workflow.jobs['legacy-mysql']!;
    expect(job.strategy?.matrix?.engine).toBe(
      '${{ fromJSON(needs.changes.outputs.legacy_engines) }}',
    );
    const engines = (event: string) =>
      (JSON.parse(scope(event, 'tests/legacy-mysql/x.test.ts').legacy_engines!) as Engine[]).map(
        (e) => e.image,
      );
    expect(engines('pull_request')).toEqual(['mysql:8.0']);
    // Even a full pull request: the second engine is main's and the nightly's.
    expect(JSON.parse(scope('pull_request', 'tests/support/x.ts').legacy_engines!)).toHaveLength(1);
    for (const event of ['push', 'workflow_dispatch', 'schedule']) {
      expect(engines(event), event).toEqual(['mariadb:10.11', 'mysql:8.0']);
    }
  });

  describe('which jobs a pull request runs (scripts/ci-scope.sh)', () => {
    const NONE = {
      full: 'false',
      unit: 'true',
      web: 'false',
      integration: 'false',
      legacy: 'false',
      deploy: 'false',
      deploy_logic: 'false',
      audit: 'false',
    };
    const on = (...jobs: string[]) => ({
      ...NONE,
      ...Object.fromEntries(jobs.map((j) => [j, 'true'])),
    });
    const FULL = on('full', 'web', 'integration', 'legacy', 'deploy', 'deploy_logic');
    const decided = (event: string, ...paths: string[]) => {
      const { legacy_engines: _, ...rest } = scope(event, ...paths);
      return rest;
    };

    it.each([
      // Documentation: today's docs-only rule, unchanged.
      [
        ['docs/ci.md', 'docs/round-reports/web-redesign.md', 'README.md'],
        on('web', 'deploy_logic'),
      ],
      [['CLAUDE.md', 'PROGRESS.md'], on('web', 'deploy_logic')],
      // The Web Admin, its text slices and the Mini App: the web project.
      [['apps/web/src/pages/x.tsx'], on('web')],
      [['apps/web/src/i18n/web.fa/customers.ts'], on('web')],
      [['tests/web/customers.test.tsx'], on('web')],
      [['apps/miniapp/src/screens/store.tsx', 'tests/web/miniapp.test.tsx'], on('web')],
      // ...except the template copy, which one integration suite imports.
      [['apps/web/src/i18n/templates.fa.ts'], on('web', 'integration')],
      // Application code and the shared text: unit, integration, web.
      [['apps/api/src/modules/commerce/orders/application/x.ts'], on('web', 'integration')],
      [['packages/i18n/src/fa.ts'], on('web', 'integration')],
      [['tests/integration/orders.test.ts'], on('integration')],
      [['tests/unit/x.test.ts'], NONE],
      // The legacy importer: + both legacy jobs.
      [
        ['apps/api/src/modules/platform/legacy-importer/application/plan.ts'],
        on('web', 'integration', 'legacy'),
      ],
      [['apps/api/src/modules/commerce/legacy-adoption/x.ts'], on('web', 'integration', 'legacy')],
      [['apps/api/src/infrastructure/nxpkg/reader.ts'], on('web', 'integration', 'legacy')],
      [['tests/legacy-mysql/legacy-mysql-source.test.ts'], on('legacy')],
      [['tests/fixtures/legacy/synthetic-legacy.ts'], on('integration', 'legacy')],
      [['scripts/legacy-rehearsal-synthetic-assert.mjs'], on('integration', 'legacy')],
      [['scripts/legacy-rehearsal.sh'], on('integration', 'legacy', 'deploy_logic')],
      // The recovery role, backup, the CLIs, the migrator and the process entry
      // points: what the smokes and the rehearsal run beyond the suites.
      [
        ['apps/api/src/modules/platform/recovery/application/x.ts'],
        on('web', 'integration', 'legacy', 'deploy'),
      ],
      [['apps/api/src/main.recovery.ts'], on('web', 'integration', 'legacy', 'deploy')],
      [['apps/api/src/backup.cli.ts'], on('web', 'integration', 'legacy', 'deploy')],
      [
        ['apps/api/src/infrastructure/persistence/migrate.ts'],
        on('web', 'integration', 'legacy', 'deploy'),
      ],
      [
        ['apps/api/src/infrastructure/config/config.schema.ts'],
        on('web', 'integration', 'deploy', 'deploy_logic'),
      ],
      // The deployment: both smokes and the deployment logic.
      [['deploy/bin/botctl'], on('deploy', 'deploy_logic')],
      [['deploy/rehearsal/mirza-rehearsal.sh'], on('deploy', 'deploy_logic')],
      [['Dockerfile'], on('deploy', 'deploy_logic')],
      [['.dockerignore', 'docker-compose.yml'], on('deploy', 'deploy_logic')],
      [['scripts/deployment-update-smoke.sh'], on('deploy', 'deploy_logic')],
      [['scripts/image-build.sh'], on('deploy', 'deploy_logic')],
      [['deploy/caddy/routes.caddy'], on('web', 'integration', 'deploy', 'deploy_logic')],
      [['tests/deploy/botctl.test.sh', 'scripts/release-ci-gate.mjs'], on('deploy_logic')],
      // Session tooling.
      [['.claude/skills/nexa-ci-watch/SKILL.md', 'scripts/mutate-tb1.py'], NONE],
      [['scripts/claude/run-gate.sh'], on('deploy_logic')],
    ])('%j', (paths, expected) => {
      expect(decided('pull_request', ...paths)).toEqual(expected);
    });

    it('runs the union of every path’s jobs', () => {
      expect(decided('pull_request', 'docs/ci.md', 'apps/web/src/x.tsx')).toEqual(
        on('web', 'deploy_logic'),
      );
      expect(decided('pull_request', 'apps/web/src/x.tsx', 'deploy/bin/botctl')).toEqual(
        on('web', 'deploy', 'deploy_logic'),
      );
      expect(
        decided('pull_request', 'tests/legacy-mysql/a.test.ts', 'apps/api/src/modules/x/y.ts'),
      ).toEqual(on('web', 'integration', 'legacy'));
      expect(
        decided('pull_request', 'docs/ci.md', 'Dockerfile', 'tests/fixtures/legacy/a.ts'),
      ).toEqual(on('web', 'integration', 'legacy', 'deploy', 'deploy_logic'));
    });

    it('runs everything for a path no rule classifies, beside anything else', () => {
      for (const path of [
        'tests/support/timed-sequencer.mts',
        'tests/fixtures/other/x.json',
        'tests/exhaustive/x.test.ts',
        'scripts/check-boundaries.sh',
        'scripts/integration-timings.mjs',
        'docs/legacy-migration/final-report.schema.json',
        'docs',
        'apps/api/drizzle.config.ts',
        'apps/api/tsconfig.json',
        'eslint.config.mjs',
        'vitest.config.mts',
        'README.fa.md',
        'a-new-top-level-file',
        '"docs/\\331\\205.md"',
      ]) {
        expect(decided('pull_request', path), path).toEqual(FULL);
        expect(decided('pull_request', 'docs/ci.md', path), path).toEqual(FULL);
      }
    });

    it('runs everything for every fail-safe path, whatever else changed', () => {
      for (const path of [
        'packages/contracts/src/templates.ts',
        'apps/api/drizzle/0300_x.sql',
        'apps/api/drizzle/meta/_journal.json',
        '.github/workflows/ci.yml',
        '.github/workflows/nightly.yml',
        'scripts/ci-scope.sh',
        'scripts/ci-aggregate.sh',
        'scripts/ci-start-services.sh',
      ]) {
        expect(decided('pull_request', path), path).toEqual(FULL);
        expect(decided('pull_request', 'docs/ci.md', path), path).toEqual(FULL);
      }
      // The dependency graph: full, and the audit too.
      for (const path of ['pnpm-lock.yaml', 'package.json', 'apps/web/package.json']) {
        expect(decided('pull_request', path), path).toEqual({ ...FULL, audit: 'true' });
      }
    });

    it('runs the audit on a pull request only when the dependency graph changed', () => {
      expect(decided('pull_request', 'tests/support/x.ts').audit).toBe('false');
      expect(decided('pull_request', 'apps/api/src/x.ts').audit).toBe('false');
      for (const path of ['pnpm-lock.yaml', 'packages/i18n/package.json', 'pnpm-workspace.yaml']) {
        expect(decided('pull_request', 'docs/ci.md', path).audit, path).toBe('true');
      }
    });

    it('runs everything, the audit included, on a push, a dispatch and the nightly', () => {
      for (const event of ['push', 'workflow_dispatch', 'schedule', '']) {
        expect(decided(event, 'docs/ci.md'), event).toEqual({ ...FULL, audit: 'true' });
      }
    });

    it('runs everything when there is nothing to read', () => {
      for (const input of ['', '\n', '\n\n']) {
        expect(scopeInput('pull_request', input), JSON.stringify(input)).toMatchObject({
          ...FULL,
          audit: 'true',
        });
      }
    });

    it('reads the paths from a two-parent merge commit, and from nothing else', () => {
      const script = join(ROOT, 'scripts/ci-scope.sh');
      const dir = mkdtempSync(join(tmpdir(), 'ci-scope-'));
      const git = (...args: string[]) =>
        execFileSync(
          'git',
          ['-c', 'user.name=ci', '-c', 'user.email=ci@example.invalid', ...args],
          { cwd: dir, stdio: 'pipe' },
        );
      const decide = () =>
        parseOutputs(execFileSync('bash', [script, 'pull_request'], { cwd: dir }).toString());
      try {
        git('init', '-q', '-b', 'main');
        git('commit', '-q', '--allow-empty', '-m', 'base');
        git('checkout', '-q', '-b', 'web');
        mkdirSync(join(dir, 'apps/web'), { recursive: true });
        writeFileSync(join(dir, 'apps/web/a.tsx'), 'x\n');
        git('add', '.');
        git('commit', '-q', '-m', 'web');
        // Not a merge: HEAD^1 is the PR's own previous commit, not its base.
        expect(decide().full).toBe('true');
        git('checkout', '-q', 'main');
        git('merge', '-q', '--no-ff', 'web', '-m', 'merge');
        expect(decide()).toMatchObject({ full: 'false', web: 'true', integration: 'false' });
        // A pull request that changes an unclassified file runs everything.
        git('checkout', '-q', '-b', 'code', 'main~1');
        writeFileSync(join(dir, 'main.ts'), 'x\n');
        git('add', '.');
        git('commit', '-q', '-m', 'code');
        git('checkout', '-q', 'main~1');
        git('checkout', '-q', '-b', 'base2');
        git('merge', '-q', '--no-ff', 'code', '-m', 'merge');
        expect(decide().full).toBe('true');
        // A rename counts both sides: apps/web/a.tsx -> deploy/a.tsx is web AND deploy.
        git('checkout', '-q', '-b', 'move', 'main');
        mkdirSync(join(dir, 'deploy'));
        git('mv', 'apps/web/a.tsx', 'deploy/a.tsx');
        git('commit', '-q', '-m', 'move');
        git('checkout', '-q', 'main');
        git('merge', '-q', '--no-ff', 'move', '-m', 'merge');
        expect(decide()).toMatchObject({ full: 'false', web: 'true', deploy: 'true' });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  it('keeps every Markdown file out of what the skippable jobs read', () => {
    // A documentation change selects static, unit, web and deployment logic,
    // which DO read docs/*.md; it skips the integration shards, both legacy jobs
    // and both smokes, which is sound only while none of them reads a file the
    // documentation rule matches. This scans the code they run for a read of
    // one, on one line: a file API or a shell reader beside a docs path. (The
    // general check below asks the same of every path; this one also covers
    // the application source the integration suite runs.)
    const root = join(__dirname, '../..');
    const sources = [
      'tests/integration',
      'tests/legacy-mysql',
      'apps/api/src',
      'deploy',
      'scripts/deployment-smoke.sh',
      'scripts/deployment-update-smoke.sh',
      'scripts/mirza-rehearsal-smoke.sh',
      'scripts/legacy-rehearsal.sh',
      'scripts/legacy-rehearsal-synthetic.sh',
    ].flatMap((path) => {
      try {
        return readdirSync(join(root, path), { recursive: true })
          .map(String)
          .map((f) => join(path, f));
      } catch {
        return [path];
      }
    });
    const reader = /(readFile|createReadStream|open\(|\bcat\b|\bgrep\b|\bsed\b|\bjq\b|<\s*")/u;
    const markdown =
      /(docs\/[\w./-]*\.md\b|['"]docs['"][^\n]*\.md\b|\b(README|CLAUDE|PROGRESS)\.md\b)/u;
    const hits: string[] = [];
    for (const file of sources) {
      if (!/\.(m?ts|m?js|sh)$|\/bin\/[\w-]+$/u.test(file)) continue;
      let text: string;
      try {
        text = readFileSync(join(root, file), 'utf8');
      } catch {
        continue;
      }
      text.split('\n').forEach((line, i) => {
        if (reader.test(line) && markdown.test(line)) hits.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(hits).toEqual([]);
  });

  it('selects every job for every repository path its code reads', () => {
    // The scope rules are sound only while no job is left out for a file it
    // reads. This scans what each skippable job runs for a line that names a
    // repository path and reads, imports, runs or copies it, and asks the
    // scope script about that path alone: the job must be selected (or the run
    // full). A new read of an unclassified path passes (full); a new read of a
    // classified path the job is not in fails here.
    const readers: Record<string, string[]> = {
      integration: ['tests/integration', 'apps/api/src'],
      legacy: [
        'tests/legacy-mysql',
        'scripts/legacy-rehearsal-synthetic.sh',
        'scripts/legacy-rehearsal.sh',
        'scripts/legacy-rehearsal-synthetic-assert.mjs',
        'scripts/legacy-rehearsal-reconciliation.mjs',
        'scripts/legacy-rehearsal-report-check.mjs',
        'scripts/legacy-archive-inspect.mjs',
      ],
      deploy: [
        'scripts/deployment-smoke.sh',
        'scripts/deployment-update-smoke.sh',
        'scripts/mirza-rehearsal-smoke.sh',
        'scripts/standalone-installer-smoke.sh',
        'scripts/image-build.sh',
        'scripts/check-image.sh',
        'deploy',
      ],
      deploy_logic: ['scripts/check-shell.sh', 'tests/deploy'],
      web: ['tests/web'],
    };
    const reads =
      /(readFile|createReadStream|open\(|\bcat\b|\bgrep\b|\bsed\b|\bjq\b|\bawk\b|<\s*"|\bsource\b|^\s*\.\s|\bbash\b|\bnode\b|\btsx\b|\bcp\b|\bfind\b|\bdocker\b|--file\b|-f\s|from\s+['"]|import\(|require\(|join\(|resolve\(|\$\{?ROOT|\$\{?REPO|\$\{?here)/u;
    const path =
      /(?<![\w.-])((?:apps|packages|scripts|deploy|docs|tests)\/[\w./@-]*[\w@-]|Dockerfile\b|\.dockerignore\b)/gu;
    const files = (source: string): string[] => {
      try {
        return readdirSync(join(ROOT, source), { recursive: true })
          .map(String)
          .map((f) => join(source, f));
      } catch {
        return [source];
      }
    };
    const missing: string[] = [];
    let checked = 0;
    for (const [output, sources] of Object.entries(readers)) {
      const asked = new Map<string, boolean>();
      for (const file of sources.flatMap(files)) {
        if (!/\.(m?ts|tsx|m?js|sh|ya?ml|caddy)$|\/bin\/[\w-]+$|Caddyfile/u.test(file)) continue;
        let text: string;
        try {
          text = readFileSync(join(ROOT, file), 'utf8');
        } catch {
          continue;
        }
        text.split('\n').forEach((line, i) => {
          const code = line.trim();
          if (/^(#|\/\/|\*|\/\*)/u.test(code) || !reads.test(code)) return;
          for (const match of code.matchAll(path)) {
            const named = match[1]!.replace(/[./]+$/u, '');
            // A directory (no extension) stands for any file in it.
            const probe = /\.\w+$|^Dockerfile|^\.dockerignore/u.test(named.split('/').pop()!)
              ? named
              : `${named}/__probe__`;
            if (!asked.has(probe)) {
              const decided = scope('pull_request', probe);
              asked.set(probe, decided.full === 'true' || decided[output] === 'true');
            }
            checked += 1;
            if (!asked.get(probe)) missing.push(`${output}: ${file}:${i + 1} reads ${named}`);
          }
        });
      }
    }
    expect(checked, 'the scan found nothing: its patterns are wrong').toBeGreaterThan(100);
    expect(missing).toEqual([]);
  });

  it('runs the update smoke beside the other two, never after them', () => {
    const update = workflow.jobs['deploy-update']!;
    const smoke = workflow.jobs.deploy!;
    expect(update.steps.map((s) => s.run).filter(Boolean)).toEqual([
      'bash scripts/deployment-update-smoke.sh',
    ]);
    expect(smoke.steps.map((s) => s.run).filter(Boolean)).toEqual([
      'bash scripts/deployment-smoke.sh',
      'bash scripts/mirza-rehearsal-smoke.sh',
      'bash scripts/standalone-installer-smoke.sh',
    ]);
    expect(update.needs).toBe('changes');
    expect(smoke.needs).toBe('changes');
  });

  it('runs the legacy MySQL source suite against a real MySQL-family engine', () => {
    const job = workflow.jobs['legacy-mysql']!;
    expect(job, 'the legacy-mysql job is gone').toBeDefined();
    expect(Object.keys(job.services ?? {})).toEqual(['legacydb']);
    const service = (job.services ?? {})['legacydb'] as { image?: string };
    expect(service.image).toBe('${{ matrix.engine.image }}');
    // WP-D1b (OQ-P7-03): both engines on every push, dispatch and nightly (the
    // engine test above), collations never rewritten. Each engine's image and
    // health probe, as the script hands them to the matrix:
    const engines = JSON.parse(scope('push', 'docs/ci.md').legacy_engines!) as Engine[];
    expect(engines).toEqual([
      {
        label: 'mariadb-10.11',
        image: 'mariadb:10.11',
        health: 'healthcheck.sh --connect --innodb_initialized',
      },
      { label: 'mysql-8.0', image: 'mysql:8.0', health: 'mysqladmin ping -h 127.0.0.1 -proot' },
    ]);
    expect(job.steps.some((s) => s.run === 'pnpm test:legacy-mysql')).toBe(true);
    // The suite FAILS without its DSN; the job must supply one.
    const env = (job as unknown as { env?: Record<string, string> }).env ?? {};
    expect(env['NEXA_LEGACY_MYSQL_ADMIN_DSN']).toMatch(/^mysql:\/\//u);
    expect(job['timeout-minutes']).toBeGreaterThan(0);
  });

  it('pins the image of every job that downloads release-specific Ubuntu packages', () => {
    for (const [name, job] of Object.entries(workflow.jobs)) {
      const downloads = job.steps.some((s) =>
        /apt-get download|ci-fetch-debs\.sh/u.test(s.run ?? ''),
      );
      if (downloads) {
        expect((job as unknown as { 'runs-on'?: string })['runs-on'], name).toBe('ubuntu-24.04');
      }
    }
    expect(
      workflow.jobs['legacy-rehearsal']!.steps.some((s) =>
        /apt-get download|ci-fetch-debs\.sh/u.test(s.run ?? ''),
      ),
    ).toBe(true);
  });

  it('builds once and hands every test job the same compiled output', () => {
    const upload = workflow.jobs.build!.steps.find((s) =>
      s.uses?.startsWith('actions/upload-artifact'),
    );
    expect(upload?.with?.name).toBe('dist');
    expect(upload?.with?.['if-no-files-found']).toBe('error');
    const paths = String(upload?.with?.path ?? '');
    for (const dist of [
      'apps/api/dist',
      'apps/web/dist',
      'packages/contracts/dist',
      'packages/i18n/dist',
    ]) {
      expect(paths, `${dist} is not handed on`).toContain(dist);
    }
    for (const name of ['unit', 'web', 'integration', 'legacy-mysql', 'legacy-rehearsal']) {
      const job = workflow.jobs[name]!;
      expect([job.needs].flat(), `${name} does not wait for the build`).toContain('build');
      const download = job.steps.find((s) => s.uses?.startsWith('actions/download-artifact'));
      expect(download?.with?.name, `${name} does not download the build`).toBe('dist');
      expect(
        job.steps.some((s) => /pnpm build\b/.test(s.run ?? '')),
        `${name} builds again`,
      ).toBe(false);
    }
  });

  it('still runs everything the single test job and the deploy job ran', () => {
    // Splitting jobs must not drop a check. Each command the workflow ran
    // before the split is still somewhere in it.
    const all = Object.values(workflow.jobs)
      .flatMap((j) => j.steps.map((s) => s.run ?? ''))
      .join('\n');
    for (const command of [
      'pnpm typecheck',
      'pnpm lint',
      'pnpm format:check',
      'pnpm check:boundaries',
      'pnpm check:i18n',
      'pnpm check:citations',
      'pnpm check:readme',
      'pnpm build',
      'pnpm check:runtime',
      'pnpm test\n',
      'pnpm test:web',
      'env -u SECRETS_KEK -u SECRETS_KEK_ID pnpm db:migrate',
      'pnpm db:check',
      'pnpm test:integration',
      'bash scripts/check-shell.sh',
      'bash tests/deploy/botctl.test.sh',
      'bash tests/deploy/check-shell.test.sh',
      'bash tests/deploy/release-ci-gate.test.sh',
      'bash tests/deploy/standalone-installer.test.sh',
      'bash scripts/deployment-smoke.sh',
      'bash scripts/standalone-installer-smoke.sh',
      'bash scripts/deployment-update-smoke.sh',
      'bash scripts/mirza-rehearsal-smoke.sh',
      'pnpm audit --prod --audit-level high',
    ]) {
      expect(`${all}\n`, `no job runs ${command.trim()}`).toContain(command);
    }
  });

  it('checks the repository out, unconditionally, before any step runs its code', () => {
    // A checkout skipped on some events leaves the next `bash scripts/…` with
    // no file to run: that job fails on exactly those events.
    for (const [name, job] of Object.entries(workflow.jobs)) {
      const first = job.steps.findIndex((s) => /\b(scripts\/|tests\/|pnpm )/u.test(s.run ?? ''));
      if (first === -1) continue;
      const checkout = job.steps.findIndex((s) => s.uses?.startsWith('actions/checkout@'));
      expect(checkout, `${name} runs repository code without a checkout`).toBeGreaterThan(-1);
      expect(checkout, `${name} checks out after running repository code`).toBeLessThan(first);
      expect(
        (job.steps[checkout] as { if?: string }).if,
        `${name} checks out only on some events`,
      ).toBeUndefined();
    }
  });

  it('pins every third-party action to an immutable commit', () => {
    for (const [name, job] of Object.entries(workflow.jobs)) {
      for (const step of job.steps) {
        if (!step.uses) continue;
        expect(step.uses, `${name}: ${step.uses} is not pinned to a SHA`).toMatch(/@[0-9a-f]{40}$/);
      }
    }
  });

  describe('the Dockerfile survives a flaky apt.postgresql.org (C2)', () => {
    const dockerfile = readFileSync(join(__dirname, '../../Dockerfile'), 'utf8');
    const layer = dockerfile.slice(dockerfile.indexOf('ARG PG_MAJOR=16'));
    const run = layer.slice(0, layer.indexOf('7z i >/dev/null'));

    it('retries every apt fetch, and wraps the key download and both updates in a retry loop', () => {
      expect(run).toContain('Acquire::Retries');
      expect(run).toMatch(/retry\(\) \{/u);
      expect(run.match(/retry apt-get -o APT::Update::Error-Mode=any update;/gu)).toHaveLength(2);
      expect(run).toMatch(/retry sh -c 'curl -fsSL --retry 5 --retry-delay 2 --retry-all-errors/u);
    });

    it('keeps the pinned major and the purge', () => {
      expect(run).toContain('"postgresql-client-${PG_MAJOR}" 7zip');
      expect(run).toContain('apt-get purge -y --auto-remove curl gnupg');
      expect(run).toContain('rm -f /etc/apt/apt.conf.d/80-nexa-retries');
    });
  });

  describe('the image layer cache of the deployment jobs', () => {
    const jobs = ['deploy', 'deploy-update'] as const;
    const read = (path: string) => readFileSync(join(__dirname, '../..', path), 'utf8');

    it('sets buildx up and warms the deps and system stages BEFORE the smoke builds the image', () => {
      for (const name of jobs) {
        const job = workflow.jobs[name]!;
        const setup = job.steps.findIndex((s) => s.uses?.startsWith('docker/setup-buildx-action@'));
        const smoke = job.steps.findIndex((s) =>
          /scripts\/deployment(-update)?-smoke\.sh/u.test(s.run ?? ''),
        );
        expect(setup, `${name}: no buildx setup`).toBeGreaterThan(-1);
        expect(smoke, `${name}: no smoke step`).toBeGreaterThan(setup);
        const warm = job.steps.filter((s) => s.uses?.startsWith('docker/build-push-action@'));
        expect(warm.map((s) => s.with?.['target'])).toEqual(['deps', 'system']);
        for (const step of warm) {
          expect(job.steps.indexOf(step)).toBeGreaterThan(setup);
          expect(job.steps.indexOf(step)).toBeLessThan(smoke);
          expect(step.with?.['push']).toBe(false);
          expect(String(step.with?.['cache-from'])).toMatch(/^type=gha,scope=nexa-image-/u);
          expect(String(step.with?.['cache-to'])).toMatch(/^type=gha,mode=max,scope=nexa-image-/u);
        }
        expect((job as unknown as { env?: Record<string, string> }).env?.['NEXA_CI_BUILDX']).toBe(
          '1',
        );
      }
    });

    it('keeps the coverage: both smokes still build the FULL image, through buildx, with their own build arguments', () => {
      for (const file of ['scripts/deployment-smoke.sh', 'scripts/deployment-update-smoke.sh']) {
        const text = read(file);
        expect(text, file).toContain('nexa_build_image ');
        expect(text, file).toContain('--build-arg "BUILD_VERSION=');
        expect(text, `${file} builds the release image with a bare docker build`).not.toMatch(
          /^\s*docker build \\\n\s*--build-arg "BUILD_VERSION/mu,
        );
      }
      const helper = read('scripts/image-build.sh');
      expect(helper).toContain('docker buildx build --load');
      expect(helper).toContain('docker build -t "$tag"'); // the local fallback
      expect(helper).not.toMatch(/--target/u); // never a partial image
    });

    it('orders the Dockerfile so the apt layer and the install come before anything that carries the build identity', () => {
      const dockerfile = read('Dockerfile');
      const stage = (name: string) => dockerfile.search(new RegExp(`^FROM .* AS ${name}$`, 'mu'));
      expect(stage('deps')).toBeGreaterThan(-1);
      expect(stage('system')).toBeGreaterThan(-1);
      const apt = dockerfile.indexOf(
        'apt-get install -y --no-install-recommends "postgresql-client',
      );
      const firstArg = dockerfile.indexOf('ARG BUILD_VERSION', stage('system'));
      expect(apt).toBeGreaterThan(stage('system'));
      expect(
        apt,
        'the apt layer is after the build identity: it re-runs on every commit',
      ).toBeLessThan(firstArg);
      const install = dockerfile.indexOf('RUN pnpm install --frozen-lockfile');
      expect(install).toBeGreaterThan(stage('deps'));
      expect(install).toBeLessThan(dockerfile.indexOf('COPY . .'));
      expect(dockerfile).toMatch(/^FROM system AS runtime$/mu);
      expect(dockerfile).toMatch(/^FROM deps AS builder$/mu);
    });
  });
});

describe('the nightly workflow', () => {
  interface NightlyJob {
    uses?: string;
    needs?: string[];
    if?: string;
    permissions?: Record<string, string>;
    steps?: Step[];
  }
  const nightly = parse(readFileSync(join(ROOT, '.github/workflows/nightly.yml'), 'utf8')) as {
    on: { schedule?: { cron: string }[]; workflow_dispatch?: unknown };
    permissions: Record<string, string>;
    concurrency?: unknown;
    jobs: Record<string, NightlyJob>;
  };
  const TITLE = 'CI شبانه قرمز است';

  it('runs the whole CI workflow and the exhaustive search every night', () => {
    expect(nightly.on.schedule?.length).toBeGreaterThan(0);
    expect(workflow.on).toHaveProperty('workflow_call');
    // The workflow itself, not a copy of its jobs: the audit and the second
    // legacy engine come from the full run the `schedule` event makes.
    expect(nightly.jobs.ci?.uses).toBe('./.github/workflows/ci.yml');
    expect(scope('schedule', 'docs/ci.md')).toMatchObject({ full: 'true', audit: 'true' });
    expect(nightly.jobs.exhaustive?.steps?.some((s) => /pnpm test:exhaustive/u.test(s.run ?? '')));
    // A concurrency group here would be shared with the called workflow's and
    // deadlock it.
    expect(nightly.concurrency).toBeUndefined();
  });

  it('gives issues: write to the reporting job alone', () => {
    expect(nightly.permissions).toEqual({ contents: 'read' });
    for (const [name, job] of Object.entries(nightly.jobs)) {
      if (name === 'report') continue;
      expect(job.permissions, name).toBeUndefined();
    }
    expect(workflow.permissions).toEqual({ contents: 'read' });
    const report = nightly.jobs.report!;
    expect(report.permissions).toEqual({ contents: 'read', actions: 'read', issues: 'write' });
    expect(report.needs).toEqual(['ci', 'exhaustive']);
    expect(report.if).toContain('always()');
    expect(report.if).toContain("github.ref == 'refs/heads/main'");
    expect(report.if).toContain("needs.ci.result != 'success'");
    expect(report.if).toContain("needs.exhaustive.result != 'success'");
    const step = report.steps?.find((s) => s.run === 'bash scripts/ci-nightly-report.sh');
    expect(step?.env?.RUN_ID).toBe('${{ github.run_id }}');
    expect(readFileSync(join(ROOT, 'scripts/ci-nightly-report.sh'), 'utf8')).toContain(
      `TITLE='${TITLE}'`,
    );
  });

  describe('the report (scripts/ci-nightly-report.sh) against a fake gh', () => {
    const jobs = {
      jobs: [
        { name: 'CI / Build', conclusion: 'success', html_url: 'https://x/1' },
        { name: 'CI / Integration tests (3/18)', conclusion: 'failure', html_url: 'https://x/2' },
        { name: 'CI / Deployment smoke', conclusion: 'cancelled', html_url: 'https://x/3' },
        { name: 'Exhaustive orderings', conclusion: 'success', html_url: 'https://x/4' },
        { name: 'Report a red night', conclusion: null, html_url: 'https://x/5' },
      ],
    };
    function report(issues: unknown[]): { calls: string[]; out: string } {
      const dir = mkdtempSync(join(tmpdir(), 'ci-nightly-'));
      try {
        writeFileSync(join(dir, 'jobs.json'), JSON.stringify(jobs));
        writeFileSync(join(dir, 'issues.json'), JSON.stringify(issues));
        writeFileSync(
          join(dir, 'gh'),
          [
            '#!/usr/bin/env bash',
            '{ printf "%s" "$*" | tr "\\n" " "; echo; } >>"$FAKE/calls"',
            'method=GET filter="" path=""',
            'while [ $# -gt 0 ]; do',
            '  case "$1" in',
            '    api | --paginate) ;;',
            '    --method) method="$2"; shift ;;',
            '    --jq) filter="$2"; shift ;;',
            '    -f) shift ;;',
            '    *) path="$1" ;;',
            '  esac',
            '  shift',
            'done',
            'case "$method $path" in',
            '  "GET repos/o/r/actions/runs/7/jobs?per_page=100") file="$FAKE/jobs.json" ;;',
            '  "GET repos/o/r/issues?state=open&per_page=100") file="$FAKE/issues.json" ;;',
            '  "POST repos/o/r/issues") echo \'{"number":99}\' >"$FAKE/out.json"; file="$FAKE/out.json" ;;',
            '  "POST repos/o/r/issues/"*"/comments") echo "{}" >"$FAKE/out.json"; file="$FAKE/out.json" ;;',
            '  *) echo "unexpected: $method $path" >&2; exit 9 ;;',
            'esac',
            'if [ -n "$filter" ]; then jq -r "$filter" "$file"; else cat "$file"; fi',
          ].join('\n'),
          { mode: 0o755 },
        );
        const out = execFileSync('bash', [join(ROOT, 'scripts/ci-nightly-report.sh')], {
          env: {
            PATH: `${dir}:${process.env.PATH ?? ''}`,
            FAKE: dir,
            REPO: 'o/r',
            RUN_ID: '7',
            RUN_URL: 'https://github.com/o/r/actions/runs/7',
          },
        }).toString();
        return { calls: readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n'), out };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    it('opens one issue with the exact title, the failing jobs and the run', () => {
      const { calls, out } = report([
        // Neither is the report's issue: a pull request, and another title.
        { number: 3, title: TITLE, pull_request: { url: 'x' } },
        { number: 4, title: `${TITLE} (old)` },
      ]);
      expect(out.trim()).toBe('opened #99');
      const open = calls.filter((c) => c.startsWith('api --method POST repos/o/r/issues '));
      expect(open).toHaveLength(1);
      expect(open[0]).toContain(`title=${TITLE}`);
      expect(open[0]).toContain('https://github.com/o/r/actions/runs/7');
      expect(open[0]).toContain('CI / Integration tests (3/18): failure');
      expect(open[0]).toContain('CI / Deployment smoke: cancelled');
      expect(open[0]).not.toContain('CI / Build');
      expect(open[0]).not.toContain('Report a red night');
      expect(calls.some((c) => c.includes('/comments'))).toBe(false);
    });

    it('comments on the open issue with that exact title instead of opening another', () => {
      const { calls, out } = report([
        { number: 4, title: `${TITLE} (old)` },
        { number: 12, title: TITLE },
      ]);
      expect(out.trim()).toBe('commented on #12');
      const comment = calls.filter((c) =>
        c.startsWith('api --method POST repos/o/r/issues/12/comments'),
      );
      expect(comment).toHaveLength(1);
      expect(comment[0]).toContain('CI / Integration tests (3/18): failure');
      expect(calls.some((c) => c.startsWith('api --method POST repos/o/r/issues '))).toBe(false);
    });
  });
});
