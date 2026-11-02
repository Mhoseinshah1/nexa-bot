import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
  strategy?: { 'fail-fast'?: boolean; matrix?: { shard?: number[] } };
  services?: Record<string, unknown>;
  steps: Step[];
}
interface Workflow {
  on: { push?: { branches?: string[] }; pull_request?: unknown; workflow_dispatch?: unknown };
  concurrency: { group: string; 'cancel-in-progress': string | boolean };
  jobs: Record<string, Job>;
}

const workflow = parse(
  readFileSync(join(__dirname, '../../.github/workflows/ci.yml'), 'utf8'),
) as Workflow;

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
    const required = [
      'changes',
      'unit',
      'web',
      'integration',
      'legacy-mysql',
      'legacy-rehearsal',
      'deploy-logic',
      'deploy',
      'deploy-update',
    ];
    expect(job.needs).toEqual(expect.arrayContaining(required));
    const run = job.steps.map((s) => s.run ?? '').join('\n');
    // Never skippable, on any event.
    for (const line of [
      `must 'changed paths' "$CHANGES"`,
      `must 'unit' "$UNIT"`,
      `must 'web' "$WEB"`,
      `must 'deployment logic' "$DEPLOY_LOGIC"`,
    ]) {
      expect(run).toContain(line);
    }
    // Skippable only by a docs-only pull request.
    for (const line of [
      `heavy 'integration (every shard)' "$INTEGRATION"`,
      `heavy 'legacy mysql' "$LEGACY_MYSQL"`,
      `heavy 'legacy rehearsal' "$LEGACY_REHEARSAL"`,
      `heavy 'deployment smoke' "$DEPLOY"`,
      `heavy 'deployment update smoke' "$DEPLOY_UPDATE"`,
    ]) {
      expect(run).toContain(line);
    }
    expect(run, 'a result test was inverted').not.toContain('!= "success"');
  });

  /** Runs the aggregate's script with these results, and returns its exit status. */
  function aggregate(results: Record<string, string>): number {
    const job = workflow.jobs.test!;
    const step = job.steps.find((s) => s.name === 'Every test job succeeded')!;
    const env: Record<string, string> = { PATH: process.env.PATH ?? '' };
    for (const key of Object.keys(step.env ?? {})) env[key] = results[key] ?? 'success';
    try {
      execFileSync('bash', ['-c', step.run!], { env, stdio: 'pipe' });
      return 0;
    } catch (error) {
      return (error as { status: number }).status;
    }
  }

  it('accepts a skipped heavy job only for a docs-only pull request', () => {
    const heavy = ['INTEGRATION', 'LEGACY_MYSQL', 'LEGACY_REHEARSAL', 'DEPLOY', 'DEPLOY_UPDATE'];
    const skipped = Object.fromEntries(heavy.map((k) => [k, 'skipped']));
    expect(aggregate({ EVENT: 'push', HEAVY: 'true' })).toBe(0);
    expect(aggregate({ EVENT: 'pull_request', HEAVY: 'false', ...skipped })).toBe(0);
    // The release evidence: a push or a dispatch never accepts a skip.
    expect(aggregate({ EVENT: 'push', HEAVY: 'false', ...skipped })).not.toBe(0);
    expect(aggregate({ EVENT: 'workflow_dispatch', HEAVY: 'false', ...skipped })).not.toBe(0);
    // A pull request that is not docs-only, or whose decision failed, neither.
    expect(aggregate({ EVENT: 'pull_request', HEAVY: 'true', ...skipped })).not.toBe(0);
    expect(aggregate({ EVENT: 'pull_request', HEAVY: '', ...skipped })).not.toBe(0);
    expect(
      aggregate({ EVENT: 'pull_request', HEAVY: 'false', CHANGES: 'failure', ...skipped }),
    ).not.toBe(0);
    for (const key of heavy) {
      // Each heavy job, failed or cancelled, is red even on a docs-only PR.
      for (const result of ['failure', 'cancelled']) {
        expect(aggregate({ EVENT: 'pull_request', HEAVY: 'false', [key]: result }), key).not.toBe(
          0,
        );
      }
      expect(aggregate({ EVENT: 'push', HEAVY: 'true', [key]: 'skipped' }), key).not.toBe(0);
    }
    for (const key of ['CHANGES', 'UNIT', 'WEB', 'DEPLOY_LOGIC']) {
      expect(
        aggregate({ EVENT: 'pull_request', HEAVY: 'false', ...skipped, [key]: 'skipped' }),
        `${key} is never skippable`,
      ).not.toBe(0);
    }
  });

  it('lets a docs-only change skip only the jobs that read no documentation', () => {
    const gated = Object.entries(workflow.jobs)
      .filter(([, job]) => job.if?.includes('needs.changes.outputs.heavy'))
      .map(([name]) => name)
      .sort();
    expect(gated).toEqual([
      'deploy',
      'deploy-update',
      'integration',
      'legacy-mysql',
      'legacy-rehearsal',
    ]);
    for (const name of gated) {
      expect(workflow.jobs[name]!.if).toBe("needs.changes.outputs.heavy == 'true'");
      expect([workflow.jobs[name]!.needs].flat()).toContain('changes');
    }
    const changes = workflow.jobs.changes!;
    expect(changes.outputs?.heavy).toBe('${{ steps.decide.outputs.heavy }}');
    expect(changes.steps.some((s) => s.run?.startsWith('bash scripts/ci-docs-only.sh'))).toBe(true);
  });

  it('decides docs-only from the paths, and only for a pull request', () => {
    const decide = (event: string, paths: string) =>
      execFileSync('bash', ['scripts/ci-docs-only.sh', event, '--stdin'], {
        cwd: join(__dirname, '../..'),
        input: paths,
      })
        .toString()
        .trim();
    expect(decide('pull_request', 'docs/ci.md\ndocs/adr/0001-x.md\nREADME.md\n')).toBe(
      'heavy=false',
    );
    expect(decide('pull_request', 'CLAUDE.md\nPROGRESS.md\n')).toBe('heavy=false');
    // The release evidence always runs everything.
    expect(decide('push', 'docs/ci.md\n')).toBe('heavy=true');
    expect(decide('workflow_dispatch', 'docs/ci.md\n')).toBe('heavy=true');
    // Not Markdown, not under docs/, shipped in the image, or nothing read.
    for (const paths of [
      'docs/legacy-migration/final-report.schema.json\n',
      'docs/ci.md\napps/api/src/main.ts\n',
      'deploy/rehearsal/README.md\n',
      'apps/web/README.md\n',
      'docs\n',
      '',
    ]) {
      expect(decide('pull_request', paths), JSON.stringify(paths)).toBe('heavy=true');
    }
  });

  it('reads the paths from a two-parent merge commit, and from nothing else', () => {
    const script = join(__dirname, '../../scripts/ci-docs-only.sh');
    const dir = mkdtempSync(join(tmpdir(), 'ci-docs-only-'));
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=ci', '-c', 'user.email=ci@example.invalid', ...args], {
        cwd: dir,
        stdio: 'pipe',
      });
    const decide = () =>
      execFileSync('bash', [script, 'pull_request'], { cwd: dir }).toString().trim();
    try {
      git('init', '-q', '-b', 'main');
      git('commit', '-q', '--allow-empty', '-m', 'base');
      git('checkout', '-q', '-b', 'docs');
      mkdirSync(join(dir, 'docs'));
      writeFileSync(join(dir, 'docs/a.md'), 'x\n');
      git('add', '.');
      git('commit', '-q', '-m', 'docs');
      // Not a merge: HEAD^1 is the PR's own previous commit, not its base.
      expect(decide()).toBe('heavy=true');
      git('checkout', '-q', 'main');
      git('merge', '-q', '--no-ff', 'docs', '-m', 'merge');
      expect(decide()).toBe('heavy=false');
      // A pull request that changes code is heavy.
      git('checkout', '-q', '-b', 'code', 'main~1');
      writeFileSync(join(dir, 'main.ts'), 'x\n');
      git('add', '.');
      git('commit', '-q', '-m', 'code');
      git('checkout', '-q', 'main~1');
      git('checkout', '-q', '-b', 'base2');
      git('merge', '-q', '--no-ff', 'code', '-m', 'merge');
      expect(decide()).toBe('heavy=true');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps every Markdown file out of what the skippable jobs read', () => {
    // The docs-only skip is sound only while no skipped job reads a file it
    // matches. Unit, web, static and deployment logic DO read docs/*.md, and
    // are never skipped. This scans the code the skipped jobs run for a read
    // of one, on one line: a file API or a shell reader beside a docs path.
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

  it('runs the legacy MySQL source suite against a real MariaDB AND MySQL 8.0 on every run', () => {
    const job = workflow.jobs['legacy-mysql']!;
    expect(job, 'the legacy-mysql job is gone').toBeDefined();
    expect(Object.keys(job.services ?? {})).toEqual(['legacydb']);
    const service = (job.services ?? {})['legacydb'] as { image?: string };
    expect(service.image).toBe('${{ matrix.engine.image }}');
    // WP-D1b (OQ-P7-03): both engines, collations never rewritten.
    const matrix = (job as unknown as { strategy?: { matrix?: { engine?: { image: string }[] } } })
      .strategy?.matrix?.engine;
    expect((matrix ?? []).map((e) => e.image)).toEqual(['mariadb:10.11', 'mysql:8.0']);
    expect(job.steps.some((s) => s.run === 'pnpm test:legacy-mysql')).toBe(true);
    // The suite FAILS without its DSN; the job must supply one.
    const env = (job as unknown as { env?: Record<string, string> }).env ?? {};
    expect(env['NEXA_LEGACY_MYSQL_ADMIN_DSN']).toMatch(/^mysql:\/\//u);
    expect(job['timeout-minutes']).toBeGreaterThan(0);
  });

  it('pins the image of every job that downloads release-specific Ubuntu packages', () => {
    for (const [name, job] of Object.entries(workflow.jobs)) {
      const downloads = job.steps.some((s) => /apt-get download/u.test(s.run ?? ''));
      if (downloads) {
        expect((job as unknown as { 'runs-on'?: string })['runs-on'], name).toBe('ubuntu-24.04');
      }
    }
    expect(
      workflow.jobs['legacy-rehearsal']!.steps.some((s) => /apt-get download/u.test(s.run ?? '')),
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
});
